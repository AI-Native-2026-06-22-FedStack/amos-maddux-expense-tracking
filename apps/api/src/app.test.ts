import inject from "light-my-request";
import { describe, expect, it } from "vitest";

import { createApp } from "./app.js";

describe("createApp", () => {
  const validCreateRequest = {
    tenantId: "00000000-0000-4000-8000-000000000301",
    submitterId: "synthetic-submitter-00000000-0000-4000-8000-000000000302"
  };

  it("returns the service status body from GET /health", async () => {
    const response = await inject(createApp(), {
      method: "GET",
      url: "/health"
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({
      service: "ExpenseFlow API",
      status: "ok"
    });
  });

  it("serves the generated OpenAPI document", async () => {
    const response = await inject(createApp(), {
      method: "GET",
      url: "/openapi.json"
    });

    expect(response.statusCode).toBe(200);
    expect(response.headers["content-type"]).toContain("application/json");
    expect(response.json()).toMatchObject({
      openapi: "3.1.0",
      paths: {
        "/expense-reports": expect.any(Object),
        "/expense-reports/{id}": expect.any(Object)
      }
    });
  });

  it("renders the API docs page", async () => {
    const response = await inject(createApp(), {
      method: "GET",
      url: "/docs"
    });

    expect(response.statusCode).toBe(200);
    expect(response.headers["content-type"]).toContain("text/html");
    expect(response.body).toContain("/openapi.json");
  });

  it("returns a 404 response for unmatched routes", async () => {
    const response = await inject(createApp(), {
      method: "GET",
      url: "/missing-route"
    });

    expect(response.statusCode).toBe(404);
    expect(response.json()).toEqual({
      type: "/problems/not-found",
      title: "Not Found",
      status: 404,
      detail: "Route not found.",
      instance: "/missing-route"
    });
  });

  it("routes thrown errors to the final error handler", async () => {
    const response = await inject(createApp(), {
      method: "GET",
      url: "/health/error"
    });

    expect(response.statusCode).toBe(500);
    expect(response.json()).toEqual({
      type: "/problems/internal-server-error",
      title: "Internal Server Error",
      status: 500,
      detail: "An unexpected server error occurred.",
      instance: "/health/error"
    });
    expect(response.body).not.toContain("Synthetic health route failure.");
    expect(response.body).not.toContain("stack");
  });

  it("creates a Drafted Expense Report from a valid request", async () => {
    const response = await inject(createApp(), {
      method: "POST",
      url: "/expense-reports",
      payload: validCreateRequest
    });
    const report = response.json<{
      id: string;
      tenantId: string;
      submitterId: string;
      stage: string;
      priority: string;
      dueDate: string | null;
      onHold: boolean;
      holdReason: string | null;
      createdAt: string;
      updatedAt: string;
    }>();

    expect(response.statusCode).toBe(201);
    expect(report).toMatchObject({
      tenantId: validCreateRequest.tenantId,
      submitterId: validCreateRequest.submitterId,
      stage: "Drafted",
      priority: "Normal",
      dueDate: null,
      onHold: false,
      holdReason: null
    });
    expect(report.id).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u
    );
    expect(new Date(report.createdAt).toISOString()).toBe(report.createdAt);
    expect(new Date(report.updatedAt).toISOString()).toBe(report.updatedAt);
  });

  it("rejects invalid Expense Report create bodies before creation", async () => {
    const response = await inject(createApp(), {
      method: "POST",
      url: "/expense-reports",
      payload: {
        tenantId: "not-a-uuid",
        submitterId: ""
      }
    });

    expect(response.statusCode).toBe(400);
    expect(response.json()).toEqual({
      type: "/problems/request-validation",
      title: "Bad Request",
      status: 400,
      detail: expect.stringContaining("tenantId"),
      instance: "/expense-reports"
    });
  });

  it("reads an Expense Report after creation", async () => {
    const app = createApp();
    const createResponse = await inject(app, {
      method: "POST",
      url: "/expense-reports",
      payload: validCreateRequest
    });
    const createdReport = createResponse.json<{ id: string }>();

    const readResponse = await inject(app, {
      method: "GET",
      url: `/expense-reports/${createdReport.id}`
    });

    expect(readResponse.statusCode).toBe(200);
    expect(readResponse.json()).toEqual(createResponse.json());
  });

  it("rejects invalid Expense Report id params", async () => {
    const response = await inject(createApp(), {
      method: "GET",
      url: "/expense-reports/not-a-uuid"
    });

    expect(response.statusCode).toBe(400);
    expect(response.json()).toEqual({
      type: "/problems/request-validation",
      title: "Bad Request",
      status: 400,
      detail: expect.stringContaining("id"),
      instance: "/expense-reports/not-a-uuid"
    });
  });

  it("returns 404 for an unknown valid Expense Report id", async () => {
    const response = await inject(createApp(), {
      method: "GET",
      url: "/expense-reports/00000000-0000-4000-8000-000000000399"
    });

    expect(response.statusCode).toBe(404);
    expect(response.json()).toEqual({
      type: "/problems/not-found",
      title: "Not Found",
      status: 404,
      detail: "Expense Report not found.",
      instance: "/expense-reports/00000000-0000-4000-8000-000000000399"
    });
  });
});
