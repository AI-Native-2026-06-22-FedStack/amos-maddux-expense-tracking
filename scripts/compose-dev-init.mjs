import { mkdir, readFile, readdir, stat, writeFile } from "node:fs/promises";
import { generateKeyPairSync } from "node:crypto";
import { join } from "node:path";

import {
  CreateSecretCommand,
  PutSecretValueCommand,
  SecretsManagerClient
} from "@aws-sdk/client-secrets-manager";
import {
  BillingMode,
  CreateTableCommand,
  DynamoDBClient,
  ListTablesCommand,
  ResourceInUseException,
  ScalarAttributeType,
  waitUntilTableExists
} from "@aws-sdk/client-dynamodb";
import pg from "pg";

const tenantId = "00000000-0000-4000-8000-000000000701";
const dbPasswordSecretId = process.env.DB_PASSWORD_SECRET_ID ?? "expenseflow/local/db-password";
const jwtSigningKeysSecretId =
  process.env.JWT_SIGNING_KEYS_SECRET_ID ?? "expenseflow/local/jwt-signing-keys";
const databaseUri =
  process.env.DATABASE_URI ??
  "postgres://expenseflow:synthetic-compose-db-password@postgres:5432/expenseflow";
const awsEndpoint = process.env.AWS_ENDPOINT ?? "http://localstack:4566";
const dynamodbEndpoint = process.env.DYNAMODB_ENDPOINT ?? "http://dynamodb-local:8000";
const awsRegion = process.env.AWS_REGION ?? "us-east-1";
const secretDirectory = process.env.COMPOSE_SECRET_DIR ?? "/run/expenseflow-secrets";
const privateKeyPath = join(secretDirectory, "jwt-private.pem");
const publicKeyPath = join(secretDirectory, "jwt-public.pem");

const credentials = {
  accessKeyId: "local",
  secretAccessKey: "local"
};

const secretsManager = new SecretsManagerClient({
  endpoint: awsEndpoint,
  region: awsRegion,
  credentials
});
const dynamodb = new DynamoDBClient({
  endpoint: dynamodbEndpoint,
  region: awsRegion,
  credentials
});

await waitForLocalStack();
await waitForDynamoDB();
const jwtSigningKeys = await ensureJwtKeys();
await upsertSecret(dbPasswordSecretId, "synthetic-compose-db-password");
await upsertSecret(jwtSigningKeysSecretId, JSON.stringify(jwtSigningKeys));
await withPgClient(async (client) => {
  await ensureMigrationTable(client);
  await applyMigrations(client, "apps/api/drizzle", "api");
  await applyMigrations(client, "services/compute/db/migrations", "compute");
  await seedGlMapping(client);
});
await ensureCaseQueueTable();

console.log("Compose local-dev initialization complete.");

async function ensureJwtKeys() {
  await mkdir(secretDirectory, { recursive: true });

  if ((await pathExists(privateKeyPath)) && (await pathExists(publicKeyPath))) {
    return {
      privateKeyPem: await readFile(privateKeyPath, "utf8"),
      publicKeyPem: await readFile(publicKeyPath, "utf8")
    };
  }

  const keyPair = generateKeyPairSync("rsa", {
    modulusLength: 2048,
    publicKeyEncoding: {
      type: "spki",
      format: "pem"
    },
    privateKeyEncoding: {
      type: "pkcs8",
      format: "pem"
    }
  });

  await writeFile(privateKeyPath, keyPair.privateKey, { mode: 0o600 });
  await writeFile(publicKeyPath, keyPair.publicKey, { mode: 0o644 });

  return {
    privateKeyPem: keyPair.privateKey,
    publicKeyPem: keyPair.publicKey
  };
}

async function upsertSecret(secretId, secretString) {
  try {
    await secretsManager.send(
      new CreateSecretCommand({
        Name: secretId,
        SecretString: secretString
      })
    );
    return;
  } catch (error) {
    if (error?.name !== "ResourceExistsException") {
      throw error;
    }
  }

  await secretsManager.send(
    new PutSecretValueCommand({
      SecretId: secretId,
      SecretString: secretString
    })
  );
}

async function withPgClient(callback) {
  const client = await retry(async () => {
    const retryClient = new pg.Client({ connectionString: databaseUri });
    await retryClient.connect();
    return retryClient;
  }, "Postgres connection");

  try {
    await callback(client);
  } finally {
    await client.end();
  }
}

async function ensureMigrationTable(client) {
  await client.query(`
    create table if not exists compose_schema_migration (
      name text primary key,
      applied_at timestamptz not null default now()
    )
  `);
}

async function applyMigrations(client, directory, namespace) {
  const entries = await readdir(directory);
  const migrationFiles = entries.filter((entry) => entry.endsWith(".sql")).sort();

  for (const fileName of migrationFiles) {
    const migrationName = `${namespace}/${fileName}`;
    const applied = await client.query("select 1 from compose_schema_migration where name = $1", [
      migrationName
    ]);

    if (applied.rowCount > 0) {
      continue;
    }

    const sql = await readFile(join(directory, fileName), "utf8");
    await client.query("begin");
    try {
      await client.query(sql);
      await client.query("insert into compose_schema_migration (name) values ($1)", [
        migrationName
      ]);
      await client.query("commit");
    } catch (error) {
      await client.query("rollback");
      throw error;
    }
  }
}

async function seedGlMapping(client) {
  await client.query(
    `
    with upsert_codes as (
      insert into gl_code (
        tenant_id,
        account_code,
        account_name,
        normal_balance
      )
      values
        ($1::uuid, '6100', 'Synthetic Meals Expense', 'debit')
      on conflict (tenant_id, account_code) do update
      set
        account_name = excluded.account_name,
        normal_balance = excluded.normal_balance,
        active = true,
        updated_at = now()
      returning id, tenant_id
    )
    insert into gl_mapping (
      tenant_id,
      category,
      gl_code_id
    )
    select tenant_id, 'Meals', id
    from upsert_codes
    on conflict (tenant_id, category) do update
    set
      gl_code_id = excluded.gl_code_id,
      updated_at = now();
    `,
    [tenantId]
  );
}

async function ensureCaseQueueTable() {
  const tableName = "expenseflow-case-queue";
  const tables = await dynamodb.send(new ListTablesCommand({}));
  if (tables.TableNames?.includes(tableName)) {
    return;
  }

  try {
    await dynamodb.send(
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
            IndexName: "GSI1",
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

  await waitUntilTableExists(
    { client: dynamodb, minDelay: 1, maxWaitTime: 20 },
    { TableName: tableName }
  );
}

async function waitForLocalStack() {
  await retry(async () => {
    const response = await fetch(`${awsEndpoint}/_localstack/health`);
    if (!response.ok) {
      throw new Error(`LocalStack health returned ${response.status}`);
    }
  }, "LocalStack");
}

async function waitForDynamoDB() {
  await retry(async () => {
    await dynamodb.send(new ListTablesCommand({ Limit: 1 }));
  }, "DynamoDB Local");
}

async function retry(callback, label) {
  const deadline = Date.now() + 30_000;
  let lastError;

  while (Date.now() < deadline) {
    try {
      return await callback();
    } catch (error) {
      lastError = error;
      await sleep(500);
    }
  }

  throw new Error(`${label} did not become ready: ${lastError}`);
}

async function pathExists(path) {
  try {
    await stat(path);
    return true;
  } catch {
    return false;
  }
}

function sleep(milliseconds) {
  return new Promise((resolve) => {
    setTimeout(resolve, milliseconds);
  });
}
