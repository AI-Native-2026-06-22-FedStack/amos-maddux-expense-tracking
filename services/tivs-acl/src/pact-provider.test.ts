import { createServer, type Server } from "node:http";
import { resolve } from "node:path";

import { Verifier } from "@pact-foundation/pact";
import { afterEach, describe, expect, it, vi } from "vitest";

import { createTivsAclApp } from "./app.js";
import type {
  ExpenseFlowTaxpayerVerificationGateway,
  TaxpayerStandingRequest,
  TaxpayerVerificationRequest
} from "./index.js";

const consumerName = "ExpenseFlow Core Case Service";
const providerName = "ExpenseFlow TIVS ACL";

let providerState = "default";

describe("TIVS ACL Pact provider", () => {
  let server: Server | undefined;

  afterEach(async () => {
    await closeServer(server);
    server = undefined;
    providerState = "default";
  });

  it("satisfies the Core Case Service consumer contract", async () => {
    const runningProvider = await startProvider();
    server = runningProvider.server;

    await expect(
      new Verifier({
        provider: providerName,
        providerBaseUrl: runningProvider.url,
        pactUrls: [
          resolve(
            import.meta.dirname,
            "../../../pacts/ExpenseFlow Core Case Service-ExpenseFlow TIVS ACL.json"
          )
        ],
        stateHandlers: {
          "TIVS has a matching active employer EIN": () => {
            providerState = "matching-employer-ein";
            return Promise.resolve();
          }
        },
        logLevel: "warn"
      }).verifyProvider()
    ).resolves.toContain("finished");
  });
});

async function startProvider(): Promise<{ server: Server; url: string }> {
  const gateway = createFakeGateway();
  const server = createServer(createTivsAclApp(gateway));

  await new Promise<void>((resolve) => {
    server.listen(0, "127.0.0.1", resolve);
  });

  const address = server.address();

  if (address === null || typeof address === "string") {
    throw new Error("Synthetic provider did not bind to a TCP port.");
  }

  return {
    server,
    url: `http://127.0.0.1:${address.port}`
  };
}

function createFakeGateway(): ExpenseFlowTaxpayerVerificationGateway {
  return {
    getTaxpayerStanding: vi.fn(async (_request: TaxpayerStandingRequest) => ({
      asOf: new Date("2026-01-15T00:00:00.000Z"),
      standing: "active" as const,
      taxIdentifierType: "ein" as const
    })),
    verifyTaxpayer: vi.fn(async (_request: TaxpayerVerificationRequest) => {
      if (providerState === "matching-employer-ein") {
        return {
          matched: true,
          reason: "matched" as const,
          registeredName: "SYNTHETIC GOVERNMENT SERVICES LLC",
          taxIdentifierType: "ein" as const
        };
      }

      return {
        matched: false,
        reason: "tin-not-found" as const,
        taxIdentifierType: "ein" as const
      };
    })
  };
}

function closeServer(server: Server | undefined): Promise<void> {
  if (server === undefined) {
    return Promise.resolve();
  }

  return new Promise((resolve, reject) => {
    server.close((error) => {
      if (error !== undefined) {
        reject(error);
        return;
      }

      resolve();
    });
  });
}
