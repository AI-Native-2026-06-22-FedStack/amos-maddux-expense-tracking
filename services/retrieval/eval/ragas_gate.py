"""RAGAS quality gate for reviewed ExpenseFlow policy-question eval sets."""

from __future__ import annotations

import argparse
import json
import os
import tomllib
from dataclasses import dataclass
from pathlib import Path
from typing import Any

from rag_pipeline import PolicyRagPipeline, UsageTotals

EVAL_DIR = Path(__file__).resolve().parent
DEFAULT_THRESHOLDS_PATH = EVAL_DIR / "thresholds.toml"
DEFAULT_EVAL_PATH = EVAL_DIR / "eval_smoke.jsonl"

OPENAI_GPT_4O_MINI_INPUT_PER_TOKEN_USD = 0.15 / 1_000_000
OPENAI_GPT_4O_MINI_OUTPUT_PER_TOKEN_USD = 0.60 / 1_000_000


@dataclass(frozen=True)
class GateThresholds:
    faithfulness: float
    answer_relevancy: float
    context_precision: float


@dataclass(frozen=True)
class JudgeConfig:
    provider: str
    model: str


@dataclass(frozen=True)
class GateConfig:
    judge: JudgeConfig
    thresholds: GateThresholds


@dataclass(frozen=True)
class EvaluationExample:
    question_id: str
    question: str
    expected_chunk_id: str
    relevant_chunk_ids: list[str]
    ground_truth: str


@dataclass(frozen=True)
class RagasScores:
    faithfulness: float
    answer_relevancy: float
    context_precision: float


@dataclass(frozen=True)
class RagasUsage:
    judge_family: str
    resolved_judge_model_id: str | None
    judge_call_count: int | None
    input_tokens: int
    output_tokens: int
    cost_usd: float | None


@dataclass(frozen=True)
class GateResult:
    scores: RagasScores
    usage: RagasUsage
    example_count: int


def load_gate_config(path: Path = DEFAULT_THRESHOLDS_PATH) -> GateConfig:
    with path.open("rb") as f:
        data = tomllib.load(f)
    return GateConfig(
        judge=JudgeConfig(
            provider=data["judge"]["provider"],
            model=data["judge"]["model"],
        ),
        thresholds=GateThresholds(
            faithfulness=float(data["metrics"]["faithfulness"]),
            answer_relevancy=float(data["metrics"]["answer_relevancy"]),
            context_precision=float(data["metrics"]["context_precision"]),
        ),
    )


def load_examples(path: Path) -> list[EvaluationExample]:
    examples: list[EvaluationExample] = []
    for line_number, line in enumerate(path.read_text(encoding="utf-8").splitlines(), start=1):
        if not line.strip():
            continue
        row = json.loads(line)
        missing = {
            "question",
            "expected_chunk_id",
            "relevant_chunk_ids",
            "ground_truth",
        } - row.keys()
        if missing:
            raise ValueError(f"{path}:{line_number}: missing required fields: {sorted(missing)}")
        examples.append(
            EvaluationExample(
                question_id=str(row.get("question_id", f"row-{line_number}")),
                question=row["question"],
                expected_chunk_id=row["expected_chunk_id"],
                relevant_chunk_ids=list(row["relevant_chunk_ids"]),
                ground_truth=row["ground_truth"],
            )
        )
    return examples


def build_ragas_rows(
    examples: list[EvaluationExample], pipeline: PolicyRagPipeline
) -> list[dict[str, Any]]:
    rows: list[dict[str, Any]] = []
    for example in examples:
        answer = pipeline.answer_question(example.question)
        rows.append(
            {
                "user_input": example.question,
                "response": answer.answer,
                "retrieved_contexts": answer.contexts,
                "reference": example.ground_truth,
                "expected_chunk_id": example.expected_chunk_id,
                "relevant_chunk_ids": example.relevant_chunk_ids,
                "actual_context_chunk_ids": answer.context_chunk_ids,
            }
        )
    return rows


def evaluate_gate(
    *,
    eval_path: Path = DEFAULT_EVAL_PATH,
    config_path: Path = DEFAULT_THRESHOLDS_PATH,
    pipeline: PolicyRagPipeline | None = None,
) -> GateResult:
    config = load_gate_config(config_path)
    examples = load_examples(eval_path)
    rag_rows = build_ragas_rows(examples, pipeline or PolicyRagPipeline())
    result = _run_ragas(rag_rows, config)
    assert_quality_gates(result.scores, config.thresholds)
    return result


def assert_quality_gates(scores: RagasScores, thresholds: GateThresholds) -> None:
    assert scores.faithfulness >= thresholds.faithfulness, (
        f"faithfulness {scores.faithfulness:.4f} below threshold "
        f"{thresholds.faithfulness:.4f}"
    )
    assert scores.answer_relevancy >= thresholds.answer_relevancy, (
        f"answer_relevancy {scores.answer_relevancy:.4f} below threshold "
        f"{thresholds.answer_relevancy:.4f}"
    )
    assert scores.context_precision >= thresholds.context_precision, (
        f"context_precision {scores.context_precision:.4f} below threshold "
        f"{thresholds.context_precision:.4f}"
    )


