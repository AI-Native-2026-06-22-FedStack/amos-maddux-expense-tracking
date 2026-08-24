# 0013 — M9D4: AI Assist Scope and Gates

- **_Problem:_** Build ExpenseFlow AI Assist as a cited policy-question
  feature without letting it become an approval engine, and gate it with
  retrieval-aware quality checks, prompt-injection regressions, fail-closed
  structured-output validation, and measured cost/latency evidence.

- **_Asked:_** Across the deliverable, inspect the existing retrieval stack;
  add an HNSW index for the current policy-chunk embedding search; finalize
  reviewed RAG evaluation sets; implement a reusable RAGAS gate over the real
  retrieval/rerank/generation path; prove or record the smoke red/green
  regression state; add a separate prompt-injection safety suite including an
  indirect corpus attack; implement a fail-closed output validator; expose
  `/v1/assist` through the existing FastAPI service with redaction, auth,
  retrieval, reranking, generation, validation, audit, cost, and latency; wire
  the React `AssistPanel`; and document the architecture in ADR-0029.

- **_Produced:_** `apps/api/db/migrations/0004_policy_corpus_embedding_hnsw.sql`;
  reviewed eval files and RAGAS gate code under `services/retrieval/eval/`;
  safety tests and validator under `services/retrieval/safety/`;
  FastAPI assist orchestration under `services/compute/app/assist.py` and
  `/v1/assist` in `services/compute/app/main.py`; React API/panel wiring under
  `apps/web/src/api/useAssist.ts`, `apps/web/src/components/AssistPanel.tsx`,
  and `apps/web/src/routes/router.tsx`; evidence in
  `evidence/m9d4-ragas-quality.md` and
  `evidence/m9d4-ai-assist-architecture.md`; and
  `docs/adr/0029-ai-assist-scope-and-gates.md`.

- **_Accepted / Rejected — key decisions and why:_**

  ACCEPTED: keep `text-embedding-3-small` at 1536 dimensions for the current
  corpus. It matches the existing `vector(1536)` storage, the configured
  embedding tier, and the implemented dense query. `text-embedding-3-large`
  was documented as a future option, but not adopted without an ExpenseFlow
  benchmark and a `halfvec(3072)`/matching-opclass migration.

  ACCEPTED with evidence caveat: add the HNSW index using `vector_cosine_ops`
  and conservative `m = 8`, `ef_construction = 32`. The index is valid and
  usable for the nearest-neighbor cosine order-by shape, but the exact
  tenant-filtered dense query over the current 43-row corpus still plans
  through the tenant btree plus sort. The ADR records that nuance rather than
  overstating planner behavior.

  ACCEPTED: make RAGAS gates independent. Faithfulness, answer relevancy, and
  context precision each fail or pass on their own; no averaged score can hide
  a weak metric. The full reviewed-set run failed faithfulness and answer
  relevancy while passing context precision, pointing at generation as the
  likely failing stage.

  REJECTED: forcing the requested smoke red/green proof after the baseline
  smoke run was already red. No thresholds, prompts, labels, or evaluator logic
  were weakened to manufacture a clean demonstration.

  ACCEPTED: keep prompt-injection tests physically separate from RAGAS quality
  tests. The suite includes direct attacks and a controlled indirect corpus
  injection whose malicious instruction is actually retrieved through the real
  retrieval path.

  ACCEPTED: fail closed on structured output. The validator rejects malformed
  JSON and citations that were not in the query's retrieved chunk set. The API
  returns a controlled failure instead of trimming errors or passing through
  plausible but fabricated citations.

  ACCEPTED with follow-up: use structured AI-assist audit logs instead of the
  existing database audit table, because the current audit schema is Expense
  Report scoped and requires an `expense_report_id`. ADR-0029 records a future
  append-only AI-call table as the likely production improvement if log
  retention/queryability is insufficient.

- **_Verification discipline:_** measurements were re-run against the current
  branch before ADR-0029 was written: focused safety tests passed, focused
  assist tests passed, the React assist panel test passed, a synthetic
  `/v1/assist` request completed successfully with measured generation usage
  and latency, and the existing full reviewed-set RAGAS evidence was preserved
  as a failing gate rather than rewritten into a passing result.
