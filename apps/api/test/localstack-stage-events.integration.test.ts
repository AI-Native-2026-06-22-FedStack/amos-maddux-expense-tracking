import { randomUUID } from "node:crypto";

import {
  CreateTopicCommand,
  DeleteTopicCommand,
  PublishCommand,
  SNSClient,
  SubscribeCommand
} from "@aws-sdk/client-sns";
import {
  CreateQueueCommand,
  DeleteMessageCommand,
  DeleteQueueCommand,
  GetQueueAttributesCommand,
  GetQueueUrlCommand,
  QueueAttributeName,
  ReceiveMessageCommand,
  SendMessageCommand,
  SetQueueAttributesCommand,
  SQSClient
} from "@aws-sdk/client-sqs";
import { describe, expect, it } from "vitest";

import {
  buildExpenseReportStageTransitionedEvent,
  expenseReportStageTransitionedEventSchema
} from "../src/events/expense-report-stage-transitioned.event.js";

const describeLocalStack = process.env.RUN_LOCALSTACK_TESTS === "1" ? describe : describe.skip;
const awsEndpoint = process.env.AWS_ENDPOINT ?? "http://localhost:4566";
const awsRegion = process.env.AWS_REGION ?? "us-east-1";
const credentials = {
  accessKeyId: "localstack",
  secretAccessKey: "localstack"
};

describeLocalStack("LocalStack stage-transition event fan-out", () => {
  it("fans out CloudEvents through SNS to SQS and redrives poison records to a DLQ", async () => {
    const suffix = randomUUID();
    const topicName = `expenseflow-test-stage-events-${suffix}`;
    const queueName = `expenseflow-test-stage-projection-${suffix}`;
    const dlqName = `expenseflow-test-stage-projection-dlq-${suffix}`;
    const sns = new SNSClient({ endpoint: awsEndpoint, region: awsRegion, credentials });
    const sqs = new SQSClient({ endpoint: awsEndpoint, region: awsRegion, credentials });
    const createdQueueUrls: string[] = [];
    let topicArn: string | undefined;

    try {
      topicArn = await createTopic(sns, topicName);
      const dlqUrl = await createQueue(sqs, dlqName);
      createdQueueUrls.push(dlqUrl);
      const dlqArn = await readQueueArn(sqs, dlqUrl);
      const queueUrl = await createQueue(sqs, queueName, {
        VisibilityTimeout: "1",
        RedrivePolicy: JSON.stringify({
          deadLetterTargetArn: dlqArn,
          maxReceiveCount: "3"
        })
      });
      createdQueueUrls.push(queueUrl);
      const queueArn = await readQueueArn(sqs, queueUrl);

      await sqs.send(
        new SetQueueAttributesCommand({
          QueueUrl: queueUrl,
          Attributes: {
            Policy: JSON.stringify(createSnsQueuePolicy(queueArn, topicArn))
          }
        })
      );
      await sns.send(
        new SubscribeCommand({
          TopicArn: topicArn,
          Protocol: "sqs",
          Endpoint: queueArn,
          Attributes: {
            RawMessageDelivery: "true"
          }
        })
      );

      const event = buildExpenseReportStageTransitionedEvent({
        id: "00000000-0000-4000-8000-000000000901",
        time: "2026-01-01T00:00:00.000Z",
        tenantId: "00000000-0000-4000-8000-000000000902",
        expenseReportId: "00000000-0000-4000-8000-000000000903",
        fromStage: "Submitted",
        toStage: "Manager Approval",
        correlationId: "synthetic-localstack-correlation-id"
      });

      await sns.send(
        new PublishCommand({
          TopicArn: topicArn,
          Message: JSON.stringify(event)
        })
      );

      const fannedOutMessage = await receiveOneMessage(sqs, queueUrl);
      const parsedEvent = expenseReportStageTransitionedEventSchema.parse(
        JSON.parse(fannedOutMessage.Body ?? "{}")
      );
      expect(parsedEvent).toMatchObject({
        id: event.id,
        data: {
          expenseReportId: event.data.expenseReportId,
          correlationId: event.data.correlationId
        }
      });
      await deleteMessage(sqs, queueUrl, fannedOutMessage.ReceiptHandle);

      await sqs.send(
        new SendMessageCommand({
          QueueUrl: queueUrl,
          MessageBody: JSON.stringify({ synthetic: "poison" })
        })
      );

      for (let attempt = 0; attempt < 3; attempt += 1) {
        await receiveOneMessage(sqs, queueUrl);

        if (attempt < 2) {
          await expectNoMessage(sqs, dlqUrl);
        }

        await sleep(1_100);
      }

      const dlqMessage = await pollForMessage(sqs, dlqUrl, 10);
      expect(JSON.parse(dlqMessage.Body ?? "{}")).toEqual({ synthetic: "poison" });

      await sqs.send(
        new SendMessageCommand({
          QueueUrl: queueUrl,
          MessageBody: JSON.stringify({ synthetic: "next-record" })
        })
      );
      const nextMessage = await receiveOneMessage(sqs, queueUrl);
      expect(JSON.parse(nextMessage.Body ?? "{}")).toEqual({ synthetic: "next-record" });
      await deleteMessage(sqs, queueUrl, nextMessage.ReceiptHandle);
    } finally {
      await Promise.all(createdQueueUrls.map((queueUrl) => deleteQueue(sqs, queueUrl)));
      if (topicArn !== undefined) {
        await deleteTopic(sns, topicArn);
      }
    }
  });
});

