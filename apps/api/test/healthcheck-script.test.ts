import { execFile } from "node:child_process";
import http from "node:http";
import { fileURLToPath } from "node:url";

import { afterEach, describe, expect, it } from "vitest";

const healthcheckScript = fileURLToPath(new URL("../healthcheck.js", import.meta.url));
let server: http.Server | undefined;

afterEach(async () => {
  if (server === undefined) {
    return;
  }

  await new Promise<void>((resolve, reject) => {
    server?.close((error) => {
      if (error !== undefined) {
        reject(error);
        return;
      }

      resolve();
    });
  });
  server = undefined;
});

describe("healthcheck script", () => {
  it("exits successfully when readiness returns 200", async () => {
    const port = await listenWithStatus(200);

    await expect(runHealthcheck(port)).resolves.toBe(0);
  });

  it("fails when readiness returns 503", async () => {
    const port = await listenWithStatus(503);

    await expect(runHealthcheck(port)).resolves.toBe(1);
  });

  it("fails when readiness does not respond", async () => {
    server = http.createServer((_request, _response) => undefined);
    const port = await listen(server);

    await expect(runHealthcheck(port)).resolves.toBe(1);
  });
});

async function listenWithStatus(statusCode: number): Promise<number> {
  server = http.createServer((_request, response) => {
    response.writeHead(statusCode, { "content-type": "application/json" });
    response.end(JSON.stringify({ status: statusCode === 200 ? "ready" : "not ready" }));
  });

  return listen(server);
}

function listen(serverToStart: http.Server): Promise<number> {
  return new Promise((resolve) => {
    serverToStart.listen(0, "127.0.0.1", () => {
      const address = serverToStart.address();
      resolve(typeof address === "object" && address !== null ? address.port : 0);
    });
  });
}

function runHealthcheck(port: number): Promise<number> {
  return new Promise((resolve) => {
    execFile(
      process.execPath,
      [healthcheckScript],
      {
        env: {
          ...process.env,
          PORT: port.toString()
        }
      },
      (error) => {
        if (error !== null && "code" in error && typeof error.code === "number") {
          resolve(error.code);
          return;
        }

        resolve(0);
      }
    );
  });
}
