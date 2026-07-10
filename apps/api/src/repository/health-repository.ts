import { checkDatabaseReady } from "../db/client.js";
import {
  ComputeHealthClient,
  createComputeHealthClient
} from "../services/compute-health-client.js";

export interface ReadinessRequestContext {
  correlationId: string;
}

export interface ServiceStatusRecord {
  service: "ExpenseFlow API";
  status: "ok";
}

export interface ReadinessStatusRecord {
  service: "ExpenseFlow API";
  status: "ready" | "not ready";
}

export interface HealthRepository {
  readServiceStatus(): ServiceStatusRecord;
  readReadinessStatus(context: ReadinessRequestContext): Promise<ReadinessStatusRecord>;
}

class StaticHealthRepository implements HealthRepository {
  public constructor(private readonly computeHealthClient: ComputeHealthClient) {}

  public readServiceStatus(): ServiceStatusRecord {
    return {
      service: "ExpenseFlow API",
      status: "ok"
    };
  }

  public async readReadinessStatus(
    context: ReadinessRequestContext
  ): Promise<ReadinessStatusRecord> {
    const [isDatabaseReady, isComputeReady] = await Promise.all([
      checkDatabaseReady(),
      this.computeHealthClient.isReady(context)
    ]);

    return {
      service: "ExpenseFlow API",
      status: isDatabaseReady && isComputeReady ? "ready" : "not ready"
    };
  }
}

export function createHealthRepository(
  computeHealthClient: ComputeHealthClient = createComputeHealthClient()
): HealthRepository {
  return new StaticHealthRepository(computeHealthClient);
}
