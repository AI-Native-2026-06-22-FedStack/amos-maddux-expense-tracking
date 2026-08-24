# ADR-0029: AI Assist Scope and Gates

## Status

Accepted.

## Context

ExpenseFlow now has an AI Assist feature for policy questions. The feature
uses the retrieval-owned policy corpus from ADR-0028, the FastAPI compute
service's existing `/v1/...` routing convention, Module 3-style redaction
before model calls, structured output validation, and separate quality and
security gates.

The implementation evidence for this ADR is recorded in:

- `evidence/m9d4-ai-assist-architecture.md`
- `evidence/m9d4-ragas-quality.md`
- `evidence/m9d3-retrieval.md`

## Decision

AI Assist answers natural-language questions about applicable ExpenseFlow
policy. It may describe policy requirements, cite the retrieved policy chunks
that support the answer, and state when the retrieved excerpts do not provide
enough information.

AI Assist does not approve, reject, submit, edit, pay, reconcile, or otherwise
act on an Expense Report. It is not an autonomous approval engine and must not
be treated as one by backend routes, prompts, frontend copy, or future workflow
integrations.

### Embedding Tier

The implemented corpus embedding tier remains:

- Model: `text-embedding-3-small`
- Dimensions: 1536
- Storage: `retrieval.corpus_chunk.embedding vector(1536)`
- Dense distance operator: `<=>` cosine distance
- HNSW operator class: `vector_cosine_ops`

This preserves the M9D3 retrieval contract and matches
`services/retrieval/retrieval.toml`.

`text-embedding-3-large` provides 3072-dimensional embeddings. Current OpenAI
model documentation lists `text-embedding-3-small` at $0.02 per 1M input tokens
and `text-embedding-3-large` at $0.13 per 1M input tokens, so large is 6.5x the
embedding-token cost before considering larger vectors' storage, memory, and
index costs. OpenAI's embedding model announcement also describes large as the
stronger retrieval-quality model, but no ExpenseFlow benchmark has been run
that proves a quality gain on the current 43-chunk synthetic corpus.

At the current corpus size, `text-embedding-3-small` is the right default:
retrieval quality is dominated by chunk design, tenant filtering, literal
section-id handling, RRF fusion, and reranking, not by capacity limits in a
large vector space. The implemented full-set RAGAS result also points primarily
at generation quality for faithfulness/answer relevancy and not at context
precision, which passed.

pgvector's standard indexed `vector` type supports HNSW indexing up to 2000
dimensions. A native 3072-dimensional `text-embedding-3-large` vector therefore
does not fit the implemented `vector(1536)`/`vector_cosine_ops` index design.
To HNSW-index 3072-dimensional embeddings without shortening them, a future
migration would need a half-precision representation such as `halfvec(3072)`
and the matching cosine operator class, such as `halfvec_cosine_ops`, rather
than the current `vector_cosine_ops`.

If the corpus grows to approximately 100x its current size, the next tier I
would choose is `text-embedding-3-large` stored/indexed as `halfvec(3072)` with
the matching HNSW cosine operator class, but only after re-embedding a measured
sample and re-baselining retrieval and RAGAS quality. At that size, additional
semantic capacity is more likely to matter for near-duplicate policy sections
and broader vocabulary, while the one-time embedding cost is still small
relative to the risk of misleading policy answers. The storage/index migration
is the main added complexity.

### HNSW Index

The HNSW migration is
`apps/api/db/migrations/0004_policy_corpus_embedding_hnsw.sql`.

It creates `corpus_chunk_embedding_hnsw_idx` on
`retrieval.corpus_chunk.embedding` using `vector_cosine_ops` with
`m = 8` and `ef_construction = 32`. Those parameters keep build cost low for
the present small corpus while preserving the production query shape. They are
deliberately conservative and should be revisited with recall/latency evidence
as the corpus grows.

Local evidence shows a subtle planner result: the HNSW index is valid and used
for the nearest-neighbor `ORDER BY embedding <=> ... LIMIT` shape, but the
exact tenant-filtered dense query over the 43-row corpus still chooses the
tenant btree index plus a top-N sort because every current row belongs to the
same tenant. That limitation is documented in evidence rather than hidden.

### Quality Gates

The RAGAS gate evaluates exactly:

- `faithfulness >= 0.85`
- `answer_relevancy >= 0.85`
- `context_precision >= 0.80`

These are independent gates in `services/retrieval/eval/ragas_gate.py`; they
are not averaged into one quality score.

Configured judge family: `gpt-4o-mini`

Resolved judge model ID for the completed full-set run: not reported by RAGAS
token usage for that run.

Resolved rerank model ID exposed by the implementation and retrieval evidence:
`gpt-4o-mini-2024-07-18`.

Changing the judge model requires re-baselining thresholds because LLM-as-judge
scores are model-dependent. A threshold calibrated against one judge family or
snapshot is not guaranteed to mean the same thing under another judge.

The completed full reviewed-set run did not pass all gates:

- faithfulness: 0.7804, threshold 0.8500, FAIL
- answer relevancy: 0.7361, threshold 0.8500, FAIL
- context precision: 0.9767, threshold 0.8000, PASS

The likely failing stage is answer generation rather than retrieval/reranking,
because context precision passed with margin while faithfulness and answer
relevancy missed.

