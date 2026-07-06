import { checkDatabaseReady } from "../db/client.js";

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
  readReadinessStatus(): Promise<ReadinessStatusRecord>;
}

class StaticHealthRepository implements HealthRepository {
  public readServiceStatus(): ServiceStatusRecord {
    return {
      service: "ExpenseFlow API",
      status: "ok"
    };
  }

  public async readReadinessStatus(): Promise<ReadinessStatusRecord> {
    const isReady = await checkDatabaseReady();

    return {
      service: "ExpenseFlow API",
      status: isReady ? "ready" : "not ready"
    };
  }
}

export function createHealthRepository(): HealthRepository {
  return new StaticHealthRepository();
}
