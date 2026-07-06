import {
  HealthRepository,
  ReadinessStatusRecord,
  ServiceStatusRecord,
  createHealthRepository
} from "../repository/health-repository.js";

export interface HealthService {
  readStatus(): ServiceStatusRecord;
  readReadiness(): Promise<ReadinessStatusRecord>;
  throwSyntheticFailure(): never;
}

class RepositoryHealthService implements HealthService {
  public constructor(private readonly healthRepository: HealthRepository) {}

  public readStatus(): ServiceStatusRecord {
    return this.healthRepository.readServiceStatus();
  }

  public readReadiness(): Promise<ReadinessStatusRecord> {
    return this.healthRepository.readReadinessStatus();
  }

  public throwSyntheticFailure(): never {
    throw new Error("Synthetic health route failure.");
  }
}

export function createHealthService(
  healthRepository: HealthRepository = createHealthRepository()
): HealthService {
  return new RepositoryHealthService(healthRepository);
}
