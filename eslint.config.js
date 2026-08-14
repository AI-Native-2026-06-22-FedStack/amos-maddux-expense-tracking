import eslint from "@eslint/js";
import security from "eslint-plugin-security";
import noSecrets from "eslint-plugin-no-secrets";
import tseslint from "typescript-eslint";

export default tseslint.config(
  {
    ignores: [
      ".mypy_cache/**",
      ".pytest_cache/**",
      ".ruff_cache/**",
      ".semgrep/fixtures/**",
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
  },
  {
    files: ["apps/api/**/*.ts"],
    ignores: ["apps/api/**/*.test.ts"],
    plugins: {
      security,
      "no-secrets": noSecrets
    },
    rules: {
      ...security.configs.recommended.rules,
      "no-secrets/no-secrets": "error"
    }
  }
);
