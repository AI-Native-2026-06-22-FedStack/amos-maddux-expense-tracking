import { describe, expect, it, vi } from "vitest";

import { HealthController } from "./health-controller.js";
import type { ReadinessStatusRecord } from "../repository/health-repository.js";
import type { HealthService } from "../services/health-service.js";

describe("HealthController", () => {
  it("returns 503 when readiness dependencies are unavailable", async () => {
    const notReadyStatus: ReadinessStatusRecord = {
      service: "ExpenseFlow API",
      status: "not ready"
    };
    const service = {
      readStatus: vi.fn(),
      readReadiness: vi.fn(async () => notReadyStatus),
      throwSyntheticFailure: vi.fn((): never => {
        throw new Error("Synthetic test failure.");
      })
    } satisfies HealthService;
    const controller = new HealthController(service);
    const response = {
      status: vi.fn(() => ({
        json: vi.fn()
      }))
    };

    await controller.getReadiness({} as never, response as never);

    expect(response.status).toHaveBeenCalledWith(503);
    expect(response.status.mock.results[0]?.value.json).toHaveBeenCalledWith({
      service: "ExpenseFlow API",
      status: "not ready"
    });
  });
});
