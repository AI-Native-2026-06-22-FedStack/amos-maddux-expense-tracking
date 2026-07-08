# ADR-0003: Drizzle as the Data Access Layer

## Status

Accepted

## Context

The ExpenseFlow service requires a data-access layer that integrates well with TypeScript while preserving PostgreSQL's capabilities. As the project grows, maintaining separate SQL schemas, TypeScript interfaces, validation schemas, and repository types increases duplication and the risk that they drift out of sync. The project also requires forward-only database migrations, tenant-scoped queries, and strong compile-time type safety.

Drizzle provides a TypeScript-first approach where the database schema is defined once in code. From that schema, TypeScript row types can be inferred, migrations can be generated, and API validation schemas can be derived using `drizzle-zod`. This reduces duplication while keeping the database schema, application types, and validation logic synchronized.

## Decision

Use Drizzle ORM as the project's data-access layer.

Database tables will be defined in a single `schema.ts` file using `pgTable`. That schema will serve as the single source of truth for the database structure. Repository methods will use Drizzle's query builder instead of raw SQL, inferred `$inferSelect` and `$inferInsert` types will replace hand-written interfaces, and request/response DTOs will be generated with `drizzle-zod`.

Database schema changes will be managed through Drizzle's forward-only generated migrations.

## Alternatives Considered

* **Raw SQL with node-postgres:** Rejected because it requires maintaining SQL, TypeScript types, and validation schemas separately, increasing duplication and the risk of schema drift while providing less type safety during development.
* **Prisma:** Rejected because Prisma relies on a separate schema definition and code generation step to produce the TypeScript client. Drizzle instead defines the schema directly in TypeScript, allowing table definitions, inferred row types, generated migrations, and `drizzle-zod` DTOs to all derive from the same source without a separate generation workflow. This reduces duplication, simplifies the development workflow, and makes it easier to keep the database schema and application types synchronized.
## Consequences


POSITIVE: The database schema becomes the single source of truth. TypeScript row types, insert types, and `drizzle-zod` validation schemas are derived from the table definitions, reducing duplicated code and minimizing schema drift.

POSITIVE: Repository code benefits from compile-time type safety while retaining direct access to PostgreSQL features and expressive SQL through Drizzle's query builder. Forward-only generated migrations also provide a consistent workflow for evolving the schema.

NEGATIVE: Drizzle has a smaller ecosystem and community than more established ORMs such as Prisma, which means fewer third-party resources, examples, and integrations are available. **Mitigation:** Rely on the official Drizzle documentation and favor well-supported core features over community extensions.

NEGATIVE: Drizzle does not generate automatic down (rollback) migrations. Reverting a schema change requires creating a new forward migration rather than rolling back an existing one. **Mitigation:** Treat migrations as immutable, thoroughly test them against Testcontainers before merging, and use roll-forward repair when changes are needed.

NEGATIVE: AI coding assistants generally have weaker prior knowledge of Drizzle than older frameworks such as Prisma, increasing the likelihood of incorrect suggestions or outdated patterns. **Mitigation:** Verify all AI-generated Drizzle code against the official documentation and validate schema changes with `drizzle-kit check` and integration tests before merging.
