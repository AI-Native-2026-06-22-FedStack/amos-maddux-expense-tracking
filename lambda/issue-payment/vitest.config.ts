import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    clearMocks: true,
    include: ["test/**/*.test.ts"],
    restoreMocks: true,
    setupFiles: ["test/setup.ts"]
  }
});
