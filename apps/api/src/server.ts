import { createServer } from "node:http";

import { createApp } from "./app.js";

const defaultPort = 3000;
const port = Number.parseInt(process.env.PORT ?? String(defaultPort), 10);
const app = createApp();
const server = createServer(app);

server.listen(port, () => {
  console.log(`ExpenseFlow API listening on port ${port}.`);
});

function shutdown(signal: NodeJS.Signals): void {
  console.log(`Received ${signal}; shutting down ExpenseFlow API.`);

  server.close((error) => {
    if (error !== undefined) {
      console.error("ExpenseFlow API shutdown failed.", error);
      process.exit(1);
    }

    console.log("ExpenseFlow API shutdown complete.");
    process.exit(0);
  });
}

process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
