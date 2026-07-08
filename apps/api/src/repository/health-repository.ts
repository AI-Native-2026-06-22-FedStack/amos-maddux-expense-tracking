export interface ServiceStatusRecord {
  service: "ExpenseFlow API";
  status: "ok";
}

export interface HealthRepository {
  readServiceStatus(): ServiceStatusRecord;
}

class StaticHealthRepository implements HealthRepository {
  public readServiceStatus(): ServiceStatusRecord {
    return {
      service: "ExpenseFlow API",
      status: "ok"
    };
  }
}

export function createHealthRepository(): HealthRepository {
  return new StaticHealthRepository();
}
