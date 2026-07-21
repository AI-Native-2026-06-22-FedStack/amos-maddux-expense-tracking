import { defineConfig } from "vitest/config";

export default defineConfig({
  root: import.meta.dirname,
  test: {
    clearMocks: true,
    fileParallelism: false,
    globalSetup: ["./test/setup/postgres-container.ts"],
    include: ["test/expense-report-submit-transition-slice.test.ts"],
    restoreMocks: true,
    setupFiles: ["./test/setup/database-cleanup.ts"],
    coverage: {
      provider: "v8",
      reporter: ["text"],
      include: [
        "src/controllers/expense-report-controller.ts",
        "src/engine/gl-client.ts",
        "src/repository/expense-report-repository.ts",
        "src/routes/expense-report-routes.ts",
        "src/services/expense-report-service.ts"
      ],
      thresholds: {
        lines: 70,
        branches: 60
      }
    }
  }
});
