import inject from "light-my-request";
import { describe, expect, it } from "vitest";

import { createApp } from "../src/app.js";
import { issueTokenPair } from "../src/auth/tokens.js";

const tenantId = "00000000-0000-4000-8000-000000000701";
const userId = "synthetic-user-00000000-0000-4000-8000-000000000702";

describe("problemJsonErrorHandler", () => {
  it("returns an RFC 9457 Problem+JSON body for malformed create requests", async () => {
    const response = await inject(createApp(), {
      method: "POST",
      url: "/expense-reports",
      headers: {
        authorization: createAuthorizationHeader()
      },
      payload: {
        currentStage: "Invalid Stage"
      }
    });
    const body = response.json<Record<string, unknown>>();

    expect(response.statusCode).toBe(400);
    expect(response.headers["content-type"]).toContain("application/problem+json");
    expect(Object.keys(body).sort()).toEqual(
      ["detail", "instance", "status", "title", "type"].sort()
    );
    expect(body).toEqual({
      type: "/problems/request-validation",
      title: "Bad Request",
      status: 400,
      detail: expect.stringContaining("currentStage"),
      instance: "/expense-reports"
    });
  });
});

function createAuthorizationHeader(): string {
  const tokenPair = issueTokenPair({
    tenantId,
    userId,
    roles: ["Employee"]
  });

  return `Bearer ${tokenPair.accessToken}`;
}
