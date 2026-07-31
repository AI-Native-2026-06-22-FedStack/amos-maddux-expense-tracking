import { sql } from "drizzle-orm";
import type { NodePgDatabase } from "drizzle-orm/node-postgres";

import { getDb } from "../db/client.js";
import * as schema from "../db/schema.js";
import { eventOutbox } from "../db/schema.js";
import {
  EXPENSE_REPORT_STAGE_TRANSITIONED_EVENT_TYPE,
  expenseReportStageTransitionedEventSchema,
  type ExpenseReportStageTransitionedEvent
} from "./expense-report-stage-transitioned.event.js";
import {
  createLazyStageTransitionEventPublisher,
  type StageTransitionEventPublisher
} from "./stage-transition-event-publisher.js";

type OutboxDatabase = NodePgDatabase<typeof schema>;

export const OUTBOX_RELAY_DEFAULT_BATCH_SIZE = 25;
export const OUTBOX_RELAY_DEFAULT_POLL_INTERVAL_MS = 1_000;
export const OUTBOX_RELAY_STALE_LOCK_MS = 5 * 60_000;
export const OUTBOX_RELAY_BACKOFF_MS = [1_000, 2_000, 5_000, 10_000, 30_000] as const;
export const OUTBOX_RELAY_MAX_BACKOFF_MS = 60_000;
export const OUTBOX_RELAY_CLAIM_SQL_GUARD = "FOR UPDATE SKIP LOCKED";
export const OUTBOX_RELAY_MAX_ATTEMPTS = 10;

export interface OutboxRelayMessage {
  id: string;
  eventType: string;
  payload: unknown;
  attemptCount: number;
}

interface ClaimedOutboxRow {
  id: string;
  event_type: string;
  payload: unknown;
  attempt_count: number;
}

export interface OutboxRelayRepository {
  claimBatch(request: ClaimOutboxBatchRequest): Promise<OutboxRelayMessage[]>;
  markSent(request: MarkOutboxSentRequest): Promise<void>;
  markFailed(request: MarkOutboxFailedRequest): Promise<void>;
}

export interface ClaimOutboxBatchRequest {
  relayId: string;
  batchSize: number;
  staleLockedBefore: Date;
}

export interface MarkOutboxFailedRequest {
  id: string;
  relayId: string;
  errorMessage: string;
  nextAttemptAt: Date;
  deadLetter?: boolean;
}

export interface MarkOutboxSentRequest {
  id: string;
  relayId: string;
}

export interface OutboxRelayOptions {
  relayId: string;
  batchSize?: number;
  pollIntervalMs?: number;
  signal?: AbortSignal;
  repository?: OutboxRelayRepository;
  publisher?: StageTransitionEventPublisher;
  sleep?: (milliseconds: number, signal?: AbortSignal) => Promise<void>;
  now?: () => Date;
}

class DrizzleOutboxRelayRepository implements OutboxRelayRepository {
  public constructor(private readonly db: OutboxDatabase) {}

  public async claimBatch(request: ClaimOutboxBatchRequest): Promise<OutboxRelayMessage[]> {
    const result = await this.db.transaction(async (tx) =>
      tx.execute(sql<ClaimedOutboxRow>`
        with claimable as (
          select id
          from ${eventOutbox}
          where ${eventOutbox.sentAt} is null
            and ${eventOutbox.nextAttemptAt} <= now()
            and (
              ${eventOutbox.status} = 'pending'
              or (
                ${eventOutbox.status} = 'in_progress'
                and ${eventOutbox.lockedAt} < ${request.staleLockedBefore}
              )
            )
          order by ${eventOutbox.createdAt}, ${eventOutbox.id}
          limit ${request.batchSize}
          for update skip locked
        )
        update ${eventOutbox}
        set status = 'in_progress',
            locked_by = ${request.relayId},
            locked_at = now(),
            updated_at = now()
        from claimable
        where ${eventOutbox.id} = claimable.id
        returning ${eventOutbox.id},
                  ${eventOutbox.eventType},
                  ${eventOutbox.payload},
                  ${eventOutbox.attemptCount}
      `)
    );

    const rows = result.rows as unknown as ClaimedOutboxRow[];

    return rows.map((row) => ({
      id: row.id,
      eventType: row.event_type,
      payload: row.payload,
      attemptCount: row.attempt_count
    }));
  }

