import eslint from "@eslint/js";
import tseslint from "typescript-eslint";

export default tseslint.config(
  {
    ignores: [
      ".mypy_cache/**",
      ".pytest_cache/**",
      ".ruff_cache/**",
      ".uv-cache/**",
      ".uv-python/**",
      ".venv/**",
      "**/dist/**",
      "eslint.config.js",
      "node_modules/**",
      "packages/shared-schemas/*.d.ts",
      "packages/shared-schemas/*.js"
    ]
  },
  eslint.configs.recommended,
  ...tseslint.configs.strict,
  {
    languageOptions: {
      parserOptions: {
        projectService: {
          allowDefaultProject: [
            "vitest.config.ts",
            "scripts/*.mjs",
            "apps/api/healthcheck.js",
            "packages/shared-schemas/*.test.ts"
          ]
        },
        tsconfigRootDir: import.meta.dirname
      }
    },
    rules: {
      "@typescript-eslint/no-floating-promises": [
        "error",
        {
          ignoreVoid: false
        }
      ]
    }
  },
  {
    files: ["apps/api/healthcheck.js", "scripts/*.mjs"],
    languageOptions: {
      globals: {
        console: "readonly",
        process: "readonly",
        fetch: "readonly",
        setTimeout: "readonly"
      }
    }
  }
);
