import {
  DeleteMessageCommand,
  GetQueueAttributesCommand,
  GetQueueUrlCommand,
  QueueAttributeName,
  ReceiveMessageCommand,
  SendMessageCommand,
  type Message
} from "@aws-sdk/client-sqs";
import { describe, expect, it } from "vitest";

import {
  buildExpenseReportStageTransitionedEvent,
  type ExpenseReportStageTransitionedEvent
} from "./expense-report-stage-transitioned.event.js";
import {
  alertOnStageTransitionDlqDepth,
  createStageTransitionEventProcessedKey,
  createStageTransitionProjectionKey,
  handleStageTransitionMessage,
  pollStageTransitionQueue,
  redriveStageTransitionDlq,
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
const dlqUrl =
  "https://sqs.localhost.localstack.cloud/000000000000/expenseflow-stage-projection-dlq";

describe("handleStageTransitionMessage", () => {
  it("validates and projects a stage-transitioned event with atomic idempotency claim", async () => {
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
      key: createStageTransitionEventProcessedKey(event),
      mode: "EX",
      ttl: stageTransitionEventDedupeTtlSeconds,
      condition: undefined
    });
    expect(redis.evalCalls[0]).toEqual([
      createStageTransitionEventProcessedKey(event),
      `lock:${tenantId}:${eventId}`,
      "synthetic-lock-value",
      String(stageTransitionEventLockTtlMs)
    ]);
  });

  it("dedupes duplicate deliveries by event id without double-projecting", async () => {
    const redis = new FakeRedis();
    const event = makeEvent();
    const message = makeMessage(event);

    await handleStageTransitionMessage(message, { redis, now: () => projectedAt });
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

    expect(await redis.get(createStageTransitionEventProcessedKey(makeEvent()))).toBeNull();
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
      MessageAttributeNames: ["All"],
      WaitTimeSeconds: 20
    });
    expect(sqs.deleteCommands).toHaveLength(1);
    expect(sqs.deleteCommands[0]?.input).toMatchObject({
      QueueUrl: queueUrl,
      ReceiptHandle: "synthetic-receipt-handle"
    });
  });

  it("does not delete an invalid message and continues polling without crashing", async () => {
    const redis = new FakeRedis();
    const alerts: string[] = [];
    const validEvent = makeEvent({ id: "00000000-0000-4000-8000-000000000804" });
    const sqs = new FakeSqs([
      {
        Body: JSON.stringify({
          id: eventId,
          source: "/expenseflow/apps/api/expense-reports",
          specversion: "1.0",
          type: "com.expenseflow.expense-report.stage-transitioned.v1"
        }),
        ReceiptHandle: "synthetic-invalid-receipt"
      },
      makeMessage(validEvent, "synthetic-valid-receipt")
    ]);

    await pollStageTransitionQueue({
      sqs,
      redis,
      queueUrl,
      waitTimeSeconds: 20,
      alert: (message) => alerts.push(message)
    });

    expect(alerts).toHaveLength(1);
    expect(sqs.deleteCommands).toHaveLength(1);
    expect(sqs.deleteCommands[0]?.input).toMatchObject({
      QueueUrl: queueUrl,
      ReceiptHandle: "synthetic-valid-receipt"
    });
  });

  it("does not let an older event overwrite a newer report projection", async () => {
    const redis = new FakeRedis();
    const newerEvent = makeEvent({
      id: "00000000-0000-4000-8000-000000000805",
      time: "2026-01-01T00:00:02.000Z",
      fromStage: "AP Review",
      toStage: "Paid"
    });
    const olderEvent = makeEvent({
      id: "00000000-0000-4000-8000-000000000806",
      time: "2026-01-01T00:00:00.000Z",
      fromStage: "Submitted",
      toStage: "Manager Approval"
    });

    await handleStageTransitionMessage(makeMessage(newerEvent), { redis, now: () => projectedAt });
    await handleStageTransitionMessage(makeMessage(olderEvent), { redis, now: () => projectedAt });

    expect(
      JSON.parse(
        (await redis.get(createStageTransitionProjectionKey(tenantId, expenseReportId))) ?? "{}"
      )
    ).toMatchObject({
      eventId: newerEvent.id,
      previousStage: "AP Review",
      currentStage: "Paid",
      transitionedAt: "2026-01-01T00:00:02.000Z"
    });
    expect(redis.projectionWrites).toBe(1);
  });
});

