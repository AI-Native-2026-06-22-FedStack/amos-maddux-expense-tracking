import {
  DeleteMessageCommand,
  GetQueueUrlCommand,
  ReceiveMessageCommand,
  type Message
} from "@aws-sdk/client-sqs";
import { describe, expect, it } from "vitest";

import {
  buildExpenseReportStageTransitionedEvent,
  type ExpenseReportStageTransitionedEvent
} from "./expense-report-stage-transitioned.event.js";
import {
  createStageTransitionEventProcessedKey,
  createStageTransitionProjectionKey,
  handleStageTransitionMessage,
  pollStageTransitionQueue,
  stageTransitionEventDedupeTtlSeconds,
  stageTransitionEventLockTtlMs,
  type StageTransitionConsumerRedisClient
} from "./stage-transition-consumer.js";

const tenantId = "00000000-0000-4000-8000-000000000801";
const expenseReportId = "00000000-0000-4000-8000-000000000802";
const eventId = "00000000-0000-4000-8000-000000000803";
const correlationId = "synthetic-consumer-correlation-id";
const projectedAt = new Date("2026-01-01T00:00:01.000Z");
const queueUrl = "https://sqs.localhost.localstack.cloud/000000000000/expenseflow-stage-projection";

describe("handleStageTransitionMessage", () => {
  it("validates and projects a stage-transitioned event with event-id dedupe", async () => {
    const redis = new FakeRedis();
    const event = makeEvent();

    await handleStageTransitionMessage(makeMessage(event), {
      redis,
      now: () => projectedAt,
      createLockValue: () => "synthetic-lock-value"
    });

    expect(
      JSON.parse(
        (await redis.get(createStageTransitionProjectionKey(tenantId, expenseReportId))) ?? "{}"
      )
    ).toEqual({
      eventId,
      tenantId,
      expenseReportId,
      previousStage: "Submitted",
      currentStage: "Manager Approval",
      correlationId,
      transitionedAt: "2026-01-01T00:00:00.000Z",
      projectedAt: projectedAt.toISOString()
    });
    expect(redis.setCalls).toContainEqual({
      key: createStageTransitionEventProcessedKey(eventId),
      mode: "EX",
      ttl: stageTransitionEventDedupeTtlSeconds,
      condition: undefined
    });
    expect(redis.setCalls).toContainEqual({
      key: `lock:stage-transition-event:${eventId}`,
      mode: "PX",
      ttl: stageTransitionEventLockTtlMs,
      condition: "NX"
    });
  });

  it("dedupes duplicate deliveries by event id without double-projecting", async () => {
    const redis = new FakeRedis();
    const event = makeEvent();
    const message = makeMessage(event);

    await handleStageTransitionMessage(message, { redis, now: () => projectedAt });
    await handleStageTransitionMessage(message, { redis, now: () => projectedAt });

    expect(redis.projectionWrites).toBe(1);
  });

  it("does not record dedupe when projection fails", async () => {
    const redis = new FakeRedis();
    redis.failProjectionWrites = true;

    await expect(
      handleStageTransitionMessage(makeMessage(makeEvent()), {
        redis,
        now: () => projectedAt
      })
    ).rejects.toThrow("Synthetic projection failure.");

    expect(await redis.get(createStageTransitionEventProcessedKey(eventId))).toBeNull();
  });
});

describe("pollStageTransitionQueue", () => {
  it("long-polls SQS and deletes a message only after successful handling", async () => {
    const redis = new FakeRedis();
    const event = makeEvent();
    const sqs = new FakeSqs([makeMessage(event, "synthetic-receipt-handle")]);

    await pollStageTransitionQueue({
      sqs,
      redis,
      queueUrl,
      waitTimeSeconds: 20,
      now: () => projectedAt
    });

    expect(sqs.receiveCommands[0]?.input).toMatchObject({
      QueueUrl: queueUrl,
      WaitTimeSeconds: 20
    });
    expect(sqs.deleteCommands).toHaveLength(1);
    expect(sqs.deleteCommands[0]?.input).toMatchObject({
      QueueUrl: queueUrl,
      ReceiptHandle: "synthetic-receipt-handle"
    });
  });

  it("does not delete an invalid message so SQS can redeliver or redrive it", async () => {
    const redis = new FakeRedis();
    const sqs = new FakeSqs([
      {
        Body: JSON.stringify({
          id: eventId,
          source: "/expenseflow/apps/api/expense-reports",
          specversion: "1.0",
          type: "com.expenseflow.expense-report.stage-transitioned.v1"
        }),
        ReceiptHandle: "synthetic-invalid-receipt"
      }
    ]);

    await expect(
      pollStageTransitionQueue({
        sqs,
        redis,
        queueUrl,
        waitTimeSeconds: 20
      })
    ).rejects.toThrow();

    expect(sqs.deleteCommands).toEqual([]);
  });
});

