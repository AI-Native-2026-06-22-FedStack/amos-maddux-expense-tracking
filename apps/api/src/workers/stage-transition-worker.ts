import {
  createStageTransitionConsumerDependencies,
  runStageTransitionConsumer
} from "../events/stage-transition-consumer.js";

const abortController = new AbortController();

process.once("SIGINT", () => abortController.abort());
process.once("SIGTERM", () => abortController.abort());

const dependencies = await createStageTransitionConsumerDependencies();

try {
  await runStageTransitionConsumer({
    ...dependencies,
    signal: abortController.signal
  });
} finally {
  await dependencies.redis.quit?.();
}
