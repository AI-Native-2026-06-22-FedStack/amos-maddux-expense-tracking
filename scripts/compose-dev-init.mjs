import { mkdir, readFile, readdir, stat, writeFile } from "node:fs/promises";
import { readFileSync } from "node:fs";
import { Buffer } from "node:buffer";
import { createCipheriv, generateKeyPairSync, randomBytes } from "node:crypto";
import { join } from "node:path";

import {
  CreateSecretCommand,
  PutSecretValueCommand,
  SecretsManagerClient
} from "@aws-sdk/client-secrets-manager";
import {
  CreateTopicCommand,
  ListSubscriptionsByTopicCommand,
  SNSClient,
  SubscribeCommand
} from "@aws-sdk/client-sns";
import {
  CreateQueueCommand,
  GetQueueAttributesCommand,
  GetQueueUrlCommand,
  QueueAttributeName,
  SQSClient,
  SetQueueAttributesCommand
} from "@aws-sdk/client-sqs";
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
import argon2 from "argon2";

import { localDevAuthFixture } from "./local-dev-auth-fixture.mjs";

const tenantId = localDevAuthFixture.tenantId;
const encryptedTotpSecretPrefix = "v1";
const dbPasswordSecretId = process.env.DB_PASSWORD_SECRET_ID ?? "expenseflow/local/db-password";
const jwtSigningKeysSecretId =
  process.env.JWT_SIGNING_KEYS_SECRET_ID ?? "expenseflow/local/jwt-signing-keys";
const databaseUri =
  process.env.DATABASE_URI ??
  "postgres://expenseflow:synthetic-compose-db-password@postgres:5432/expenseflow";
const awsEndpoint = process.env.AWS_ENDPOINT ?? "http://localstack:4566";
const dynamodbEndpoint = process.env.DYNAMODB_ENDPOINT ?? "http://dynamodb-local:8000";
const awsRegion = process.env.AWS_REGION ?? "us-east-1";
const stageEventsTopicName = process.env.SNS_STAGE_EVENTS_TOPIC ?? "expenseflow-stage-events";
const stageEventsQueueName = process.env.SQS_STAGE_EVENTS_QUEUE ?? "expenseflow-stage-projection";
const stageEventsDlqName = process.env.SQS_STAGE_EVENTS_DLQ ?? "expenseflow-stage-projection-dlq";
const stageEventsMaxReceiveCount = Number(process.env.SQS_STAGE_EVENTS_MAX_RECEIVE_COUNT ?? "3");
const secretDirectory = process.env.COMPOSE_SECRET_DIR ?? "/run/expenseflow-secrets";
const privateKeyPath = join(secretDirectory, "jwt-private.pem");
const publicKeyPath = join(secretDirectory, "jwt-public.pem");
const totpEncryptionKeyPath =
  process.env.TOTP_SECRET_ENCRYPTION_KEY_FILE ??
  join(secretDirectory, "synthetic-local-dev-totp-encryption-key.b64");

const credentials = {
  accessKeyId: "local",
  secretAccessKey: "local"
};

