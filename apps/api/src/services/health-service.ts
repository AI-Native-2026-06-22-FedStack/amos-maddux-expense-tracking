import {
  HealthRepository,
  ServiceStatusRecord,
  createHealthRepository
} from "../repository/health-repository.js";

export interface HealthService {
  readStatus(): ServiceStatusRecord;
  throwSyntheticFailure(): never;
}

class RepositoryHealthService implements HealthService {
  public constructor(private readonly healthRepository: HealthRepository) {}

  public readStatus(): ServiceStatusRecord {
    return this.healthRepository.readServiceStatus();
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
