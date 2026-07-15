import {
  DescribeTableCommand,
  PutItemCommand,
  QueryCommand,
  type PutItemCommandOutput,
  type QueryCommandOutput
} from "@aws-sdk/client-dynamodb";
import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import type { AuthenticatedRequestContext } from "../src/auth/verifier.js";
import type { ExpenseReportStage } from "../src/repository/case-queue.js";
import {
  queryOverdueCasesByDueDate,
  queryTenantCaseById,
  queryTenantCasesByStage,
  seedCaseQueueReadModel,
  upsertCaseQueueRollup,
  type CaseQueueDynamoClient,
  type CaseQueueRollupInput
} from "../src/store/dynamo.js";
import { startDynamoDBLocal, type StartedDynamoDBLocal } from "./setup/dynamodb-local.js";

const tenantA = "00000000-0000-4000-8000-000000000301";
const tenantB = "00000000-0000-4000-8000-000000000302";
const fixedNow = new Date("2026-07-15T12:00:00.000Z");

describe("Case Queue DynamoDB read model", () => {
  let dynamo: StartedDynamoDBLocal | undefined;
  let tableName: string;
  let commandNames: string[];
  let recordingClient: CaseQueueDynamoClient;

  beforeAll(async () => {
    tableName = `expenseflow-case-queue-${randomUUID()}`;
    dynamo = await startDynamoDBLocal(tableName);
  }, 30_000);

  beforeEach(async () => {
    commandNames = [];
    recordingClient = new RecordingDynamoClient(dynamoClient(), commandNames);

    await seedCaseQueueReadModel(dynamoClient(), sampleItems(), {
      tableName,
      now: fixedNow
    });
    commandNames.length = 0;
  });

  afterAll(async () => {
    await dynamo?.stop();
  });

  it("uses the base table to query one tenant's cases by stage", async () => {
    const rows = await queryTenantCasesByStage(
      recordingClient,
      authContextFor(tenantA),
      "Submitted",
      { tableName }
    );

    expect(rows.map((row) => row.caseId)).toEqual(["case-submitted-overdue"]);
    expect(rows.every((row) => row.tenantId === tenantA)).toBe(true);
    expect(rows.every((row) => row.stage === "Submitted")).toBe(true);
    expect(commandNames).toEqual(["QueryCommand"]);
    expect(commandNames).not.toContain("ScanCommand");
  });

  it("uses tenant and stage context to query a single case by id with strong consistency", async () => {
    const row = await queryTenantCaseById(
      recordingClient,
      authContextFor(tenantA),
      "Manager Approval",
      "case-manager-review",
      { tableName, consistentRead: true }
    );

    expect(row).toEqual({
      caseId: "case-manager-review",
      tenantId: tenantA,
      stage: "Manager Approval",
      dueDate: "2026-07-20",
      overdue: false
    });
    expect(commandNames).toEqual(["QueryCommand"]);
    expect(commandNames).not.toContain("ScanCommand");
  });

  it("uses the due-date GSI to query overdue cases for one tenant", async () => {
    const rows = await queryOverdueCasesByDueDate(
      recordingClient,
      authContextFor(tenantA),
      "2026-07-14",
      { tableName }
    );

    expect(rows.map((row) => row.caseId)).toEqual([
      "case-drafted-overdue",
      "case-submitted-overdue"
    ]);
    expect(rows.every((row) => row.tenantId === tenantA)).toBe(true);
    expect(rows.every((row) => row.overdue)).toBe(true);
    expect(commandNames).toEqual(["QueryCommand"]);
    expect(commandNames).not.toContain("ScanCommand");
  });

  it("defines exactly one GSI for the due-date access pattern", async () => {
    const result = await dynamoClient().send(new DescribeTableCommand({ TableName: tableName }));

    expect(result.Table?.KeySchema).toEqual([
      { AttributeName: "pk", KeyType: "HASH" },
      { AttributeName: "sk", KeyType: "RANGE" }
    ]);
    expect(result.Table?.GlobalSecondaryIndexes?.map((index) => index.IndexName)).toEqual(["GSI1"]);
    expect(result.Table?.GlobalSecondaryIndexes?.[0]?.KeySchema).toEqual([
      { AttributeName: "gsi1pk", KeyType: "HASH" },
      { AttributeName: "gsi1sk", KeyType: "RANGE" }
    ]);
  });

  it("recomputes overdue from dueDate on each upsert", async () => {
    await upsertCaseQueueRollup(
      recordingClient,
      {
        caseId: "case-newly-overdue",
        tenantId: tenantA,
        stage: "AP Review",
        dueDate: "2026-07-14"
      },
      { tableName, now: fixedNow }
    );
    commandNames.length = 0;

    const row = await queryTenantCaseById(
      recordingClient,
      authContextFor(tenantA),
      "AP Review",
      "case-newly-overdue",
      { tableName, consistentRead: true }
    );

    expect(row?.overdue).toBe(true);
    expect(commandNames).toEqual(["QueryCommand"]);
    expect(commandNames).not.toContain("ScanCommand");
  });
  function dynamoClient(): StartedDynamoDBLocal["client"] {
    if (dynamo === undefined) {
      throw new Error("DynamoDB Local was not started.");
    }

    return dynamo.client;
  }
});

class RecordingDynamoClient implements CaseQueueDynamoClient {
  constructor(
    private readonly delegate: StartedDynamoDBLocal["client"],
    private readonly commandNames: string[]
  ) {}

  send(command: PutItemCommand): Promise<PutItemCommandOutput>;
  send(command: QueryCommand): Promise<QueryCommandOutput>;
  async send(
    command: PutItemCommand | QueryCommand
  ): Promise<PutItemCommandOutput | QueryCommandOutput> {
    this.commandNames.push(command.constructor.name);

    if (command instanceof PutItemCommand) {
      return this.delegate.send(command);
    }

    return this.delegate.send(command);
  }
}

function authContextFor(tenantId: string): AuthenticatedRequestContext {
  return {
    userId: "00000000-0000-4000-8000-000000000399",
    tenantId,
    roles: ["Finance Admin"]
  };
}

function sampleItems(): CaseQueueRollupInput[] {
  return [
    makeRollup("case-drafted-overdue", tenantA, "Drafted", "2026-07-10"),
    makeRollup("case-submitted-overdue", tenantA, "Submitted", "2026-07-14"),
    makeRollup("case-manager-review", tenantA, "Manager Approval", "2026-07-20"),
    makeRollup("case-ap-review", tenantA, "AP Review", "2026-07-30"),
    makeRollup("case-other-tenant-overdue", tenantB, "Submitted", "2026-07-01")
  ];
}

function makeRollup(
  caseId: string,
  tenantId: string,
  stage: ExpenseReportStage,
  dueDate: string
): CaseQueueRollupInput {
  return {
    caseId,
    tenantId,
    stage,
    dueDate
  };
}