def _run_ragas(rows: list[dict[str, Any]], config: GateConfig) -> GateResult:
    try:
        from datasets import Dataset
        from langchain_openai import ChatOpenAI
        from ragas import evaluate
        from ragas.cost import get_token_usage_for_openai
        from ragas.metrics import answer_relevancy, context_precision, faithfulness
    except ImportError as exc:
        raise RuntimeError(
            "RAGAS evaluation dependencies are not installed. Run `uv sync` in "
            "services/retrieval before executing the paid quality gate."
        ) from exc

    dataset = Dataset.from_list(rows)
    judge_llm = ChatOpenAI(model=config.judge.model, temperature=0)
    ragas_result = evaluate(
        dataset,
        metrics=[faithfulness, answer_relevancy, context_precision],
        llm=judge_llm,
        token_usage_parser=get_token_usage_for_openai,
        raise_exceptions=True,
        show_progress=False,
    )
    scores = _scores_from_ragas_result(ragas_result)
    usage = _usage_from_ragas_result(ragas_result, config.judge.model)
    return GateResult(scores=scores, usage=usage, example_count=len(rows))


def _scores_from_ragas_result(ragas_result: Any) -> RagasScores:
    result_dict = getattr(ragas_result, "_repr_dict", None)
    if result_dict is None:
        result_dict = _mean_scores(getattr(ragas_result, "scores", []))
    return RagasScores(
        faithfulness=float(result_dict["faithfulness"]),
        answer_relevancy=float(result_dict["answer_relevancy"]),
        context_precision=float(result_dict["context_precision"]),
    )


def _usage_from_ragas_result(ragas_result: Any, judge_family: str) -> RagasUsage:
    total_tokens = _safe_total_tokens(ragas_result)
    input_tokens = total_tokens.input_tokens
    output_tokens = total_tokens.output_tokens
    cost_usd = _safe_total_cost(ragas_result)
    cost_usd = (
        _estimate_gpt_4o_mini_cost(input_tokens, output_tokens) if cost_usd is None else cost_usd
    )
    return RagasUsage(
        judge_family=judge_family,
        resolved_judge_model_id=total_tokens.resolved_model_id,
        judge_call_count=total_tokens.call_count,
        input_tokens=input_tokens,
        output_tokens=output_tokens,
        cost_usd=cost_usd,
    )


def _safe_total_tokens(ragas_result: Any) -> UsageTotals:
    try:
        total = ragas_result.total_tokens()
    except Exception:
        total = None
    totals = total if isinstance(total, list) else ([total] if total is not None else [])
    input_tokens = sum(int(getattr(item, "input_tokens", 0) or 0) for item in totals)
    output_tokens = sum(int(getattr(item, "output_tokens", 0) or 0) for item in totals)
    models = {getattr(item, "model", None) for item in totals if getattr(item, "model", None)}
    resolved_model_id = ",".join(sorted(models)) if models else None
    cost_cb = getattr(ragas_result, "cost_cb", None)
    usages = getattr(cost_cb, "usage_data", None)
    call_count = len(usages) if isinstance(usages, list) else None
    return UsageTotals(
        call_count=call_count,
        input_tokens=input_tokens,
        output_tokens=output_tokens,
        cost_usd=None,
        resolved_model_id=resolved_model_id,
    )


def _mean_scores(scores: list[dict[str, Any]]) -> dict[str, float]:
    if not scores:
        raise ValueError("RAGAS returned no scores")
    metric_names = scores[0].keys()
    return {
        name: sum(float(row[name]) for row in scores) / len(scores)
        for name in metric_names
    }


def _safe_total_cost(ragas_result: Any) -> float | None:
    try:
        return float(
            ragas_result.total_cost(
                cost_per_input_token=OPENAI_GPT_4O_MINI_INPUT_PER_TOKEN_USD,
                cost_per_output_token=OPENAI_GPT_4O_MINI_OUTPUT_PER_TOKEN_USD,
            )
        )
    except Exception:
        return None


def _estimate_gpt_4o_mini_cost(input_tokens: int, output_tokens: int) -> float:
    return (
        input_tokens * OPENAI_GPT_4O_MINI_INPUT_PER_TOKEN_USD
        + output_tokens * OPENAI_GPT_4O_MINI_OUTPUT_PER_TOKEN_USD
    )


def main() -> int:
    parser = argparse.ArgumentParser(description="Run the ExpenseFlow RAGAS quality gate.")
    parser.add_argument("--eval", type=Path, default=DEFAULT_EVAL_PATH)
    parser.add_argument("--thresholds", type=Path, default=DEFAULT_THRESHOLDS_PATH)
    args = parser.parse_args()

    if not os.environ.get("OPENAI_API_KEY"):
        raise RuntimeError("OPENAI_API_KEY is required for RAGAS quality evaluation")
    if not os.environ.get("DATABASE_URI"):
        raise RuntimeError("DATABASE_URI is required for RAGAS quality evaluation")

    result = evaluate_gate(eval_path=args.eval, config_path=args.thresholds)
    print(json.dumps(_report_dict(result), sort_keys=True))
    return 0


def _report_dict(result: GateResult) -> dict[str, Any]:
    return {
        "example_count": result.example_count,
        "faithfulness": result.scores.faithfulness,
        "answer_relevancy": result.scores.answer_relevancy,
        "context_precision": result.scores.context_precision,
        "judge_family": result.usage.judge_family,
        "resolved_judge_model_id": result.usage.resolved_judge_model_id,
        "judge_call_count": result.usage.judge_call_count,
        "input_tokens": result.usage.input_tokens,
        "output_tokens": result.usage.output_tokens,
        "judge_cost_usd": result.usage.cost_usd,
    }


if __name__ == "__main__":
    raise SystemExit(main())
