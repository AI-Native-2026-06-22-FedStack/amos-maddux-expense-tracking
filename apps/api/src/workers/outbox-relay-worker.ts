import { randomUUID } from "node:crypto";

import { closeDatabasePool } from "../db/client.js";
import { runOutboxRelay } from "../events/outbox-relay.js";

const abortController = new AbortController();

process.once("SIGINT", () => abortController.abort());
process.once("SIGTERM", () => abortController.abort());

try {
  await runOutboxRelay({
    relayId: `outbox-relay-${randomUUID()}`,
    signal: abortController.signal
  });
} finally {
  await closeDatabasePool();
}
