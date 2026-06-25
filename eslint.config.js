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
      "dist/**",
      "eslint.config.js",
      "node_modules/**"
    ]
  },
  eslint.configs.recommended,
  ...tseslint.configs.strict,
  {
    languageOptions: {
      parserOptions: {
        projectService: {
          allowDefaultProject: ["vitest.config.ts"]
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
  }
);
