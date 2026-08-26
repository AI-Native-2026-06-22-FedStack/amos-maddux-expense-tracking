from __future__ import annotations

import json
import sys
from pathlib import Path
from types import SimpleNamespace

import pytest

EVAL_DIR = Path(__file__).resolve().parent
RETRIEVAL_DIR = EVAL_DIR.parent
sys.path.insert(0, str(EVAL_DIR))
sys.path.insert(0, str(RETRIEVAL_DIR))

import ragas_gate  # noqa: E402
from rag_pipeline import FakeRetrievedChunkFactory, SelectedPolicyContexts  # noqa: E402
from ragas_gate import GateResult, GateThresholds, RagasScores, RagasUsage  # noqa: E402


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
        assert all(example.canonical_question for example in examples)
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

    with pytest.raises(AssertionError, match="faithfulness.*answer_relevancy"):
        ragas_gate.assert_quality_gates(
            RagasScores(faithfulness=0.84, answer_relevancy=0.84, context_precision=1.0),
            thresholds,
        )


def test_runner_accepts_any_reviewed_eval_file_without_duplicate_implementation(tmp_path):
    eval_path = tmp_path / "tiny_eval.jsonl"
    eval_path.write_text(
        json.dumps(
            {
                "question_id": "QX",
                "question": "Can I approve this synthetic request?",
                "canonical_question": "What policy applies to this synthetic request?",
                "reference_canonical_question": "What policy is stated by the reference answer?",
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
    assert examples[0].canonical_question == "What policy applies to this synthetic request?"
    assert examples[0].reference_canonical_question == (
        "What policy is stated by the reference answer?"
    )


def test_load_examples_requires_canonical_question(tmp_path):
    eval_path = tmp_path / "missing_canonical.jsonl"
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

    with pytest.raises(ValueError, match="canonical_question"):
        ragas_gate.load_examples(eval_path)


def test_generated_rows_use_canonical_question_but_pipeline_gets_original_question():
    example = _example()
    pipeline = _FakeGeneratedPipeline()

    rows = ragas_gate.build_ragas_rows([example], pipeline)

    assert pipeline.questions == ["Can I approve this synthetic request?"]
    assert rows == [
        {
            "user_input": "What policy applies to this synthetic request?",
            "response": "Policy allows the synthetic request.",
            "retrieved_contexts": ["Synthetic supporting context."],
            "reference": "Synthetic ground truth.",
            "expected_chunk_id": "NWP-POL-001-01",
            "relevant_chunk_ids": ["NWP-POL-001-01"],
            "actual_context_chunk_ids": ["NWP-POL-001-01"],
        }
    ]


def test_reference_mode_uses_ground_truth_without_generation():
    pipeline = _FakeContextPipeline()
    example = _example(
        reference_canonical_question="What policy is stated by the reference answer?"
    )

    rows = ragas_gate.build_ragas_rows([example], pipeline, response_mode="reference")

    assert pipeline.context_questions == ["Can I approve this synthetic request?"]
    assert rows[0]["user_input"] == "What policy is stated by the reference answer?"
    assert rows[0]["response"] == "Synthetic ground truth."
    assert rows[0]["retrieved_contexts"] == ["Synthetic supporting context."]
    assert rows[0]["actual_context_chunk_ids"] == ["NWP-POL-001-01"]


def test_fixture_mode_uses_fixture_responses_by_question_id():
    rows = ragas_gate.build_ragas_rows(
        [_example()],
        _FakeContextPipeline(),
        response_mode="fixture",
        fixture_responses={"QX": "Policy prohibits every synthetic request."},
    )

    assert rows[0]["response"] == "Policy prohibits every synthetic request."


def test_fixture_mode_fails_when_fixture_response_is_missing():
    with pytest.raises(ValueError, match="QX"):
        ragas_gate.build_ragas_rows(
            [_example()],
            _FakeContextPipeline(),
            response_mode="fixture",
            fixture_responses={},
        )


def test_load_fixture_responses_reads_jsonl(tmp_path):
    fixture_path = tmp_path / "fixtures.jsonl"
    fixture_path.write_text(
        json.dumps({"question_id": "QX", "response": "Synthetic bad answer."}) + "\n",
        encoding="utf-8",
    )

    assert ragas_gate.load_fixture_responses(fixture_path) == {
        "QX": "Synthetic bad answer."
    }


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


def test_report_dict_includes_passes_failures_thresholds_and_mode():
    report = ragas_gate._report_dict(_failing_gate_result())

    assert report["response_mode"] == "generated"
    assert report["canonical_question_count"] == 1
    assert report["passes"] == {
        "faithfulness": False,
        "answer_relevancy": True,
        "context_precision": True,
    }
    assert report["failures"] == ["faithfulness 0.8400 below threshold 0.8500"]
    assert report["thresholds"]["answer_relevancy"] == 0.85


def test_main_prints_report_and_fails_nonzero_by_default(monkeypatch, capsys):
    monkeypatch.setenv("OPENAI_API_KEY", "synthetic-test-key")
    monkeypatch.setenv("DATABASE_URI", "postgres://synthetic")
    monkeypatch.setattr(sys, "argv", ["ragas_gate.py"])
    monkeypatch.setattr(ragas_gate, "evaluate_gate", lambda **_kwargs: _failing_gate_result())

    with pytest.raises(AssertionError, match="faithfulness"):
        ragas_gate.main()

    assert '"failures"' in capsys.readouterr().out


def test_main_allow_fail_prints_report_and_returns_zero(monkeypatch, capsys):
    monkeypatch.setenv("OPENAI_API_KEY", "synthetic-test-key")
    monkeypatch.setenv("DATABASE_URI", "postgres://synthetic")
    monkeypatch.setattr(sys, "argv", ["ragas_gate.py", "--allow-fail"])
    monkeypatch.setattr(ragas_gate, "evaluate_gate", lambda **_kwargs: _failing_gate_result())

    assert ragas_gate.main() == 0
    assert '"response_mode": "generated"' in capsys.readouterr().out


def test_resolved_judge_model_callback_reads_langchain_response_metadata():
    class Message:
        response_metadata = {"model_name": "gpt-4o-mini-2024-07-18"}

    class Generation:
        message = Message()

    class Response:
        llm_output = {}
        generations = [[Generation()]]

    callback = ragas_gate._ResolvedJudgeModelCallback()

    callback.on_llm_end(Response())

    assert callback.resolved_model_ids == {"gpt-4o-mini-2024-07-18"}


class _FakeGeneratedPipeline:
    def __init__(self) -> None:
        self.questions: list[str] = []

    def answer_question(self, question: str):
        self.questions.append(question)
        return SimpleNamespace(
            answer=json.dumps({"answer": "Policy allows the synthetic request."}),
            contexts=["Synthetic supporting context."],
            context_chunk_ids=["NWP-POL-001-01"],
        )


class _FakeContextPipeline:
    def __init__(self) -> None:
        self.context_questions: list[str] = []
        self.chunk_factory = FakeRetrievedChunkFactory()

    def select_contexts(self, question: str) -> SelectedPolicyContexts:
        self.context_questions.append(question)
        return SelectedPolicyContexts(
            contexts=[
                self.chunk_factory.make("NWP-POL-001-01", "Synthetic supporting context.")
            ],
            retrieved_chunk_ids=["NWP-POL-001-01"],
            reranked_chunk_ids=["NWP-POL-001-01"],
            rerank_resolved_model_id=None,
            rerank_api_requests=0,
        )


def _example(reference_canonical_question: str | None = None) -> ragas_gate.EvaluationExample:
    return ragas_gate.EvaluationExample(
        question_id="QX",
        question="Can I approve this synthetic request?",
        canonical_question="What policy applies to this synthetic request?",
        reference_canonical_question=reference_canonical_question,
        expected_chunk_id="NWP-POL-001-01",
        relevant_chunk_ids=["NWP-POL-001-01"],
        ground_truth="Synthetic ground truth.",
    )


def _failing_gate_result() -> GateResult:
    return GateResult(
        scores=RagasScores(faithfulness=0.84, answer_relevancy=0.86, context_precision=0.81),
        usage=RagasUsage(
            judge_family="gpt-4o-mini",
            resolved_judge_model_id="gpt-4o-mini-2024-07-18",
            judge_call_count=1,
            input_tokens=1,
            output_tokens=1,
            cost_usd=0.01,
        ),
        example_count=1,
        canonical_question_count=1,
        response_mode="generated",
        thresholds=GateThresholds(
            faithfulness=0.85,
            answer_relevancy=0.85,
            context_precision=0.80,
        ),
    )
