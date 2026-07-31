import { resolve } from "node:path";

import { MatchersV3, PactV4 } from "@pact-foundation/pact";
import { describe, expect, it } from "vitest";

import { createTivsAclClient } from "../src/services/tivs-acl-client.js";

const { boolean, equal, regex } = MatchersV3;

const consumerName = "ExpenseFlow Core Case Service";
const providerName = "ExpenseFlow TIVS ACL";
const correlationId = "synthetic-tivs-acl-pact-correlation-id";

const pact = new PactV4({
  consumer: consumerName,
  provider: providerName,
  dir: resolve(import.meta.dirname, "../../../pacts"),
  logLevel: "warn"
});

describe("Core Case Service TIVS ACL consumer pact", () => {
  it("validates an employer EIN through the ACL REST DTO", async () => {
    await pact
      .addInteraction()
      .given("TIVS has a matching active employer EIN")
      .uponReceiving("Core asks the TIVS ACL to verify an employer EIN")
      .withRequest("POST", "/v1/taxpayer-verifications", (builder) => {
        builder
          .headers({
            "content-type": "application/json",
            "x-correlation-id": equal(correlationId)
          })
          .jsonBody({
            legalName: equal("Synthetic Government Services LLC"),
            taxIdentifier: regex("^\\d{2}-\\d{7}$", "12-3456789"),
            taxIdentifierType: equal("ein")
          });
      })
      .willRespondWith(200, (builder) => {
        builder.headers({ "content-type": "application/json; charset=utf-8" }).jsonBody({
          matched: boolean(true),
          reason: equal("matched"),
          registeredName: equal("SYNTHETIC GOVERNMENT SERVICES LLC"),
          taxIdentifierType: equal("ein")
        });
      })
      .executeTest(async (mockServer) => {
        const client = createTivsAclClient({
          baseUrl: mockServer.url
        });

        await expect(
          client.validateEmployerEin({
            correlationId,
            employerEin: "12-3456789",
            employerLegalName: "Synthetic Government Services LLC"
          })
        ).resolves.toEqual({
          checked: true,
          matched: true,
          reason: "matched",
          registeredName: "SYNTHETIC GOVERNMENT SERVICES LLC"
        });
      });
  });
});
