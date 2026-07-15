import { GenericContainer, Wait, type StartedTestContainer } from "testcontainers";

import {
  createCaseQueueReadModelTable,
  createDynamoDBClient,
  deleteCaseQueueReadModelTable
} from "../../src/store/dynamo.js";

export interface StartedDynamoDBLocal {
  client: ReturnType<typeof createDynamoDBClient>;
  endpoint: string;
  stop(): Promise<void>;
}

export async function startDynamoDBLocal(tableName: string): Promise<StartedDynamoDBLocal> {
  const container = await new GenericContainer("amazon/dynamodb-local:2.6.1")
    .withExposedPorts(8000)
    .withCommand(["-jar", "DynamoDBLocal.jar", "-inMemory", "-sharedDb"])
    .withWaitStrategy(Wait.forListeningPorts())
    .start();

  const endpoint = `http://${container.getHost()}:${container.getMappedPort(8000)}`;
  const client = createDynamoDBClient({ endpoint });

  await createCaseQueueReadModelTable(client, tableName);

  return {
    client,
    endpoint,
    async stop() {
      await stopDynamoDBLocal(client, container, tableName);
    }
  };
}

async function stopDynamoDBLocal(
  client: ReturnType<typeof createDynamoDBClient>,
  container: StartedTestContainer,
  tableName: string
): Promise<void> {
  try {
    await deleteCaseQueueReadModelTable(client, tableName);
  } finally {
    await client.destroy();
    await container.stop();
  }
}
