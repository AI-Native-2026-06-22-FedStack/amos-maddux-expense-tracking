import {
  DeleteMessageCommand,
  GetQueueAttributesCommand,
  GetQueueUrlCommand,
  QueueAttributeName,
  ReceiveMessageCommand,
  SendMessageCommand,
  SQSClient,
  type Message,
  type SQSClientConfig
} from "@aws-sdk/client-sqs";
import { Redis } from "ioredis";

import { getApiRuntimeConfig } from "../config/runtime-config.js";
import { createIdempotencyLockKey, createIdempotencyReplayKey } from "../store/idempotency.js";
import {
  expenseReportStageTransitionedEventSchema,
  type ExpenseReportStageTransitionedEvent
} from "./expense-report-stage-transitioned.event.js";

export const stageTransitionEventDedupeTtlSeconds = 7 * 24 * 60 * 60;
export const stageTransitionEventLockTtlMs = 30_000;

const releaseLockScript = `
if redis.call("GET", KEYS[1]) == ARGV[1] then
  return redis.call("DEL", KEYS[1])
end
return 0
`;
const claimIdempotencyScript = `
if redis.call("GET", KEYS[1]) then
  return "processed"
end
if redis.call("SET", KEYS[2], ARGV[1], "PX", ARGV[2], "NX") then
  return "claimed"
end
return "locked"
`;

export interface StageTransitionConsumerRedisClient {
  connect?(): Promise<unknown>;
  quit?(): Promise<unknown>;
  get(key: string): Promise<string | null>;
  set(key: string, value: string): Promise<unknown>;
  set(key: string, value: string, mode: "EX", ttlSeconds: number): Promise<unknown>;
  set(key: string, value: string, mode: "PX", ttlMs: number, condition: "NX"): Promise<"OK" | null>;
  eval(script: string, numberOfKeys: number, ...args: string[]): Promise<unknown>;
}

export interface StageTransitionConsumerSqsClient {
  send(command: GetQueueUrlCommand): Promise<{ QueueUrl?: string }>;
  send(command: GetQueueAttributesCommand): Promise<{ Attributes?: Record<string, string> }>;
  send(command: ReceiveMessageCommand): Promise<{ Messages?: Message[] }>;
  send(command: DeleteMessageCommand | SendMessageCommand): Promise<unknown>;
}

export interface StageTransitionProjection {
  eventId: string;
  tenantId: string;
  expenseReportId: string;
  previousStage: ExpenseReportStageTransitionedEvent["data"]["fromStage"];
  currentStage: ExpenseReportStageTransitionedEvent["data"]["toStage"];
  correlationId: string;
  transitionedAt: string | null;
  projectedAt: string;
}

export interface HandleStageTransitionMessageDependencies {
  redis: StageTransitionConsumerRedisClient;
  now?: () => Date;
  createLockValue?: () => string;
}

export interface PollStageTransitionQueueDependencies extends HandleStageTransitionMessageDependencies {
  sqs: StageTransitionConsumerSqsClient;
  queueUrl: string;
  waitTimeSeconds?: number;
  maxNumberOfMessages?: number;
}

export interface RunStageTransitionConsumerDependencies extends HandleStageTransitionMessageDependencies {
  sqs: StageTransitionConsumerSqsClient;
  queueUrl: string;
  dlqUrl?: string;
  alert?: (message: string) => void;
  signal?: AbortSignal;
}

export interface AlertStageTransitionDlqDependencies {
  sqs: StageTransitionConsumerSqsClient;
  dlqUrl: string;
  alert?: (message: string) => void;
}

export interface RedriveStageTransitionDlqDependencies {
  sqs: StageTransitionConsumerSqsClient;
  sourceQueueUrl: string;
  dlqUrl: string;
  maxMessages?: number;
}

export async function handleStageTransitionMessage(
  message: Pick<Message, "Body">,
  dependencies: HandleStageTransitionMessageDependencies
): Promise<void> {
  const event = expenseReportStageTransitionedEventSchema.parse(JSON.parse(message.Body ?? "{}"));
  const processedKey = createStageTransitionEventProcessedKey(event);

  const lockKey = createStageTransitionEventLockKey(event);
  const lockValue = dependencies.createLockValue?.() ?? event.id;
  const claim = await dependencies.redis.eval(
    claimIdempotencyScript,
    2,
    processedKey,
    lockKey,
    lockValue,
    String(stageTransitionEventLockTtlMs)
  );

  if (claim === "processed") {
    return;
  }

  if (claim !== "claimed") {
    throw new Error(`Stage transition event ${event.id} is already being handled.`);
  }

  try {
    const now = dependencies.now ?? (() => new Date());

    await projectStageTransitionEvent(dependencies.redis, event, now);
    await dependencies.redis.set(
      processedKey,
      JSON.stringify({ projectedAt: now().toISOString() }),
      "EX",
      stageTransitionEventDedupeTtlSeconds
    );
  } finally {
    await dependencies.redis.eval(releaseLockScript, 1, lockKey, lockValue);
  }
}