describe("stage-transition DLQ operations", () => {
  it("alerts when the DLQ depth is above zero", async () => {
    const sqs = new FakeSqs([], {
      [dlqUrl]: 2
    });
    const alerts: string[] = [];

    await expect(
      alertOnStageTransitionDlqDepth({
        sqs,
        dlqUrl,
        alert: (message) => alerts.push(message)
      })
    ).resolves.toBe(2);

    expect(sqs.attributeCommands[0]?.input).toMatchObject({
      QueueUrl: dlqUrl,
      AttributeNames: [QueueAttributeName.ApproximateNumberOfMessages]
    });
    expect(alerts).toEqual(["[alert] stage-transition DLQ depth is 2"]);
  });

  it("redrives DLQ messages back to the source queue after a fix", async () => {
    const poisonMessage = {
      Body: JSON.stringify({ synthetic: "poison" }),
      ReceiptHandle: "synthetic-dlq-receipt",
      MessageAttributes: {
        syntheticAttribute: {
          DataType: "String",
          StringValue: "synthetic-value"
        }
      }
    };
    const sqs = new FakeSqs([poisonMessage]);

    await expect(
      redriveStageTransitionDlq({
        sqs,
        sourceQueueUrl: queueUrl,
        dlqUrl
      })
    ).resolves.toBe(1);

    expect(sqs.sendCommands[0]?.input).toMatchObject({
      QueueUrl: queueUrl,
      MessageBody: poisonMessage.Body,
      MessageAttributes: poisonMessage.MessageAttributes
    });
    expect(sqs.receiveCommands[0]?.input).toMatchObject({
      QueueUrl: dlqUrl,
      MessageAttributeNames: ["All"]
    });
    expect(sqs.deleteCommands[0]?.input).toMatchObject({
      QueueUrl: dlqUrl,
      ReceiptHandle: "synthetic-dlq-receipt"
    });
  });
});

function makeEvent(
  overrides: Partial<{
    id: string;
    time: string;
    fromStage: ExpenseReportStageTransitionedEvent["data"]["fromStage"];
    toStage: ExpenseReportStageTransitionedEvent["data"]["toStage"];
  }> = {}
): ExpenseReportStageTransitionedEvent {
  return buildExpenseReportStageTransitionedEvent({
    id: overrides.id ?? eventId,
    time: overrides.time ?? "2026-01-01T00:00:00.000Z",
    tenantId,
    expenseReportId,
    fromStage: overrides.fromStage ?? "Submitted",
    toStage: overrides.toStage ?? "Manager Approval",
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
    numberOfKeys: number,
    ...args: string[]
  ): Promise<number | string> {
    if (numberOfKeys === 2) {
      const [processedKey, lockKey, lockValue, lockTtlMs] = args;
      this.evalCalls.push([processedKey, lockKey, lockValue, lockTtlMs]);

      if (this.entries.has(processedKey)) {
        return "processed";
      }

      if (this.entries.has(lockKey)) {
        return "locked";
      }

      this.entries.set(lockKey, {
        value: lockValue,
        expiresAtMs: null
      });
      return "claimed";
    }

    if (args.length === 3) {
      const [key, value, transitionedAt] = args;
      const existing = this.entries.get(key)?.value;

      if (this.failProjectionWrites) {
        throw new Error("Synthetic projection failure.");
      }

      if (existing !== undefined) {
        const existingProjection = JSON.parse(existing) as { transitionedAt?: string | null };

        if (
          existingProjection.transitionedAt !== null &&
          existingProjection.transitionedAt !== undefined &&
          transitionedAt !== "" &&
          existingProjection.transitionedAt > transitionedAt
        ) {
          return "stale";
        }
      }

      this.projectionWrites += 1;
      this.entries.set(key, {
        value,
        expiresAtMs: null
      });
      return "projected";
    }

    const [key, lockValue] = args;
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
  public readonly attributeCommands: GetQueueAttributesCommand[] = [];
  public readonly sendCommands: SendMessageCommand[] = [];

  public constructor(
    private readonly messages: Message[],
    private readonly approximateDepthByQueueUrl: Record<string, number> = {}
  ) {}

  public async send(command: GetQueueUrlCommand): Promise<{ QueueUrl?: string }>;
  public async send(
    command: GetQueueAttributesCommand
  ): Promise<{ Attributes?: Record<string, string> }>;
  public async send(command: ReceiveMessageCommand): Promise<{ Messages?: Message[] }>;
  public async send(command: DeleteMessageCommand | SendMessageCommand): Promise<unknown>;
  public async send(
    command:
      | GetQueueUrlCommand
      | GetQueueAttributesCommand
      | ReceiveMessageCommand
      | DeleteMessageCommand
      | SendMessageCommand
  ): Promise<unknown> {
    if (command instanceof GetQueueUrlCommand) {
      return { QueueUrl: queueUrl };
    }

    if (command instanceof GetQueueAttributesCommand) {
      this.attributeCommands.push(command);
      const queueUrl = command.input.QueueUrl ?? "";

      return {
        Attributes: {
          [QueueAttributeName.ApproximateNumberOfMessages]: String(
            this.approximateDepthByQueueUrl[queueUrl] ?? 0
          )
        }
      };
    }

    if (command instanceof ReceiveMessageCommand) {
      this.receiveCommands.push(command);
      return { Messages: this.messages.splice(0, command.input.MaxNumberOfMessages ?? 1) };
    }

    if (command instanceof SendMessageCommand) {
      this.sendCommands.push(command);
      return {};
    }

    this.deleteCommands.push(command);
    return {};
  }
}
