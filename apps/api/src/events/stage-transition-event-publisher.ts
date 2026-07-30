import {
  CreateTopicCommand,
  PublishCommand,
  SNSClient,
  type SNSClientConfig
} from "@aws-sdk/client-sns";

import { getApiRuntimeConfig } from "../config/runtime-config.js";
import {
  type ExpenseReportStageTransitionedEvent,
  expenseReportStageTransitionedEventSchema
} from "./expense-report-stage-transitioned.event.js";

export interface StageTransitionEventPublisher {
  publish(event: ExpenseReportStageTransitionedEvent): Promise<void>;
}

export interface StageTransitionSnsPublishClient {
  send(command: CreateTopicCommand): Promise<{ TopicArn?: string }>;
  send(command: PublishCommand): Promise<unknown>;
}

export class SnsStageTransitionEventPublisher implements StageTransitionEventPublisher {
  private topicArn: string | undefined;

  public constructor(
    private readonly client: StageTransitionSnsPublishClient,
    private readonly topicName: string
  ) {}

  public async publish(event: ExpenseReportStageTransitionedEvent): Promise<void> {
    const validatedEvent = expenseReportStageTransitionedEventSchema.parse(event);

    await this.client.send(
      new PublishCommand({
        TopicArn: await this.resolveTopicArn(),
        Message: JSON.stringify(validatedEvent)
      })
    );
  }

  private async resolveTopicArn(): Promise<string> {
    if (this.topicArn !== undefined) {
      return this.topicArn;
    }

    const response = await this.client.send(
      new CreateTopicCommand({
        Name: this.topicName
      })
    );

    if (typeof response.TopicArn !== "string") {
      throw new Error(`SNS topic ${this.topicName} did not return an ARN.`);
    }

    this.topicArn = response.TopicArn;

    return this.topicArn;
  }
}

export function createStageTransitionEventPublisher(
  client?: StageTransitionSnsPublishClient
): StageTransitionEventPublisher {
  const config = getApiRuntimeConfig();

  return new SnsStageTransitionEventPublisher(
    client ??
      new SNSClient({
        region: config.AWS_REGION,
        endpoint: config.AWS_ENDPOINT,
        credentials: {
          accessKeyId: "local",
          secretAccessKey: "local"
        }
      } satisfies SNSClientConfig),
    config.SNS_STAGE_EVENTS_TOPIC
  );
}

export function createLazyStageTransitionEventPublisher(): StageTransitionEventPublisher {
  let publisher: StageTransitionEventPublisher | undefined;

  return {
    async publish(event) {
      publisher ??= createStageTransitionEventPublisher();
      await publisher.publish(event);
    }
  };
}
