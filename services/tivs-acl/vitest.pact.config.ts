import { defineConfig } from "vitest/config";

export default defineConfig({
  root: import.meta.dirname,
  test: {
    clearMocks: true,
    fileParallelism: false,
    include: ["src/**/*.pact-provider.test.ts", "src/pact-provider.test.ts"],
    restoreMocks: true
  }
});
