import { describe, expect, it } from "vitest";

import {
  EXPENSE_REPORT_STAGE_TRANSITIONED_EVENT_TYPE,
  EXPENSE_REPORT_STAGE_TRANSITIONED_SCHEMA_VERSION,
  EXPENSE_REPORT_STAGE_TRANSITIONED_SOURCE,
  expenseReportStageTransitionedEventSchema
} from "./expense-report-stage-transitioned.event.js";

const completeStageTransitionedEvent = {
  id: "00000000-0000-4000-8000-000000000701",
  source: EXPENSE_REPORT_STAGE_TRANSITIONED_SOURCE,
  specversion: "1.0",
  type: EXPENSE_REPORT_STAGE_TRANSITIONED_EVENT_TYPE,
  time: "2026-01-01T00:00:00.000Z",
  subject: "ExpenseReport/00000000-0000-4000-8000-000000000702",
  datacontenttype: "application/json",
  data: {
    schemaVersion: EXPENSE_REPORT_STAGE_TRANSITIONED_SCHEMA_VERSION,
    tenantId: "00000000-0000-4000-8000-000000000703",
    expenseReportId: "00000000-0000-4000-8000-000000000702",
    fromStage: "Submitted",
    toStage: "Manager Approval",
    correlationId: "synthetic-correlation-id"
  }
} as const;

const requiredCloudEventAttributes = ["id", "source", "specversion", "type"] as const;
const requiredDataFields = [
  "schemaVersion",
  "tenantId",
  "expenseReportId",
  "fromStage",
  "toStage",
  "correlationId"
] as const;

describe("expenseReportStageTransitionedEventSchema", () => {
  it("parses a complete CloudEvents 1.0 Expense Report stage transitioned event", () => {
    expect(expenseReportStageTransitionedEventSchema.parse(completeStageTransitionedEvent)).toEqual(
      completeStageTransitionedEvent
    );
  });

  it.each(requiredCloudEventAttributes)(
    "rejects an envelope missing required CloudEvents attribute %s",
    (attribute) => {
      const eventMissingAttribute = Object.fromEntries(
        Object.entries(completeStageTransitionedEvent).filter(([key]) => key !== attribute)
      );

      expect(() =>
        expenseReportStageTransitionedEventSchema.parse(eventMissingAttribute)
      ).toThrow();
    }
  );

  it("rejects the wrong CloudEvents specversion", () => {
    const eventWithWrongSpecVersion = {
      ...completeStageTransitionedEvent,
      specversion: "0.3"
    };

    expect(() =>
      expenseReportStageTransitionedEventSchema.parse(eventWithWrongSpecVersion)
    ).toThrow();
  });

  it("rejects the wrong event type", () => {
    const eventWithWrongType = {
      ...completeStageTransitionedEvent,
      type: "com.expenseflow.expense-report.transition.v1"
    };

    expect(() => expenseReportStageTransitionedEventSchema.parse(eventWithWrongType)).toThrow();
  });

  it.each(requiredCloudEventAttributes)("rejects numeric %s context attributes", (attribute) => {
    const eventWithNumericAttribute = {
      ...completeStageTransitionedEvent,
      [attribute]: 1001
    };

    expect(() =>
      expenseReportStageTransitionedEventSchema.parse(eventWithNumericAttribute)
    ).toThrow();
  });

  it("rejects an invalid from stage", () => {
    const eventWithInvalidFromStage = {
      ...completeStageTransitionedEvent,
      data: {
        ...completeStageTransitionedEvent.data,
        fromStage: "Validate"
      }
    };

    expect(() =>
      expenseReportStageTransitionedEventSchema.parse(eventWithInvalidFromStage)
    ).toThrow();
  });

  it("rejects an invalid to stage", () => {
    const eventWithInvalidToStage = {
      ...completeStageTransitionedEvent,
      data: {
        ...completeStageTransitionedEvent.data,
        toStage: "Notify"
      }
    };

    expect(() =>
      expenseReportStageTransitionedEventSchema.parse(eventWithInvalidToStage)
    ).toThrow();
  });

  it.each(requiredDataFields)("rejects an event missing required data field %s", (field) => {
    const dataMissingField = Object.fromEntries(
      Object.entries(completeStageTransitionedEvent.data).filter(([key]) => key !== field)
    );
    const eventMissingDataField = {
      ...completeStageTransitionedEvent,
      data: dataMissingField
    };

    expect(() => expenseReportStageTransitionedEventSchema.parse(eventMissingDataField)).toThrow();
  });
});
