import "./telemetry.js";

import { startApiServer, type ApiServerHandle } from "./bootstrap.js";
import { shutdownTelemetry } from "./telemetry.js";

let apiServer: ApiServerHandle | undefined;
let shutdownStarted = false;

startApiServer()
  .then((handle) => {
    apiServer = handle;
    const address = handle.server.address();
    const port = typeof address === "object" && address !== null ? address.port : "unknown";

    console.log(`ExpenseFlow API listening on port ${port}.`);
  })
  .catch((error: unknown) => {
    console.error("ExpenseFlow API startup failed.", error);
    process.exit(1);
  });

function shutdown(signal: NodeJS.Signals): void {
  if (shutdownStarted) {
    return;
  }

  shutdownStarted = true;
  console.log(`Received ${signal}; shutting down ExpenseFlow API.`);

  finishShutdown().catch((shutdownError: unknown) => {
    console.error("ExpenseFlow API shutdown failed.", shutdownError);
    process.exit(1);
  });
}

async function finishShutdown(): Promise<void> {
  await apiServer?.shutdown();
  await shutdownTelemetry();
  console.log("ExpenseFlow API shutdown complete.");
  process.exit(0);
}

process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
