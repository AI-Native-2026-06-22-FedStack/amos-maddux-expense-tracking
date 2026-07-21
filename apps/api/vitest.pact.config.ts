import { defineConfig } from "vitest/config";

export default defineConfig({
  root: import.meta.dirname,
  test: {
    clearMocks: true,
    fileParallelism: false,
    include: ["test/**/*.pact.test.ts"],
    restoreMocks: true
  }
});