async function createTopic(client: SNSClient, name: string): Promise<string> {
  const response = await client.send(new CreateTopicCommand({ Name: name }));

  if (typeof response.TopicArn !== "string") {
    throw new Error(`Synthetic SNS topic ${name} did not return an ARN.`);
  }

  return response.TopicArn;
}

async function createQueue(
  client: SQSClient,
  name: string,
  attributes: Record<string, string> = {}
): Promise<string> {
  const response = await client.send(
    new CreateQueueCommand({
      QueueName: name,
      Attributes: attributes
    })
  );

  if (typeof response.QueueUrl === "string") {
    return response.QueueUrl;
  }

  const fallbackResponse = await client.send(new GetQueueUrlCommand({ QueueName: name }));

  if (typeof fallbackResponse.QueueUrl !== "string") {
    throw new Error(`Synthetic SQS queue ${name} did not return a URL.`);
  }

  return fallbackResponse.QueueUrl;
}

async function readQueueArn(client: SQSClient, queueUrl: string): Promise<string> {
  const response = await client.send(
    new GetQueueAttributesCommand({
      QueueUrl: queueUrl,
      AttributeNames: [QueueAttributeName.QueueArn]
    })
  );
  const queueArn = response.Attributes?.[QueueAttributeName.QueueArn];

  if (typeof queueArn !== "string") {
    throw new Error(`Synthetic SQS queue ${queueUrl} did not return an ARN.`);
  }

  return queueArn;
}

async function receiveOneMessage(
  client: SQSClient,
  queueUrl: string
): Promise<{ Body?: string; ReceiptHandle?: string }> {
  return pollForMessage(client, queueUrl, 5);
}

async function pollForMessage(
  client: SQSClient,
  queueUrl: string,
  attempts: number
): Promise<{ Body?: string; ReceiptHandle?: string }> {
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    const response = await client.send(
      new ReceiveMessageCommand({
        QueueUrl: queueUrl,
        MaxNumberOfMessages: 1,
        WaitTimeSeconds: 1,
        VisibilityTimeout: 1
      })
    );
    const message = response.Messages?.[0];

    if (message !== undefined) {
      return message;
    }
  }

  throw new Error(`Synthetic SQS queue ${queueUrl} did not receive a message.`);
}

async function expectNoMessage(client: SQSClient, queueUrl: string): Promise<void> {
  const response = await client.send(
    new ReceiveMessageCommand({
      QueueUrl: queueUrl,
      MaxNumberOfMessages: 1,
      WaitTimeSeconds: 1,
      VisibilityTimeout: 1
    })
  );

  expect(response.Messages ?? []).toHaveLength(0);
}

async function deleteMessage(
  client: SQSClient,
  queueUrl: string,
  receiptHandle: string | undefined
): Promise<void> {
  if (receiptHandle === undefined) {
    throw new Error("Synthetic SQS message did not include a receipt handle.");
  }

  await client.send(
    new DeleteMessageCommand({
      QueueUrl: queueUrl,
      ReceiptHandle: receiptHandle
    })
  );
}

async function deleteQueue(client: SQSClient, queueUrl: string): Promise<void> {
  await client.send(new DeleteQueueCommand({ QueueUrl: queueUrl })).catch(() => undefined);
}

async function deleteTopic(client: SNSClient, topicArn: string): Promise<void> {
  await client.send(new DeleteTopicCommand({ TopicArn: topicArn })).catch(() => undefined);
}

function createSnsQueuePolicy(queueArn: string, topicArn: string) {
  return {
    Version: "2012-10-17",
    Statement: [
      {
        Effect: "Allow",
        Principal: {
          Service: "sns.amazonaws.com"
        },
        Action: "sqs:SendMessage",
        Resource: queueArn,
        Condition: {
          ArnEquals: {
            "aws:SourceArn": topicArn
          }
        }
      }
    ]
  };
}

function sleep(milliseconds: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, milliseconds);
  });
}