const secretsManager = new SecretsManagerClient({
  endpoint: awsEndpoint,
  region: awsRegion,
  credentials
});
const sns = new SNSClient({
  endpoint: awsEndpoint,
  region: awsRegion,
  credentials
});
const sqs = new SQSClient({
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
await ensureTotpEncryptionKey();
await upsertSecret(dbPasswordSecretId, "synthetic-compose-db-password");
await upsertSecret(jwtSigningKeysSecretId, JSON.stringify(jwtSigningKeys));
await withPgClient(async (client) => {
  await ensureMigrationTable(client);
  await applyMigrations(client, "apps/api/drizzle", "api");
  await applyMigrations(client, "services/compute/db/migrations", "compute");
  await seedGlMapping(client);
  await seedLocalAuthUser(client);
});
await ensureCaseQueueTable();
await ensureStageEventFanout();

console.log("Compose local-dev initialization complete.");
console.log(
  [
    "Seeded local sign-in:",
    `Tenant ID: ${localDevAuthFixture.tenantId}`,
    `Email: ${localDevAuthFixture.email}`,
    `Password: ${localDevAuthFixture.password}`,
    `MFA secret: ${localDevAuthFixture.mfaSecret}`,
    "Run `npm run compose:login` for a current MFA code."
  ].join("\n")
);

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

async function ensureTotpEncryptionKey() {
  await mkdir(secretDirectory, { recursive: true });

  if (await pathExists(totpEncryptionKeyPath)) {
    const existingKey = (await readFile(totpEncryptionKeyPath, "utf8")).trim();
    const decodedKey = Buffer.from(existingKey, "base64");

    if (decodedKey.length !== 32) {
      throw new Error(`${totpEncryptionKeyPath} must contain a base64-encoded 32-byte key.`);
    }

    return existingKey;
  }

  const generatedKey = randomBytes(32).toString("base64");
  await writeFile(totpEncryptionKeyPath, `${generatedKey}\n`, { mode: 0o600 });

  return generatedKey;
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

async function seedLocalAuthUser(client) {
  const roleId = await upsertLocalRole(client);
  const passwordHash = await argon2.hash(localDevAuthFixture.password, {
    type: argon2.argon2id,
    memoryCost: Number(process.env.ARGON2_MEMORY_COST ?? "19456"),
    timeCost: Number(process.env.ARGON2_TIME_COST ?? "2"),
    parallelism: Number(process.env.ARGON2_PARALLELISM ?? "1")
  });
  const encryptedTotpSecret = protectTotpSecret(localDevAuthFixture.mfaSecret);
  const userResult = await client.query(
    `
    insert into "user" (
      tenant_id,
      role_id,
      email,
      display_name,
      disabled_at
    )
    values ($1::uuid, $2::uuid, $3, $4, null)
    on conflict (tenant_id, email) do update
    set
      role_id = excluded.role_id,
      display_name = excluded.display_name,
      disabled_at = null,
      updated_at = now()
    returning id;
    `,
    [tenantId, roleId, localDevAuthFixture.email, localDevAuthFixture.displayName]
  );
  const userId = userResult.rows[0]?.id;

  if (typeof userId !== "string") {
    throw new Error("Local auth user seed did not return a user id.");
  }

  await client.query(
    `
    insert into credential (
      tenant_id,
      user_id,
      password_hash
    )
    values ($1::uuid, $2::uuid, $3)
    on conflict (tenant_id, user_id) do update
    set
      password_hash = excluded.password_hash,
      updated_at = now();
    `,
    [tenantId, userId, passwordHash]
  );
  await client.query(
    `
    insert into mfa_enrollment (
      tenant_id,
      user_id,
      encrypted_totp_secret,
      totp_secret_key_id,
      disabled_at,
      last_accepted_totp_time_step,
      last_accepted_totp_at
    )
    values ($1::uuid, $2::uuid, $3, $4, null, null, null)
    on conflict (tenant_id, user_id) do update
    set
      encrypted_totp_secret = excluded.encrypted_totp_secret,
      totp_secret_key_id = excluded.totp_secret_key_id,
      disabled_at = null,
      last_accepted_totp_time_step = null,
      last_accepted_totp_at = null;
    `,
    [tenantId, userId, encryptedTotpSecret, localDevAuthFixture.totpSecretKeyId]
  );
}

async function upsertLocalRole(client) {
  const result = await client.query(
    `
    insert into role (
      tenant_id,
      name
    )
    values ($1::uuid, $2)
    on conflict (tenant_id, name) do update
    set updated_at = now()
    returning id;
    `,
    [tenantId, localDevAuthFixture.role]
  );
  const roleId = result.rows[0]?.id;

  if (typeof roleId !== "string") {
    throw new Error("Local auth role seed did not return a role id.");
  }

  return roleId;
}

function protectTotpSecret(secret) {
  const configuredKey = readTotpEncryptionKey();

  const key = Buffer.from(configuredKey, "base64");

  if (key.length !== 32) {
    throw new Error("TOTP_SECRET_ENCRYPTION_KEY must decode to 32 bytes.");
  }

  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", key, iv);
  const ciphertext = Buffer.concat([cipher.update(secret, "utf8"), cipher.final()]);
  const tag = cipher.getAuthTag();

  return [
    encryptedTotpSecretPrefix,
    localDevAuthFixture.totpSecretKeyId,
    iv.toString("base64url"),
    tag.toString("base64url"),
    ciphertext.toString("base64url")
  ].join(":");
}

function readTotpEncryptionKey() {
  const inlineKey = process.env.TOTP_SECRET_ENCRYPTION_KEY;

  if (inlineKey !== undefined && inlineKey.trim() !== "") {
    return inlineKey.trim();
  }

  try {
    return readFileSync(totpEncryptionKeyPath, "utf8").trim();
  } catch (error) {
    throw new Error(`Unable to read TOTP encryption key from ${totpEncryptionKeyPath}.`, {
      cause: error
    });
  }
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

async function ensureStageEventFanout() {
  if (!Number.isInteger(stageEventsMaxReceiveCount) || stageEventsMaxReceiveCount < 1) {
    throw new Error("SQS_STAGE_EVENTS_MAX_RECEIVE_COUNT must be a positive integer.");
  }

  const topicArn = await ensureSnsTopic(stageEventsTopicName);
  const dlqUrl = await ensureSqsQueue(stageEventsDlqName);
  const dlqArn = await readQueueArn(dlqUrl);
  const queueUrl = await ensureSqsQueue(stageEventsQueueName, {
    RedrivePolicy: JSON.stringify({
      deadLetterTargetArn: dlqArn,
      maxReceiveCount: String(stageEventsMaxReceiveCount)
    })
  });
  const queueArn = await readQueueArn(queueUrl);

  await sqs.send(
    new SetQueueAttributesCommand({
      QueueUrl: queueUrl,
      Attributes: {
        RedrivePolicy: JSON.stringify({
          deadLetterTargetArn: dlqArn,
          maxReceiveCount: String(stageEventsMaxReceiveCount)
        }),
        Policy: JSON.stringify(createSnsQueuePolicy(queueArn, topicArn))
      }
    })
  );
  await ensureSnsSubscription(topicArn, queueArn);
}

async function ensureSnsTopic(name) {
  const response = await sns.send(
    new CreateTopicCommand({
      Name: name
    })
  );

  if (typeof response.TopicArn !== "string") {
    throw new Error(`SNS topic ${name} did not return an ARN.`);
  }

  return response.TopicArn;
}

async function ensureSqsQueue(name, attributes = {}) {
  try {
    const response = await sqs.send(
      new CreateQueueCommand({
        QueueName: name,
        Attributes: attributes
      })
    );

    if (typeof response.QueueUrl === "string") {
      return response.QueueUrl;
    }
  } catch (error) {
    if (error?.name !== "QueueNameExists") {
      throw error;
    }
  }

  const response = await sqs.send(
    new GetQueueUrlCommand({
      QueueName: name
    })
  );

  if (typeof response.QueueUrl !== "string") {
    throw new Error(`SQS queue ${name} did not return a URL.`);
  }

  if (Object.keys(attributes).length > 0) {
    await sqs.send(
      new SetQueueAttributesCommand({
        QueueUrl: response.QueueUrl,
        Attributes: attributes
      })
    );
  }

  return response.QueueUrl;
}

async function readQueueArn(queueUrl) {
  const response = await sqs.send(
    new GetQueueAttributesCommand({
      QueueUrl: queueUrl,
      AttributeNames: [QueueAttributeName.QueueArn]
    })
  );
  const queueArn = response.Attributes?.[QueueAttributeName.QueueArn];

  if (typeof queueArn !== "string") {
    throw new Error(`SQS queue ${queueUrl} did not return an ARN.`);
  }

  return queueArn;
}

async function ensureSnsSubscription(topicArn, queueArn) {
  const subscriptions = await sns.send(
    new ListSubscriptionsByTopicCommand({
      TopicArn: topicArn
    })
  );
  const alreadySubscribed = subscriptions.Subscriptions?.some(
    (subscription) => subscription.Protocol === "sqs" && subscription.Endpoint === queueArn
  );

  if (alreadySubscribed) {
    return;
  }

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
}

function createSnsQueuePolicy(queueArn, topicArn) {
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
