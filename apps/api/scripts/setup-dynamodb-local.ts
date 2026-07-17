import {
  createCaseQueueReadModelTable,
  createDynamoDBClient,
  seedCaseQueueReadModel,
  type CaseQueueRollupInput
} from "../src/store/dynamo.js";

const tableName = process.env.CASE_QUEUE_TABLE_NAME ?? "expenseflow-case-queue";
const client = createDynamoDBClient({
  endpoint: process.env.AWS_ENDPOINT ?? "http://localhost:8000"
});

await createCaseQueueReadModelTable(client, tableName);
await seedCaseQueueReadModel(client, sampleItems(), { tableName });
await client.destroy();

function sampleItems(): CaseQueueRollupInput[] {
  return [
    {
      caseId: "case-drafted-sample",
      tenantId: "00000000-0000-4000-8000-000000000401",
      stage: "Drafted",
      dueDate: "2026-07-10"
    },
    {
      caseId: "case-submitted-sample",
      tenantId: "00000000-0000-4000-8000-000000000401",
      stage: "Submitted",
      dueDate: "2026-07-14"
    },
    {
      caseId: "case-ap-review-sample",
      tenantId: "00000000-0000-4000-8000-000000000401",
      stage: "AP Review",
      dueDate: "2026-07-30"
    },
    {
      caseId: "case-other-tenant-sample",
      tenantId: "00000000-0000-4000-8000-000000000402",
      stage: "Manager Approval",
      dueDate: "2026-07-12"
    }
  ];
}