### Context Recall

Context recall would measure whether all ground-truth supporting information
needed to answer each question appeared in the retrieved contexts. It would add
diagnostic value by distinguishing "the retriever failed to fetch needed
support" from "the generator failed despite having support."

It is not computed in the current gated evaluation because it adds judge cost
and the present implementation already has independent context precision plus
human-reviewed relevant chunk labels. The current failure pattern does not yet
justify paying for another gated metric on every CI run.

Enable context recall when either the corpus grows materially, context
precision drops near its threshold, users report missing-support answers, or a
retrieval/reranking change needs finer diagnosis than precision alone gives.

### CI and Evaluation Execution

The production-correct design is a required AI-quality CI check that runs the
full reviewed evaluation set, not only the smoke set, and fails independently
on any missed metric. `.github/workflows/ai-quality.yml` represents that
design by running `services/retrieval/eval/eval_set.jsonl`.

During this implementation exercise, the paid full evaluation was run locally
and its output was committed under `evidence/`. This is a deliberate cost
concession for reviewability in a learning environment. The recommended
long-term production posture is to let the required CI/deployment path own the
official full-set result and to avoid repeatedly running paid full evaluations
manually.

### Security Policy

Prompt-injection regression tests live under `services/retrieval/safety/` and
are separate from RAGAS quality tests under `services/retrieval/eval/`.

The security suite covers direct instruction overrides, hidden instruction
extraction attempts, cross-tenant access attempts, out-of-scope action
attempts, and an indirect attack delivered through retrieved synthetic corpus
content. The indirect test proves the malicious instruction appears in
retrieved context and verifies the assistant does not obey it.

Model output is accepted only through the structured JSON contract in
`services/retrieval/safety/validator.py`. Every citation must identify a chunk
that was present in the retrieved result set for that exact query, including
matching source and section metadata. Validation fails closed: malformed JSON,
missing fields, wrong field types, or fabricated citations raise
`OutputValidationError`, and the API converts that into a controlled failure
instead of returning the model output.

### Cost and Latency Budget

The acceptable per-call budget for an interactive `/v1/assist` request is
$0.02 at current model pricing, excluding offline evaluation. The acceptable
end-to-end latency budget is 10 seconds for this synchronous implementation.

Measured successful `/v1/assist` invocation:

- Question: "How many days after the expense date does an employee have to
  submit an Expense Report?"
- Resolved generation model ID: `gpt-4o-mini-2024-07-18`
- Input tokens: 1353
- Output tokens: 112
- Derived generation cost: $0.00027015
- Measured end-to-end route latency: 8261.276807985269 ms
- Rerank resolved model ID: `gpt-4o-mini-2024-07-18`
- Rerank API requests for the measured direct pipeline run: 0, served from
  cache

The endpoint audit record currently includes generation cost from measured
chat-completion usage. The query-embedding call is made by the route but its
token count is not currently included in the endpoint audit record; that is a
known instrumentation gap.

Measured full RAGAS run cost:

- Judge calls: 200
- Input tokens: 181,502
- Output tokens: 16,404
- Derived judge cost: $0.0370677

Evidence-covered measured API spend for the official full RAGAS run plus the
successful live `/v1/assist` generation call is $0.03733785, under the program
target of $3. This does not claim to include earlier exploratory model calls
that were not instrumented with measured usage.

## Alternatives Considered

**Let AI Assist approve or reject Expense Reports.** Rejected. That would move
AI Assist from explanatory policy support into workflow authority, contradict
the feature scope, and require a different risk model.

**Switch immediately to `text-embedding-3-large`.** Rejected for the current
corpus. No ExpenseFlow benchmark demonstrates a retrieval-quality gain on 43
chunks, and using full 3072-dimensional vectors would require a different
indexed storage representation.

**Average RAGAS metrics into one score.** Rejected. A high context precision
score must not mask low faithfulness or low answer relevancy.

**Treat prompt-injection safety as part of the RAGAS score.** Rejected. Safety
regressions are behavioral security failures, not quality-score deltas, and
must remain a separate suite.

**Strip invalid model output and return a best-effort answer.** Rejected. The
validator is designed to fail closed so fabricated citations and malformed
contracts cannot reach users.

## Consequences

AI Assist is usable as a cited policy explainer, but it is not deployment-ready
as a required quality-gated feature until the full reviewed-set RAGAS failures
are addressed without weakening thresholds or labels.

The implemented HNSW migration prepares the dense vector path for growth while
the current tiny tenant-scoped corpus can still produce non-HNSW plans. Future
performance work should use larger tenant-distributed data before tuning HNSW
parameters.

Keeping RAGAS quality gates, prompt-injection tests, and output validation
separate makes failures easier to diagnose and prevents one kind of success
from hiding another kind of risk.

The current audit path uses structured logs because the existing database
audit schema is Expense Report scoped and cannot represent a general policy
assistant invocation without inventing an `expense_report_id`. A future
append-only AI-call audit table is appropriate if log retention/queryability is
not sufficient for compliance review.

The route now has real measured latency and generation cost, but full per-call
AI cost accounting should be extended to include embedding and uncached rerank
usage before production budgeting depends on the audit record.
