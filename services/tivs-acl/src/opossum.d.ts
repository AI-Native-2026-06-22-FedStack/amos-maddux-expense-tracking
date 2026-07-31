declare module "opossum" {
  export interface CircuitBreakerOptions {
    errorThresholdPercentage?: number;
    resetTimeout?: number;
    timeout?: number;
    volumeThreshold?: number;
  }

  export default class CircuitBreaker<TArgs extends unknown[], TResult> {
    constructor(action: (...args: TArgs) => Promise<TResult>, options?: CircuitBreakerOptions);
    fire(...args: TArgs): Promise<TResult>;
    opened: boolean;
  }
}
