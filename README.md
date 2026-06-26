# ExpenseFlow

ExpenseFlow is an expense tracking repository governed by the local agent contract and data classification posture.

## Agent Contract

[AGENTS.md](AGENTS.md) is the repository-level instruction file for Codex and other AI agents working in ExpenseFlow. It defines the rules agents must follow before generating code, tests, examples, documentation, or operational output.

The contract covers:

- Data handling rules for controlled data, production data, secrets, and synthetic fixtures.
- Allowed application stacks: TypeScript with Express and Python with FastAPI.
- Forbidden stacks: Java, Spring, JPA, and MongoDB.
- Required ExpenseFlow vocabulary, including `Expense Report`, supported stages, and supported roles.
- Forbidden product scope, including payroll, tax filing, procurement, inventory, travel booking, banking, card issuing, and general ledger systems.

## Clean-Clone Setup

From a clean clone, a new engineer should reach a governed Codex session with these steps:

1. Clone the repository.

   ```sh
   git clone <repo-url>
   cd amos-maddux-expense-tracking
   ```

2. Confirm the repository governance files are present.

   ```sh
   test -f AGENTS.md
   test -f docs/data-classification.md
   test -f config.toml
   ```

3. Review the agent contract before asking Codex to change files.

   Read [AGENTS.md](AGENTS.md). It defines the allowed stacks, forbidden stacks, data-handling rules, ExpenseFlow vocabulary, and forbidden product scope.

4. Review the data classification posture.

   Read [docs/data-classification.md](docs/data-classification.md). Synthetic or PUBLIC data may enter prompts; real CUI/SBU data and secrets never do.

5. Start Codex from the repository root so it can load the local contract.

   ```sh
   codex
   ```

6. In the Codex session, verify the working directory is this repository and that requests follow the contract.

   ```sh
   pwd
   git status --short
   ```

7. Use only synthetic data in prompts, examples, tests, fixtures, logs, and documentation. Do not paste real customer data, production data, payment data, bank-feed transaction data, credentials, tokens, API keys, or private identifiers into Codex.

## Development Scripts

ExpenseFlow keeps the Python and Node stacks governed by documented setup and verification commands.

### Python

ExpenseFlow Python uses Python 3.13, selected by [.python-version](.python-version). Recreate the Python environment from the committed [uv.lock](uv.lock):

```sh
uv sync
```

Run the required Python quality gates with one command:

```sh
make check
```

`make check` runs Ruff first, strict mypy second, and pytest third. The target exits non-zero if any step fails.

### Node

ExpenseFlow requires Node.js `>=24.0.0`. Install dependencies with npm:

```sh
npm install
```

Use the documented Node project scripts from the repository root:

- `npm run build` compiles the TypeScript source with the strict `tsconfig.json` settings.
- `npm run lint` runs ESLint with zero warnings allowed and checks formatting with Prettier.
- `npm test` runs the Vitest test suite.
- `npm run check` runs build, lint, and tests as the full local verification workflow.

After building, run the async entrypoint with:

```sh
npm start
```

## Governance Links

- [AI-assistant guide](AGENTS.md)
- [Contribution workflow](CONTRIBUTING.md)
- [Data classification posture note](docs/data-classification.md)
- [ADR template](docs/adr/0000-template.md)
- [ADR-0001: Store Expense Report Case in PostgreSQL with Drizzle](docs/adr/0001-store-expense-report-case-in-postgresql-with-drizzle.md)
- [ADR-0002: Sprint-2 Polyglot Service Split](docs/adr/0002-sprint-2-polyglot-service-split.md)
