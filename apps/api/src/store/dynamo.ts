import {
  BillingMode,
  CreateTableCommand,
  DeleteTableCommand,
  DynamoDBClient,
  PutItemCommand,
  QueryCommand,
  type PutItemCommandOutput,
  type QueryCommandOutput,
  ResourceInUseException,
  ResourceNotFoundException,
  ScalarAttributeType,
  waitUntilTableExists,
  waitUntilTableNotExists,
  type AttributeValue,
  type DynamoDBClientConfig
} from "@aws-sdk/client-dynamodb";

import type { AuthenticatedRequestContext } from "../auth/verifier.js";
import type { ExpenseReportStage } from "../repository/case-queue.js";

export const caseQueueTableName = "expenseflow-case-queue";
export const caseQueueDueDateIndexName = "GSI1";

export interface CaseQueueRollupInput {
  caseId: string;
  tenantId: string;
  stage: ExpenseReportStage;
  dueDate: string;
}

export interface CaseQueueReadModelItem extends CaseQueueRollupInput {
  overdue: boolean;
}

export interface CaseQueueReadOptions {
  consistentRead?: boolean;
}

export interface CaseQueueDynamoConfig {
  tableName?: string;
  now?: Date;
}

export interface CaseQueueDynamoClient {
  send(command: PutItemCommand): Promise<PutItemCommandOutput>;
  send(command: QueryCommand): Promise<QueryCommandOutput>;
}

export interface CaseQueueDynamoQueryClient {
  send(command: QueryCommand): Promise<QueryCommandOutput>;
}

export interface CaseQueueDynamoPutClient {
  send(command: PutItemCommand): Promise<PutItemCommandOutput>;
}

export function createDynamoDBClient(config: DynamoDBClientConfig = {}): DynamoDBClient {
  return new DynamoDBClient({
    region: process.env.AWS_REGION ?? "us-east-1",
    endpoint: process.env.AWS_ENDPOINT,
    credentials: {
      accessKeyId: "local",
      secretAccessKey: "local"
    },
    ...config
  });
}

export async function upsertCaseQueueRollup(
  client: CaseQueueDynamoPutClient,
  input: CaseQueueRollupInput,
  config: CaseQueueDynamoConfig = {}
): Promise<void> {
  validateRequired(input.tenantId, "tenantId");
  validateRequired(input.caseId, "caseId");
  validateRequired(input.dueDate, "dueDate");

  const item = toReadModelItem(input, config.now);

  await client.send(
    new PutItemCommand({
      TableName: config.tableName ?? caseQueueTableName,
      Item: marshallCaseQueueItem(item)
    })
  );
}

export async function queryTenantCasesByStage(
  client: CaseQueueDynamoQueryClient,
  authContext: Pick<AuthenticatedRequestContext, "tenantId">,
  stage: ExpenseReportStage,
  options: CaseQueueReadOptions & CaseQueueDynamoConfig = {}
): Promise<CaseQueueReadModelItem[]> {
  validateRequired(authContext.tenantId, "authContext.tenantId");

  const result = await client.send(
    new QueryCommand({
      TableName: options.tableName ?? caseQueueTableName,
      KeyConditionExpression: "pk = :pk and begins_with(sk, :stagePrefix)",
      ExpressionAttributeValues: {
        ":pk": toStringAttribute(tenantKey(authContext.tenantId)),
        ":stagePrefix": toStringAttribute(stageSortKeyPrefix(stage))
      },
      ConsistentRead: options.consistentRead ?? false
    })
  );

  return unmarshallCaseQueueItems(result.Items);
}

export async function queryTenantCases(
  client: CaseQueueDynamoQueryClient,
  authContext: Pick<AuthenticatedRequestContext, "tenantId">,
  options: CaseQueueReadOptions & CaseQueueDynamoConfig = {}
): Promise<CaseQueueReadModelItem[]> {
  validateRequired(authContext.tenantId, "authContext.tenantId");

  const result = await client.send(
    new QueryCommand({
      TableName: options.tableName ?? caseQueueTableName,
      KeyConditionExpression: "pk = :pk",
      ExpressionAttributeValues: {
        ":pk": toStringAttribute(tenantKey(authContext.tenantId))
      },
      ConsistentRead: options.consistentRead ?? false
    })
  );

  return unmarshallCaseQueueItems(result.Items);
}

export async function queryTenantCaseById(
  client: CaseQueueDynamoQueryClient,
  authContext: Pick<AuthenticatedRequestContext, "tenantId">,
  stage: ExpenseReportStage,
  caseId: string,
  options: CaseQueueReadOptions & CaseQueueDynamoConfig = {}
): Promise<CaseQueueReadModelItem | null> {
  validateRequired(authContext.tenantId, "authContext.tenantId");
  validateRequired(caseId, "caseId");

  const result = await client.send(
    new QueryCommand({
      TableName: options.tableName ?? caseQueueTableName,
      KeyConditionExpression: "pk = :pk and sk = :sk",
      ExpressionAttributeValues: {
        ":pk": toStringAttribute(tenantKey(authContext.tenantId)),
        ":sk": toStringAttribute(stageCaseSortKey(stage, caseId))
      },
      ConsistentRead: options.consistentRead ?? false,
      Limit: 1
    })
  );

  return unmarshallCaseQueueItems(result.Items)[0] ?? null;
}

