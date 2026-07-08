import inject from "light-my-request";
import { describe, expect, it } from "vitest";

import { createApp } from "../src/app.js";

describe("problemJsonErrorHandler", () => {
  it("returns an RFC 9457 Problem+JSON body for malformed create requests", async () => {
    const response = await inject(createApp(), {
      method: "POST",
      url: "/expense-reports",
      payload: {
        tenantId: "not-a-uuid",
        submitterId: ""
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
      detail: expect.stringContaining("tenantId"),
      instance: "/expense-reports"
    });
  });
});