  public async markSent(request: MarkOutboxSentRequest): Promise<void> {
    const updatedRows = await this.db
      .update(eventOutbox)
      .set({
        status: "sent",
        sentAt: new Date(),
        lockedBy: null,
        lockedAt: null,
        lastError: null,
        updatedAt: new Date()
      })
      .where(
        sql`
        ${eventOutbox.id} = ${request.id}
        and ${eventOutbox.status} = 'in_progress'
        and ${eventOutbox.lockedBy} = ${request.relayId}
      `
      )
      .returning({ id: eventOutbox.id });

    if (updatedRows.length === 0) {
      throw new Error(`Outbox row ${request.id} is not locked by relay ${request.relayId}.`);
    }
  }

  public async markFailed(request: MarkOutboxFailedRequest): Promise<void> {
    const failedStatus = request.deadLetter === true ? "dead_lettered" : "pending";
    const nextAttemptAt = request.deadLetter === true ? new Date() : request.nextAttemptAt;
    const result = await this.db.execute(sql`
      update ${eventOutbox}
      set status = ${failedStatus},
          attempt_count = attempt_count + 1,
          next_attempt_at = ${nextAttemptAt},
          locked_by = null,
          locked_at = null,
          last_error = ${request.errorMessage},
          updated_at = now()
      where ${eventOutbox.id} = ${request.id}
        and ${eventOutbox.sentAt} is null
        and ${eventOutbox.status} = 'in_progress'
        and ${eventOutbox.lockedBy} = ${request.relayId}
    `);

    if (result.rowCount === 0) {
      throw new Error(`Outbox row ${request.id} is not locked by relay ${request.relayId}.`);
    }
  }
}

export function createOutboxRelayRepository(db: OutboxDatabase = getDb()): OutboxRelayRepository {
  return new DrizzleOutboxRelayRepository(db);
}

export async function runOutboxRelay(options: OutboxRelayOptions): Promise<void> {
  const pollIntervalMs = options.pollIntervalMs ?? OUTBOX_RELAY_DEFAULT_POLL_INTERVAL_MS;
  const sleep = options.sleep ?? sleepFor;

  while (!options.signal?.aborted) {
    await runOutboxRelayOnce(options);
    await sleep(pollIntervalMs, options.signal);
  }
}

export async function runOutboxRelayOnce(options: OutboxRelayOptions): Promise<number> {
  const repository = options.repository ?? createOutboxRelayRepository();
  const publisher = options.publisher ?? createLazyStageTransitionEventPublisher();
  const now = options.now ?? (() => new Date());
  const messages = await repository.claimBatch({
    relayId: options.relayId,
    batchSize: options.batchSize ?? OUTBOX_RELAY_DEFAULT_BATCH_SIZE,
    staleLockedBefore: new Date(now().getTime() - OUTBOX_RELAY_STALE_LOCK_MS)
  });

  for (const message of messages) {
    try {
      await publishOutboxMessage(publisher, message);
      await repository
        .markSent({ id: message.id, relayId: options.relayId })
        .catch(() => undefined);
    } catch (error) {
      const attemptCount = message.attemptCount + 1;
      await repository
        .markFailed({
          id: message.id,
          relayId: options.relayId,
          errorMessage: errorToMessage(error),
          nextAttemptAt: new Date(now().getTime() + backoffForAttempt(attemptCount)),
          deadLetter: attemptCount >= OUTBOX_RELAY_MAX_ATTEMPTS
        })
        .catch(() => undefined);
    }
  }

  return messages.length;
}

function errorToMessage(error: unknown): string {
  if (error instanceof Error) {
    return error.message.slice(0, 1_000);
  }

  return String(error).slice(0, 1_000);
}

export function backoffForAttempt(attemptCount: number): number {
  return (
    OUTBOX_RELAY_BACKOFF_MS[attemptCount - 1] ??
    Math.min(OUTBOX_RELAY_MAX_BACKOFF_MS, OUTBOX_RELAY_BACKOFF_MS.at(-1) ?? 1_000)
  );
}

async function publishOutboxMessage(
  publisher: StageTransitionEventPublisher,
  message: OutboxRelayMessage
): Promise<void> {
  if (message.eventType !== EXPENSE_REPORT_STAGE_TRANSITIONED_EVENT_TYPE) {
    throw new Error(`Unsupported outbox event type: ${message.eventType}.`);
  }

  const event: ExpenseReportStageTransitionedEvent =
    expenseReportStageTransitionedEventSchema.parse(message.payload);

  await publisher.publish(event);
}

async function sleepFor(milliseconds: number, signal?: AbortSignal): Promise<void> {
  if (signal?.aborted) {
    return;
  }

  await new Promise<void>((resolve) => {
    const timeout = setTimeout(resolve, milliseconds);

    signal?.addEventListener(
      "abort",
      () => {
        clearTimeout(timeout);
        resolve();
      },
      { once: true }
    );
  });
}
