import { defineConfig } from "vitest/config";

export default defineConfig({
  root: import.meta.dirname,
  test: {
    clearMocks: true,
    globalSetup: ["./test/setup/postgres-container.ts"],
    restoreMocks: true,
    setupFiles: ["./test/setup/database-cleanup.ts"]
  }
});
