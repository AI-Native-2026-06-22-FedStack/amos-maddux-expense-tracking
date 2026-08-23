# 0017 — LLM Reranker for the 12 Eval Questions

- **_Problem:_** Implement `services/retrieval/rerank.py`: rerank each of
  the 12 evaluation questions' baseline top-10 (from `eval/rankings.jsonl`)
  using the configured reranker model family (gpt-4o-mini), ONE model
  request per question carrying the entire numbered candidate list (never
  one request per candidate), never reusing the original RRF fused score
  as the reranking judgment, with safe ID-to-candidate mapping and output
  validation, cached under `.cache/rerank/` keyed by everything that can
  materially change the result, and the resolved model ID (not just the
  configured alias) captured and locked per run.

- **_Produced:_** `services/retrieval/rerank.py` (`Candidate`,
  `Reranker`, `validate_ranked_ids`, `rerank_cache_key`,
  `RerankValidationError`, `ResolvedModelMismatchError`),
  `services/retrieval/eval/run_rerank.py` (reads `eval/rankings.jsonl`'s
  baseline records, reranks each, writes `reranked` +
  `rerank_config` back into the same records), `services/retrieval/tests/test_rerank.py`
  (23 tests against a fake OpenAI client -- one-request-per-question,
  malformed-output rejection, resolved-model-id capture/mismatch,
  cache-key completeness across every required input, and cross-run cache
  reuse).

- **_Real bug found and fixed via an actual second/third run, not just
  reading the code:_** the first cold run correctly made 12 API requests
  (one per question) and cached all 12. A second run of the SAME script
  should have been able to serve every question from cache -- but still
  made 1 real API call, because `Reranker.resolved_model_id` starts at
  `None` for every fresh instance, and the cache key depends on
  `resolved_model_id`, so a brand-new process had no way to attempt a
  cache lookup before its first API call, every single run. Verified
  this directly (`api_requests=1, cache_hits=11` on run 2, not
  `api_requests=0, cache_hits=12`). Asked the user how to resolve this
  before changing anything; chose seeding a fresh run's first cache
  lookup from a small persisted `last_resolved_model_id.<family>.json`
  file, written after every real API call -- a GUESS, never trusted as
  correctness: if the guess is wrong (OpenAI resolved the alias
  differently since), the lookup simply misses and normal API-call
  behavior takes over unchanged. After the fix, a third run against
  unchanged inputs achieved the true steady state:
  `api_requests=0, cache_hits=12, cache_misses=0`. Tested explicitly
  (`test_fresh_reranker_reuses_last_known_resolved_model_id_for_cold_start_cache_hit`,
  `test_wrong_guessed_model_id_falls_through_to_a_real_api_call`).

- **_Verification performed beyond the test suite:_** ran
  `eval/run_rerank.py` three times against the real 12 questions and the
  real OpenAI API (not mocked) to observe this bug and its fix in
  practice: run 1 (cold) -- 12 requests, 0 hits; run 2 (bug present) -- 1
  request, 11 hits; run 3 (bug fixed) -- 0 requests, 12 hits. Confirmed
  `resolved_model_id` = `gpt-4o-mini-2024-07-18` for the configured
  family alias `gpt-4o-mini`. Confirmed reranking changed at least one
  question's ordering meaningfully (Q03, the multi-chunk case: baseline
  top-3 `[007-01, 007-03, 011-03]` -> reranked top-3
  `[007-03, 011-04, 007-01]`, correctly promoting `NWP-POL-011-04` -- the
  chunk that actually states the $5,000 threshold -- ahead of an
  unrelated approval-chain chunk that only outranked it in the fused
  keyword+dense baseline).
