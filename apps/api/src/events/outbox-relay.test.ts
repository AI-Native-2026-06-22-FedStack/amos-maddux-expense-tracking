import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";

import { eq, isNotNull } from "drizzle-orm";
import { drizzle } from "drizzle-orm/node-postgres";
import pg from "pg";

import * as schema from "../db/schema.js";
import { eventOutbox } from "../db/schema.js";
import {
  buildExpenseReportStageTransitionedEvent,
  EXPENSE_REPORT_STAGE_TRANSITIONED_EVENT_TYPE
} from "./expense-report-stage-transitioned.event.js";
import {
  backoffForAttempt,
  createOutboxRelayRepository,
  OUTBOX_RELAY_CLAIM_SQL_GUARD,
  OUTBOX_RELAY_MAX_ATTEMPTS,
  runOutboxRelayOnce,
  type OutboxRelayRepository
} from "./outbox-relay.js";
import type { StageTransitionEventPublisher } from "./stage-transition-event-publisher.js";

const { Client } = pg;

const tenantId = "00000000-0000-4000-8000-000000000901";
const expenseReportId = "00000000-0000-4000-8000-000000000902";
const eventId = "00000000-0000-4000-8000-000000000903";
const eventTime = "2026-01-01T00:00:00.000Z";

describe("Outbox relay", () => {
  let client: pg.Client;

  beforeEach(async () => {
    client = new Client({ connectionString: getDatabaseUrl() });
    await client.connect();
  });

  afterEach(async () => {
    await client.end();
  });

  it("documents the parallel-safe claim guard", () => {
    expect(OUTBOX_RELAY_CLAIM_SQL_GUARD).toBe("FOR UPDATE SKIP LOCKED");
  });

  it("marks a row sent only after the publisher confirms", async () => {
    const event = makeEvent();
    const repository = makeRelayRepository({
      claimBatch: vi.fn(async () => [
        {
          id: "00000000-0000-4000-8000-000000000904",
          eventType: EXPENSE_REPORT_STAGE_TRANSITIONED_EVENT_TYPE,
          payload: event,
          attemptCount: 0
        }
      ])
    });
    const publishConfirmation = deferred<undefined>();
    const publisher = {
      publish: vi.fn(() => publishConfirmation.promise)
    } satisfies StageTransitionEventPublisher;
    const runPromise = runOutboxRelayOnce({
      relayId: "synthetic-relay",
      repository,
      publisher,
      now: () => new Date(eventTime)
    });

    await Promise.resolve();
    expect(publisher.publish).toHaveBeenCalledWith(event);
    expect(repository.markSent).not.toHaveBeenCalled();

    publishConfirmation.resolve(undefined);
    await runPromise;

    expect(repository.markSent).toHaveBeenCalledExactlyOnceWith({
      id: "00000000-0000-4000-8000-000000000904",
      relayId: "synthetic-relay"
    });
  });

  it("leaves failed publishes unsent and schedules retry backoff", async () => {
    const repository = makeRelayRepository({
      claimBatch: vi.fn(async () => [
        {
          id: "00000000-0000-4000-8000-000000000905",
          eventType: EXPENSE_REPORT_STAGE_TRANSITIONED_EVENT_TYPE,
          payload: makeEvent(),
          attemptCount: 1
        }
      ])
    });
    const publisher = {
      publish: vi.fn(async () => {
        throw new Error("Synthetic SNS outage.");
      })
    } satisfies StageTransitionEventPublisher;

    await runOutboxRelayOnce({
      relayId: "synthetic-relay",
      repository,
      publisher,
      now: () => new Date(eventTime)
    });

    expect(repository.markSent).not.toHaveBeenCalled();
    expect(repository.markFailed).toHaveBeenCalledExactlyOnceWith({
      id: "00000000-0000-4000-8000-000000000905",
      relayId: "synthetic-relay",
      errorMessage: "Synthetic SNS outage.",
      nextAttemptAt: new Date(new Date(eventTime).getTime() + backoffForAttempt(2)),
      deadLetter: false
    });
  });

  it("dead-letters poison outbox rows after the last retry", async () => {
    const repository = makeRelayRepository({
      claimBatch: vi.fn(async () => [
        {
          id: "00000000-0000-4000-8000-000000000906",
          eventType: "synthetic.unsupported",
          payload: makeEvent(),
          attemptCount: OUTBOX_RELAY_MAX_ATTEMPTS - 1
        }
      ])
    });

    await runOutboxRelayOnce({
      relayId: "synthetic-relay",
      repository,
      publisher: { publish: vi.fn() },
      now: () => new Date(eventTime)
    });

    expect(repository.markFailed).toHaveBeenCalledExactlyOnceWith({
      id: "00000000-0000-4000-8000-000000000906",
      relayId: "synthetic-relay",
      errorMessage: "Unsupported outbox event type: synthetic.unsupported.",
      nextAttemptAt: new Date(
        new Date(eventTime).getTime() + backoffForAttempt(OUTBOX_RELAY_MAX_ATTEMPTS)
      ),
      deadLetter: true
    });
  });

  it("lets two relay instances publish a full outbox without duplicating rows", async () => {
    const db = drizzle(client, { schema });
    const repository = createOutboxRelayRepository(db);
    const publishedIds: string[] = [];
    const publisher = {
      publish: vi.fn(async (event) => {
        publishedIds.push(event.id);
      })
    } satisfies StageTransitionEventPublisher;

    await db.insert(eventOutbox).values(
      Array.from({ length: 10 }, (_, index) => ({
        eventType: EXPENSE_REPORT_STAGE_TRANSITIONED_EVENT_TYPE,
        payload: makeEvent({
          id: `00000000-0000-4000-8000-${String(990 + index).padStart(12, "0")}`
        })
      }))
    );

    await Promise.all([
      runOutboxRelayOnce({
        relayId: "synthetic-relay-a",
        batchSize: 10,
        repository,
        publisher
      }),
      runOutboxRelayOnce({
        relayId: "synthetic-relay-b",
        batchSize: 10,
        repository,
        publisher
      })
    ]);

    expect(publishedIds).toHaveLength(10);
    expect(new Set(publishedIds).size).toBe(10);
    await expect(
      db.select().from(eventOutbox).where(isNotNull(eventOutbox.sentAt))
    ).resolves.toHaveLength(10);
  });

  it("returns a failed row to pending without setting sent_at", async () => {
    const db = drizzle(client, { schema });
    const repository = createOutboxRelayRepository(db);
    const [row] = await db
      .insert(eventOutbox)
      .values({
        eventType: EXPENSE_REPORT_STAGE_TRANSITIONED_EVENT_TYPE,
        payload: makeEvent()
      })
      .returning();

    await runOutboxRelayOnce({
      relayId: "synthetic-relay",
      repository,
      publisher: {
        publish: vi.fn(async () => {
          throw new Error("Synthetic SNS outage.");
        })
      },
      now: () => new Date(eventTime)
    });

    const [failedRow] = await db.select().from(eventOutbox).where(eq(eventOutbox.id, row.id));
    expect(failedRow).toMatchObject({
      status: "pending",
      attemptCount: 1,
      lockedBy: null,
      lockedAt: null,
      sentAt: null
    });
    expect(failedRow?.nextAttemptAt.getTime()).toBeGreaterThan(new Date(eventTime).getTime());
  });

  it("does not let a stale relay mark a row owned by another relay", async () => {
    const db = drizzle(client, { schema });
    const repository = createOutboxRelayRepository(db);
    const [row] = await db
      .insert(eventOutbox)
      .values({
        eventType: EXPENSE_REPORT_STAGE_TRANSITIONED_EVENT_TYPE,
        payload: makeEvent(),
        status: "in_progress",
        lockedBy: "synthetic-relay-b",
        lockedAt: new Date(eventTime)
      })
      .returning();

    await expect(repository.markSent({ id: row.id, relayId: "synthetic-relay-a" })).rejects.toThrow(
      "is not locked by relay"
    );
    await repository.markSent({ id: row.id, relayId: "synthetic-relay-b" });

    const [sentRow] = await db.select().from(eventOutbox).where(eq(eventOutbox.id, row.id));
    expect(sentRow).toMatchObject({
      status: "sent",
      lockedBy: null,
      lockedAt: null
    });
  });
});

function makeRelayRepository(
  overrides: Partial<OutboxRelayRepository> = {}
): OutboxRelayRepository {
  return {
    claimBatch: vi.fn(async () => []),
    markSent: vi.fn(async () => undefined),
    markFailed: vi.fn(async () => undefined),
    ...overrides
  };
}

function makeEvent(overrides: { id?: string } = {}) {
  return buildExpenseReportStageTransitionedEvent({
    id: overrides.id ?? eventId,
    time: eventTime,
    tenantId,
    expenseReportId,
    fromStage: "Submitted",
    toStage: "Manager Approval",
    correlationId: "synthetic-outbox-correlation-id"
  });
}

function deferred<T>() {
  let resolve: (value: T | PromiseLike<T>) => void = () => undefined;
  let reject: (reason?: unknown) => void = () => undefined;
  const promise = new Promise<T>((promiseResolve, promiseReject) => {
    resolve = promiseResolve;
    reject = promiseReject;
  });

  return { promise, resolve, reject };
}

function getDatabaseUrl(): string {
  if (process.env.DATABASE_URI === undefined) {
    throw new Error("DATABASE_URI is required for outbox relay tests.");
  }

  return process.env.DATABASE_URI;
}