function makeEvent(): ExpenseReportStageTransitionedEvent {
  return buildExpenseReportStageTransitionedEvent({
    id: eventId,
    time: "2026-01-01T00:00:00.000Z",
    tenantId,
    expenseReportId,
    fromStage: "Submitted",
    toStage: "Manager Approval",
    correlationId
  });
}

function makeMessage(
  event: ExpenseReportStageTransitionedEvent,
  receiptHandle = "synthetic-receipt-handle"
): Message {
  return {
    Body: JSON.stringify(event),
    ReceiptHandle: receiptHandle
  };
}

interface RedisEntry {
  value: string;
  expiresAtMs: number | null;
}

interface RedisSetCall {
  key: string;
  mode: "EX" | "PX" | "SET";
  ttl?: number;
  condition?: "NX";
}

class FakeRedis implements StageTransitionConsumerRedisClient {
  public readonly setCalls: RedisSetCall[] = [];
  public readonly evalCalls: string[][] = [];
  public projectionWrites = 0;
  public failProjectionWrites = false;
  private readonly entries = new Map<string, RedisEntry>();

  public async get(key: string): Promise<string | null> {
    return this.entries.get(key)?.value ?? null;
  }

  public set(key: string, value: string): Promise<unknown>;
  public set(key: string, value: string, mode: "EX", ttlSeconds: number): Promise<unknown>;
  public set(
    key: string,
    value: string,
    mode: "PX",
    ttlMs: number,
    condition: "NX"
  ): Promise<"OK" | null>;
  public async set(
    key: string,
    value: string,
    mode?: "EX" | "PX",
    ttl?: number,
    condition?: "NX"
  ): Promise<"OK" | null> {
    if (condition === "NX" && this.entries.has(key)) {
      return null;
    }

    if (key.startsWith("projection:")) {
      if (this.failProjectionWrites) {
        throw new Error("Synthetic projection failure.");
      }

      this.projectionWrites += 1;
    }

    this.setCalls.push({ key, mode: mode ?? "SET", ttl, condition });
    this.entries.set(key, {
      value,
      expiresAtMs: null
    });

    return "OK";
  }

  public async eval(
    _script: string,
    _numberOfKeys: number,
    key: string,
    lockValue: string
  ): Promise<number> {
    this.evalCalls.push([key, lockValue]);

    if ((await this.get(key)) !== lockValue) {
      return 0;
    }

    return this.entries.delete(key) ? 1 : 0;
  }
}

class FakeSqs {
  public readonly receiveCommands: ReceiveMessageCommand[] = [];
  public readonly deleteCommands: DeleteMessageCommand[] = [];

  public constructor(private readonly messages: Message[]) {}

  public async send(command: GetQueueUrlCommand): Promise<{ QueueUrl?: string }>;
  public async send(command: ReceiveMessageCommand): Promise<{ Messages?: Message[] }>;
  public async send(command: DeleteMessageCommand): Promise<unknown>;
  public async send(
    command: GetQueueUrlCommand | ReceiveMessageCommand | DeleteMessageCommand
  ): Promise<unknown> {
    if (command instanceof GetQueueUrlCommand) {
      return { QueueUrl: queueUrl };
    }

    if (command instanceof ReceiveMessageCommand) {
      this.receiveCommands.push(command);
      return { Messages: this.messages.splice(0, 1) };
    }

    this.deleteCommands.push(command);
    return {};
  }
}