export async function pollStageTransitionQueue(
  dependencies: PollStageTransitionQueueDependencies
): Promise<void> {
  const response = await dependencies.sqs.send(
    new ReceiveMessageCommand({
      QueueUrl: dependencies.queueUrl,
      MaxNumberOfMessages: dependencies.maxNumberOfMessages ?? 10,
      WaitTimeSeconds: dependencies.waitTimeSeconds ?? 20
    })
  );

  for (const message of response.Messages ?? []) {
    await handleStageTransitionMessage(message, dependencies);

    if (message.ReceiptHandle === undefined) {
      throw new Error("Handled SQS stage-transition message did not include a receipt handle.");
    }

    await dependencies.sqs.send(
      new DeleteMessageCommand({
        QueueUrl: dependencies.queueUrl,
        ReceiptHandle: message.ReceiptHandle
      })
    );
  }
}

// Plain long-lived worker for now; packaging as Lambda, ECS, or another runtime is out of scope.
export async function runStageTransitionConsumer(
  dependencies: RunStageTransitionConsumerDependencies
): Promise<void> {
  while (dependencies.signal?.aborted !== true) {
    if (dependencies.dlqUrl !== undefined) {
      await alertOnStageTransitionDlqDepth({
        sqs: dependencies.sqs,
        dlqUrl: dependencies.dlqUrl,
        alert: dependencies.alert
      });
    }

    await pollStageTransitionQueue(dependencies);
  }
}

export async function alertOnStageTransitionDlqDepth(
  dependencies: AlertStageTransitionDlqDependencies
): Promise<number> {
  const response = await dependencies.sqs.send(
    new GetQueueAttributesCommand({
      QueueUrl: dependencies.dlqUrl,
      AttributeNames: [QueueAttributeName.ApproximateNumberOfMessages]
    })
  );
  const depth = Number(response.Attributes?.[QueueAttributeName.ApproximateNumberOfMessages] ?? 0);

  if (depth > 0) {
    const message = `[alert] stage-transition DLQ depth is ${depth}`;
    (dependencies.alert ?? console.error)(message);
  }

  return depth;
}

export async function redriveStageTransitionDlq(
  dependencies: RedriveStageTransitionDlqDependencies
): Promise<number> {
  const response = await dependencies.sqs.send(
    new ReceiveMessageCommand({
      QueueUrl: dependencies.dlqUrl,
      MaxNumberOfMessages: Math.min(dependencies.maxMessages ?? 10, 10),
      WaitTimeSeconds: 1
    })
  );
  let moved = 0;

  for (const message of response.Messages ?? []) {
    if (message.Body === undefined || message.ReceiptHandle === undefined) {
      continue;
    }

    await dependencies.sqs.send(
      new SendMessageCommand({
        QueueUrl: dependencies.sourceQueueUrl,
        MessageBody: message.Body,
        MessageAttributes: message.MessageAttributes
      })
    );
    await dependencies.sqs.send(
      new DeleteMessageCommand({
        QueueUrl: dependencies.dlqUrl,
        ReceiptHandle: message.ReceiptHandle
      })
    );
    moved += 1;
  }

  return moved;
}

export async function createStageTransitionConsumerDependencies(): Promise<
  Omit<RunStageTransitionConsumerDependencies, "signal">
> {
  const config = getApiRuntimeConfig();
  const sqs = new SQSClient({
    region: config.AWS_REGION,
    endpoint: config.AWS_ENDPOINT,
    credentials: {
      accessKeyId: "local",
      secretAccessKey: "local"
    }
  } satisfies SQSClientConfig);
  const queueUrl = await resolveStageTransitionQueueUrl(sqs, config.SQS_STAGE_EVENTS_QUEUE);
  const dlqUrl = await resolveStageTransitionQueueUrl(sqs, config.SQS_STAGE_EVENTS_DLQ);
  const redis = new Redis(config.REDIS_URL, {
    lazyConnect: true
  });

  await redis.connect();

  return { sqs, queueUrl, dlqUrl, redis };
}

export async function resolveStageTransitionQueueUrl(
  sqs: Pick<StageTransitionConsumerSqsClient, "send">,
  queueName: string
): Promise<string> {
  const response = await sqs.send(
    new GetQueueUrlCommand({
      QueueName: queueName
    })
  );

  if (typeof response.QueueUrl !== "string") {
    throw new Error(`SQS queue ${queueName} did not return a URL.`);
  }

  return response.QueueUrl;
}

export function createStageTransitionEventProcessedKey(
  event: Pick<ExpenseReportStageTransitionedEvent, "id" | "data">
): string {
  return createIdempotencyReplayKey(event.data.tenantId, event.id);
}

export function createStageTransitionEventLockKey(
  event: Pick<ExpenseReportStageTransitionedEvent, "id" | "data">
): string {
  return createIdempotencyLockKey(event.data.tenantId, event.id);
}

export function createStageTransitionProjectionKey(
  tenantId: string,
  expenseReportId: string
): string {
  return `projection:expense-report-stage:${tenantId}:${expenseReportId}`;
}

async function projectStageTransitionEvent(
  redis: Pick<StageTransitionConsumerRedisClient, "set">,
  event: ExpenseReportStageTransitionedEvent,
  now: () => Date
): Promise<void> {
  const projection: StageTransitionProjection = {
    eventId: event.id,
    tenantId: event.data.tenantId,
    expenseReportId: event.data.expenseReportId,
    previousStage: event.data.fromStage,
    currentStage: event.data.toStage,
    correlationId: event.data.correlationId,
    transitionedAt: event.time ?? null,
    projectedAt: now().toISOString()
  };

  await redis.set(
    createStageTransitionProjectionKey(event.data.tenantId, event.data.expenseReportId),
    JSON.stringify(projection)
  );
}
