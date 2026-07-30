import { CreateTopicCommand, PublishCommand } from "@aws-sdk/client-sns";
import { describe, expect, it, vi } from "vitest";

import {
  EXPENSE_REPORT_STAGE_TRANSITIONED_EVENT_TYPE,
  buildExpenseReportStageTransitionedEvent,
  expenseReportStageTransitionedEventSchema
} from "./expense-report-stage-transitioned.event.js";
import { SnsStageTransitionEventPublisher } from "./stage-transition-event-publisher.js";

const tenantId = "00000000-0000-4000-8000-000000000801";
const expenseReportId = "00000000-0000-4000-8000-000000000802";
const correlationId = "synthetic-stage-transition-correlation-id";
const eventId = "00000000-0000-4000-8000-000000000803";
const eventTime = new Date("2026-01-01T00:00:00.000Z");
const topicName = "expenseflow-stage-events";
const topicArn = ["arn", "aws", "sns", "us-east-1", "000000000000", topicName].join(":");

describe("buildExpenseReportStageTransitionedEvent", () => {
  it("builds a CloudEvents-compliant event with the originating correlation ID", () => {
    const event = buildExpenseReportStageTransitionedEvent({
      id: eventId,
      time: eventTime.toISOString(),
      tenantId,
      expenseReportId,
      fromStage: "Submitted",
      toStage: "Manager Approval",
      correlationId
    });

    expect(expenseReportStageTransitionedEventSchema.parse(event)).toEqual(event);
    expect(event).toMatchObject({
      id: eventId,
      specversion: "1.0",
      type: EXPENSE_REPORT_STAGE_TRANSITIONED_EVENT_TYPE,
      datacontenttype: "application/json",
      subject: `ExpenseReport/${expenseReportId}`,
      data: {
        tenantId,
        expenseReportId,
        fromStage: "Submitted",
        toStage: "Manager Approval",
        correlationId
      }
    });
  });
});

describe("SnsStageTransitionEventPublisher", () => {
  it("publishes one validated CloudEvent JSON message to the configured SNS topic", async () => {
    const sentCommands: PublishCommand[] = [];
    const client = {
      send: vi.fn(async (command: CreateTopicCommand | PublishCommand) => {
        if (command instanceof CreateTopicCommand) {
          return { TopicArn: topicArn };
        }

        sentCommands.push(command);
        return {};
      })
    };
    const publisher = new SnsStageTransitionEventPublisher(client, topicName);

    await publisher.publish(
      buildExpenseReportStageTransitionedEvent({
        id: eventId,
        time: eventTime.toISOString(),
        tenantId,
        expenseReportId,
        fromStage: "AP Review",
        toStage: "Paid",
        correlationId
      })
    );

    expect(client.send).toHaveBeenCalledTimes(2);
    expect(client.send.mock.calls[0]?.[0]).toBeInstanceOf(CreateTopicCommand);
    const command = sentCommands[0];
    expect(command).toBeInstanceOf(PublishCommand);
    expect(command.input.TopicArn).toBe(topicArn);

    const message = command.input.Message;
    expect(typeof message).toBe("string");
    const event = expenseReportStageTransitionedEventSchema.parse(JSON.parse(message ?? "{}"));
    expect(event).toMatchObject({
      id: eventId,
      time: eventTime.toISOString(),
      data: {
        tenantId,
        expenseReportId,
        fromStage: "AP Review",
        toStage: "Paid",
        correlationId
      }
    });
  });
});
