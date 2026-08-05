import { defineConfig } from "vitest/config";

export default defineConfig({
  root: import.meta.dirname,
  test: {
    clearMocks: true,
    exclude: ["src/pact-provider.test.ts"],
    include: ["test/**/*.test.ts", "src/**/*.test.ts"],
    restoreMocks: true
  }
});
