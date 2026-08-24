# M9D4 RAGAS Quality Gate Evidence

Date: 2026-08-24

Evaluation set: `services/retrieval/eval/eval_set.jsonl`

This is the official reviewed-set quality result. The smoke set was not
used as the official feature-quality result.

## Command

```bash
cd services/retrieval
set -a
. ../../.env
set +a
export DATABASE_URI="postgres://expenseflow:synthetic-compose-db-password@localhost:5433/expenseflow"
uv run python eval/ragas_gate.py --eval eval/eval_set.jsonl
```

## Gate Result

```text
AssertionError: faithfulness 0.7946 below threshold 0.8500
```

The gate failed without changing questions, expected chunks, relevance
labels, ground truths, production prompts, or quality thresholds.

## Full Metrics Capture

Because the CLI stops at the first failed assertion, the following
follow-up capture used the same `eval_set.jsonl`, retrieval/rerank/generation
path, judge, thresholds, and RAGAS metric functions to record all required
metrics and usage.

```json
{
  "answer_relevancy": 0.7361201552191001,
  "context_precision": 0.9766666666184651,
  "example_count": 20,
  "faithfulness": 0.7804166666666668,
  "input_tokens": 181502,
  "judge_call_count": 200,
  "judge_cost_usd": 0.037067699999999995,
  "judge_family": "gpt-4o-mini",
  "output_tokens": 16404,
  "passes": {
    "answer_relevancy": false,
    "context_precision": true,
    "faithfulness": false
  },
  "resolved_judge_model_id": null,
  "thresholds": {
    "answer_relevancy": 0.85,
    "context_precision": 0.8,
    "faithfulness": 0.85
  }
}
```

## Interpretation

| Metric            |  Score | Threshold | Result | Likely failing stage                                            |
| ----------------- | -----: | --------: | ------ | --------------------------------------------------------------- |
| faithfulness      | 0.7804 |    0.8500 | FAIL   | Generation is adding unsupported claims.                        |
| answer relevancy  | 0.7361 |    0.8500 | FAIL   | Generated answers are not sufficiently addressing the question. |
| context precision | 0.9767 |    0.8000 | PASS   | Retrieval/reranking is returning mostly relevant context.       |

Configured judge family: `gpt-4o-mini`

Resolved judge model ID: not reported by RAGAS token usage for this run.

Judge usage: 200 calls, 181,502 input tokens, 16,404 output tokens.

Cost: $0.0370677, derived from the run's measured token usage and the
configured `gpt-4o-mini` token rates in `services/retrieval/eval/ragas_gate.py`.

## Follow-Up Diagnostics

After the full-set run above, the evaluator was updated to capture resolved
judge model IDs from LangChain callback metadata. Smoke-set diagnostics now
record:

```text
configured_judge_family: gpt-4o-mini
resolved_judge_model_id: gpt-4o-mini-2024-07-18
```

The smoke gate remains red after structured-output generation changes, so the
full reviewed set was not rerun as a final quality claim. The most important
diagnostic used the reviewed smoke-set `ground_truth` values as the generated
responses, which removes the production generator from the answer text while
keeping the same RAGAS metrics, judge, embeddings, retrieved contexts, and
labels:

```text
faithfulness: 1.0000
answer_relevancy: 0.6523
context_precision: 0.9900
resolved_judge_model_id: gpt-4o-mini-2024-07-18
```

Because answer relevancy remains below the configured `0.8500` threshold even
for human-reviewed ground truths, the remaining quality blocker should be
handled by revisiting evaluator calibration or approved model access rather
than by weakening thresholds, changing labels, or documenting a false pass.
