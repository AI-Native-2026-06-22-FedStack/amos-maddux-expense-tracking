from __future__ import annotations

import json
import sys
from pathlib import Path

import pytest

EVAL_DIR = Path(__file__).resolve().parent
RETRIEVAL_DIR = EVAL_DIR.parent
sys.path.insert(0, str(EVAL_DIR))
sys.path.insert(0, str(RETRIEVAL_DIR))

import ragas_gate  # noqa: E402
from ragas_gate import GateThresholds, RagasScores  # noqa: E402


def test_thresholds_load_the_required_metric_gates():
    config = ragas_gate.load_gate_config()

    assert config.judge.model == "gpt-4o-mini"
    assert config.thresholds.faithfulness == 0.85
    assert config.thresholds.answer_relevancy == 0.85
    assert config.thresholds.context_precision == 0.80


def test_eval_files_load_with_required_ragas_fields():
    for path in (EVAL_DIR / "eval_smoke.jsonl", EVAL_DIR / "eval_set.jsonl"):
        examples = ragas_gate.load_examples(path)

        assert examples
        assert all(example.question for example in examples)
        assert all(example.expected_chunk_id for example in examples)
        assert all(example.relevant_chunk_ids for example in examples)
        assert all(example.ground_truth for example in examples)


def test_smoke_eval_contains_exactly_five_examples():
    assert len(ragas_gate.load_examples(EVAL_DIR / "eval_smoke.jsonl")) == 5


def test_quality_gates_assert_each_metric_independently():
    thresholds = GateThresholds(
        faithfulness=0.85,
        answer_relevancy=0.85,
        context_precision=0.80,
    )

    ragas_gate.assert_quality_gates(
        RagasScores(faithfulness=0.85, answer_relevancy=0.85, context_precision=0.80),
        thresholds,
    )

    with pytest.raises(AssertionError, match="faithfulness"):
        ragas_gate.assert_quality_gates(
            RagasScores(faithfulness=0.84, answer_relevancy=1.0, context_precision=1.0),
            thresholds,
        )

    with pytest.raises(AssertionError, match="answer_relevancy"):
        ragas_gate.assert_quality_gates(
            RagasScores(faithfulness=1.0, answer_relevancy=0.84, context_precision=1.0),
            thresholds,
        )

    with pytest.raises(AssertionError, match="context_precision"):
        ragas_gate.assert_quality_gates(
            RagasScores(faithfulness=1.0, answer_relevancy=1.0, context_precision=0.79),
            thresholds,
        )


def test_runner_accepts_any_reviewed_eval_file_without_duplicate_implementation(tmp_path):
    eval_path = tmp_path / "tiny_eval.jsonl"
    eval_path.write_text(
        json.dumps(
            {
                "question_id": "QX",
                "question": "Can I approve this synthetic request?",
                "expected_chunk_id": "NWP-POL-001-01",
                "relevant_chunk_ids": ["NWP-POL-001-01"],
                "ground_truth": "Synthetic ground truth.",
            }
        )
        + "\n",
        encoding="utf-8",
    )

    examples = ragas_gate.load_examples(eval_path)

    assert len(examples) == 1
    assert examples[0].question_id == "QX"


def test_ragas_result_adapter_reads_scores_and_usage_from_actual_result_shape():
    class TokenUsage:
        input_tokens = 11
        output_tokens = 7
        model = "gpt-4o-mini-2024-07-18"

    class CostCallback:
        usage_data = [TokenUsage(), TokenUsage()]

    class Result:
        _repr_dict = {
            "faithfulness": 0.9,
            "answer_relevancy": 0.91,
            "context_precision": 0.92,
        }
        cost_cb = CostCallback()

        def total_tokens(self):
            return TokenUsage()

        def total_cost(self, *, cost_per_input_token, cost_per_output_token):
            return 11 * cost_per_input_token + 7 * cost_per_output_token

    scores = ragas_gate._scores_from_ragas_result(Result())
    usage = ragas_gate._usage_from_ragas_result(Result(), "gpt-4o-mini")

    assert scores == RagasScores(
        faithfulness=0.9,
        answer_relevancy=0.91,
        context_precision=0.92,
    )
    assert usage.judge_family == "gpt-4o-mini"
    assert usage.resolved_judge_model_id == "gpt-4o-mini-2024-07-18"
    assert usage.judge_call_count == 2
    assert usage.input_tokens == 11
    assert usage.output_tokens == 7
    assert usage.cost_usd is not None
