import { defineConfig } from "vitest/config";

export default defineConfig({
  root: import.meta.dirname,
  test: {
    clearMocks: true,
    include: ["test/**/*.test.ts", "src/**/*.test.ts"],
    restoreMocks: true
  }
});