export async function queryOverdueCasesByDueDate(
  client: CaseQueueDynamoQueryClient,
  authContext: Pick<AuthenticatedRequestContext, "tenantId">,
  dueOnOrBefore: string,
  options: CaseQueueDynamoConfig = {}
): Promise<CaseQueueReadModelItem[]> {
  validateRequired(authContext.tenantId, "authContext.tenantId");
  validateRequired(dueOnOrBefore, "dueOnOrBefore");

  const result = await client.send(
    new QueryCommand({
      TableName: options.tableName ?? caseQueueTableName,
      IndexName: caseQueueDueDateIndexName,
      KeyConditionExpression: "gsi1pk = :pk and gsi1sk between :start and :end",
      ExpressionAttributeValues: {
        ":pk": toStringAttribute(tenantKey(authContext.tenantId)),
        ":start": toStringAttribute("DUE#0000-00-00"),
        ":end": toStringAttribute(`DUE#${dueOnOrBefore}#~`)
      },
      ConsistentRead: false
    })
  );

  return unmarshallCaseQueueItems(result.Items).filter((item) => item.overdue);
}

export async function createCaseQueueReadModelTable(
  client: DynamoDBClient,
  tableName = caseQueueTableName
): Promise<void> {
  try {
    await client.send(
      new CreateTableCommand({
        TableName: tableName,
        BillingMode: BillingMode.PAY_PER_REQUEST,
        AttributeDefinitions: [
          { AttributeName: "pk", AttributeType: ScalarAttributeType.S },
          { AttributeName: "sk", AttributeType: ScalarAttributeType.S },
          { AttributeName: "gsi1pk", AttributeType: ScalarAttributeType.S },
          { AttributeName: "gsi1sk", AttributeType: ScalarAttributeType.S }
        ],
        KeySchema: [
          { AttributeName: "pk", KeyType: "HASH" },
          { AttributeName: "sk", KeyType: "RANGE" }
        ],
        GlobalSecondaryIndexes: [
          {
            IndexName: caseQueueDueDateIndexName,
            KeySchema: [
              { AttributeName: "gsi1pk", KeyType: "HASH" },
              { AttributeName: "gsi1sk", KeyType: "RANGE" }
            ],
            Projection: { ProjectionType: "ALL" }
          }
        ]
      })
    );
  } catch (error) {
    if (!(error instanceof ResourceInUseException)) {
      throw error;
    }
  }

  await waitUntilTableExists({ client, maxWaitTime: 20, minDelay: 1 }, { TableName: tableName });
}

export async function deleteCaseQueueReadModelTable(
  client: DynamoDBClient,
  tableName = caseQueueTableName
): Promise<void> {
  try {
    await client.send(new DeleteTableCommand({ TableName: tableName }));
  } catch (error) {
    if (error instanceof ResourceNotFoundException) {
      return;
    }

    throw error;
  }

  await waitUntilTableNotExists({ client, maxWaitTime: 20, minDelay: 1 }, { TableName: tableName });
}

export async function seedCaseQueueReadModel(
  client: CaseQueueDynamoPutClient,
  items: readonly CaseQueueRollupInput[],
  config: CaseQueueDynamoConfig = {}
): Promise<void> {
  for (const item of items) {
    await upsertCaseQueueRollup(client, item, config);
  }
}

export function toReadModelItem(
  input: CaseQueueRollupInput,
  now = new Date()
): CaseQueueReadModelItem {
  return {
    ...input,
    overdue: isDueDateOverdue(input.dueDate, now)
  };
}

function marshallCaseQueueItem(item: CaseQueueReadModelItem): Record<string, AttributeValue> {
  return {
    pk: toStringAttribute(tenantKey(item.tenantId)),
    sk: toStringAttribute(stageCaseSortKey(item.stage, item.caseId)),
    gsi1pk: toStringAttribute(tenantKey(item.tenantId)),
    gsi1sk: toStringAttribute(dueDateSortKey(item)),
    caseId: toStringAttribute(item.caseId),
    tenantId: toStringAttribute(item.tenantId),
    stage: toStringAttribute(item.stage),
    dueDate: toStringAttribute(item.dueDate),
    overdue: { BOOL: item.overdue }
  };
}

function unmarshallCaseQueueItems(
  items: Record<string, AttributeValue>[] | undefined
): CaseQueueReadModelItem[] {
  return (items ?? []).map((item) => ({
    caseId: readString(item.caseId, "caseId"),
    tenantId: readString(item.tenantId, "tenantId"),
    stage: readString(item.stage, "stage") as ExpenseReportStage,
    dueDate: readString(item.dueDate, "dueDate"),
    overdue: item.overdue?.BOOL ?? false
  }));
}

function tenantKey(tenantId: string): string {
  return `TENANT#${tenantId}`;
}

function stageSortKeyPrefix(stage: ExpenseReportStage): string {
  return `STAGE#${stage}#`;
}

function stageCaseSortKey(stage: ExpenseReportStage, caseId: string): string {
  return `${stageSortKeyPrefix(stage)}CASE#${caseId}`;
}

function dueDateSortKey(item: CaseQueueReadModelItem): string {
  return `DUE#${item.dueDate}#STAGE#${item.stage}#CASE#${item.caseId}`;
}

function isDueDateOverdue(dueDate: string, now: Date): boolean {
  return dueDate < now.toISOString().slice(0, 10);
}

function toStringAttribute(value: string): AttributeValue {
  return { S: value };
}

function readString(attribute: AttributeValue | undefined, name: string): string {
  if (attribute?.S === undefined) {
    throw new Error(`DynamoDB Case Queue item is missing ${name}.`);
  }

  return attribute.S;
}

function validateRequired(value: string, name: string): void {
  if (value.trim().length === 0) {
    throw new Error(`${name} is required.`);
  }
}
