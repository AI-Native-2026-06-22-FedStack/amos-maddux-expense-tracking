"""Tests for services/retrieval/rerank.py: cache-key completeness,
malformed-output validation, resolved-model-id consistency/mismatch
handling, and cold-start cache reuse across runs -- all against a fake
OpenAI client (no real network access or API cost).
"""

from __future__ import annotations

import sys
from pathlib import Path
from types import SimpleNamespace

import pytest

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

import rerank  # noqa: E402
from rerank import (  # noqa: E402
    Candidate,
    RerankConfig,
    Reranker,
    RerankStats,
    RerankValidationError,
    ResolvedModelMismatchError,
    candidate_content_hash,
    rerank_cache_key,
    validate_ranked_ids,
)


def _candidate(chunk_id: str, text: str = "some chunk text") -> Candidate:
    return Candidate(
        chunk_id=chunk_id,
        section_id=chunk_id,
        source="data/corpus/fixture.md",
        text=text,
        content_hash=candidate_content_hash(text),
    )


@pytest.fixture()
def config() -> RerankConfig:
    return RerankConfig(
        provider="openai", model="gpt-4o-mini", temperature=0.0, prompt_version="rerank-v2"
    )


@pytest.fixture()
def cache_dir(tmp_path) -> Path:
    return tmp_path / "rerank-cache"


class FakeChoice:
    def __init__(self, content: str):
        self.message = SimpleNamespace(content=content)


class FakeResponse:
    def __init__(self, model: str, content: str):
        self.model = model
        self.choices = [FakeChoice(content)]


class FakeCompletions:
    """Records every request it receives (one per call, proving exactly
    ONE request is made per rerank() call, never per candidate) and
    returns a scripted response."""

    def __init__(self, responses: list[FakeResponse]):
        self._responses = list(responses)
        self.calls: list[dict] = []

    def create(self, **kwargs):
        self.calls.append(kwargs)
        if not self._responses:
            raise AssertionError("FakeCompletions ran out of scripted responses")
        return self._responses.pop(0)


class FakeClient:
    def __init__(self, responses: list[FakeResponse]):
        self.chat = SimpleNamespace(completions=FakeCompletions(responses))


def _make_reranker(config, cache_dir, responses: list[FakeResponse]) -> tuple[Reranker, FakeClient]:
    reranker = Reranker.__new__(Reranker)
    reranker.config = config
    reranker.cache_dir = cache_dir
    reranker.stats = RerankStats()
    reranker.resolved_model_id = None
    fake_client = FakeClient(responses)
    reranker._client = fake_client
    return reranker, fake_client


# --- one request per question, not per candidate --------------------------


def test_rerank_makes_exactly_one_api_request_for_ten_candidates(config, cache_dir):
    candidates = [_candidate(f"C{i}") for i in range(10)]
    response = FakeResponse(
        "gpt-4o-mini-2024-07-18",
        '{"ranked_ids": ' + str([c.chunk_id for c in candidates]).replace("'", '"') + "}",
    )
    reranker, fake_client = _make_reranker(config, cache_dir, [response])

    reranker.rerank("some question", candidates)

    assert len(fake_client.chat.completions.calls) == 1, (
        "reranking 10 candidates must make exactly ONE model request, not one per candidate"
    )
    assert reranker.stats.api_requests == 1


def test_single_request_contains_the_entire_numbered_candidate_list(config, cache_dir):
    candidates = [_candidate("C1", "text one"), _candidate("C2", "text two")]
    response = FakeResponse("gpt-4o-mini-2024-07-18", '{"ranked_ids": ["C2", "C1"]}')
    reranker, fake_client = _make_reranker(config, cache_dir, [response])

    reranker.rerank("which is better", candidates)

    sent_prompt = fake_client.chat.completions.calls[0]["messages"][0]["content"]
    assert "C1" in sent_prompt
    assert "C2" in sent_prompt
    assert "text one" in sent_prompt
    assert "text two" in sent_prompt
    assert "which is better" in sent_prompt


def test_prompt_explicitly_requires_every_candidate_id():
    candidates = [_candidate("C1"), _candidate("C2"), _candidate("C3")]

    prompt = rerank._build_prompt("rank these", candidates)

    assert '"ranked_ids" must contain exactly 3 strings' in prompt
    assert "Do not return only the top matches" in prompt
    assert "Required candidate ids: C1, C2, C3" in prompt


def test_prompt_does_not_leak_retrieval_scores_to_the_model(config, cache_dir):
    # The requirement: do not reuse original retrieval scores as the
    # reranking judgment. Candidate carries no fused_score/rank field at
    # all -- the prompt-building function has nothing to leak even if it
    # wanted to, which this test pins down structurally.
    candidates = [_candidate("C1"), _candidate("C2")]
    prompt = rerank._build_prompt("a question", candidates)
    for forbidden in ("fused_score", "keyword_rank", "dense_rank"):
        assert forbidden not in prompt


# --- validation of malformed model output ----------------------------


def test_validate_ranked_ids_accepts_exact_permutation():
    candidates = [_candidate("A"), _candidate("B"), _candidate("C")]
    result = validate_ranked_ids(["C", "A", "B"], candidates)
    assert result == ["C", "A", "B"]


def test_validate_ranked_ids_rejects_missing_id():
    candidates = [_candidate("A"), _candidate("B")]
    with pytest.raises(RerankValidationError, match="missing"):
        validate_ranked_ids(["A"], candidates)


def test_validate_ranked_ids_rejects_invented_id():
    candidates = [_candidate("A"), _candidate("B")]
    with pytest.raises(RerankValidationError, match="invented"):
        validate_ranked_ids(["A", "B", "Z"], candidates)


def test_validate_ranked_ids_rejects_duplicate_id():
    candidates = [_candidate("A"), _candidate("B")]
    with pytest.raises(RerankValidationError, match="duplicate"):
        validate_ranked_ids(["A", "A"], candidates)


def test_rerank_raises_on_non_json_model_output(config, cache_dir):
    candidates = [_candidate("A"), _candidate("B")]
    response = FakeResponse("gpt-4o-mini-2024-07-18", "not json at all")
    reranker, _ = _make_reranker(config, cache_dir, [response])

    with pytest.raises(RerankValidationError):
        reranker.rerank("a question", candidates)


def test_rerank_raises_on_missing_ranked_ids_key(config, cache_dir):
    candidates = [_candidate("A"), _candidate("B")]
    response = FakeResponse("gpt-4o-mini-2024-07-18", '{"something_else": []}')
    reranker, _ = _make_reranker(config, cache_dir, [response])

    with pytest.raises(RerankValidationError):
        reranker.rerank("a question", candidates)


def test_rerank_raises_on_malformed_ids_never_silently_corrupts_ranking(config, cache_dir):
    candidates = [_candidate("A"), _candidate("B"), _candidate("C")]
    # Model invents an id that was never in the candidate list.
    response = FakeResponse("gpt-4o-mini-2024-07-18", '{"ranked_ids": ["A", "B", "NOT_REAL"]}')
    reranker, _ = _make_reranker(config, cache_dir, [response])

    with pytest.raises(RerankValidationError):
        reranker.rerank("a question", candidates)
    # And nothing was cached from the failed attempt.
    assert list(cache_dir.glob("*.json")) == [] if cache_dir.exists() else True


# --- resolved model id: capture + mismatch guard --------------------------


def test_resolved_model_id_is_captured_from_api_response_not_config(config, cache_dir):
    candidates = [_candidate("A")]
    response = FakeResponse("gpt-4o-mini-2024-07-18", '{"ranked_ids": ["A"]}')
    reranker, _ = _make_reranker(config, cache_dir, [response])

    reranker.rerank("q", candidates)

    assert reranker.resolved_model_id == "gpt-4o-mini-2024-07-18"
    assert reranker.resolved_model_id != config.model, (
        "resolved_model_id must be the concrete id the API returned, "
        "not the configured family alias"
    )


def test_second_call_with_same_resolved_model_id_does_not_raise(config, cache_dir):
    candidates_a = [_candidate("A")]
    candidates_b = [_candidate("B")]
    responses = [
        FakeResponse("gpt-4o-mini-2024-07-18", '{"ranked_ids": ["A"]}'),
        FakeResponse("gpt-4o-mini-2024-07-18", '{"ranked_ids": ["B"]}'),
    ]
    reranker, _ = _make_reranker(config, cache_dir, responses)

    reranker.rerank("q1", candidates_a)
    reranker.rerank("q2", candidates_b)  # different candidates -> guaranteed cache miss

    assert reranker.resolved_model_id == "gpt-4o-mini-2024-07-18"
    assert reranker.stats.api_requests == 2


def test_mismatched_resolved_model_id_within_one_run_raises(config, cache_dir):
    candidates_a = [_candidate("A")]
    candidates_b = [_candidate("B")]
    responses = [
        FakeResponse("gpt-4o-mini-2024-07-18", '{"ranked_ids": ["A"]}'),
        FakeResponse("gpt-4o-mini-2024-08-01", '{"ranked_ids": ["B"]}'),
    ]
    reranker, _ = _make_reranker(config, cache_dir, responses)

    reranker.rerank("q1", candidates_a)
    with pytest.raises(ResolvedModelMismatchError):
        reranker.rerank("q2", candidates_b)


# --- cache key completeness -------------------------------------------


def test_cache_key_changes_with_question_text(config):
    candidates = [_candidate("A")]
    key_a = rerank_cache_key("question one", candidates, "model-x", config)
    key_b = rerank_cache_key("question two", candidates, "model-x", config)
    assert key_a != key_b


def test_cache_key_changes_with_candidate_order(config):
    candidates_ab = [_candidate("A"), _candidate("B")]
    candidates_ba = [_candidate("B"), _candidate("A")]
    key_ab = rerank_cache_key("q", candidates_ab, "model-x", config)
    key_ba = rerank_cache_key("q", candidates_ba, "model-x", config)
    assert key_ab != key_ba, "candidate ORDER must be part of the cache key"


def test_cache_key_changes_with_candidate_content_hash(config):
    candidates_v1 = [_candidate("A", text="version one text")]
    candidates_v2 = [_candidate("A", text="version two text -- edited")]
    key_v1 = rerank_cache_key("q", candidates_v1, "model-x", config)
    key_v2 = rerank_cache_key("q", candidates_v2, "model-x", config)
    assert key_v1 != key_v2, (
        "same chunk_id with DIFFERENT content must produce a different "
        "cache key -- content_hash, not just chunk_id, is part of the key"
    )


def test_cache_key_changes_with_resolved_model_id(config):
    candidates = [_candidate("A")]
    key_x = rerank_cache_key("q", candidates, "gpt-4o-mini-2024-07-18", config)
    key_y = rerank_cache_key("q", candidates, "gpt-4o-mini-2024-08-01", config)
    assert key_x != key_y


def test_cache_key_changes_with_prompt_version(config):
    candidates = [_candidate("A")]
    config_v1 = RerankConfig(
        provider=config.provider,
        model=config.model,
        temperature=config.temperature,
        prompt_version="rerank-v1",
    )
    config_v2 = RerankConfig(
        provider=config.provider,
        model=config.model,
        temperature=config.temperature,
        prompt_version="rerank-v2",
    )
    key_v1 = rerank_cache_key("q", candidates, "model-x", config_v1)
    key_v2 = rerank_cache_key("q", candidates, "model-x", config_v2)
    assert key_v1 != key_v2


def test_cache_key_changes_with_temperature(config):
    candidates = [_candidate("A")]
    config_hot = RerankConfig(
        provider=config.provider, model=config.model, temperature=0.7, prompt_version="rerank-v2"
    )
    key_cold = rerank_cache_key("q", candidates, "model-x", config)
    key_hot = rerank_cache_key("q", candidates, "model-x", config_hot)
    assert key_cold != key_hot


# --- cache hit/miss behavior within and across runs ------------------


def test_repeated_rerank_within_one_run_hits_cache_and_does_not_recall_api(config, cache_dir):
    candidates = [_candidate("A"), _candidate("B")]
    response = FakeResponse("gpt-4o-mini-2024-07-18", '{"ranked_ids": ["B", "A"]}')
    reranker, fake_client = _make_reranker(config, cache_dir, [response])

    first = reranker.rerank("same question", candidates)
    second = reranker.rerank("same question", candidates)

    assert len(fake_client.chat.completions.calls) == 1, (
        "second call with identical inputs must not call the API again"
    )
    assert reranker.stats.cache_hits == 1
    assert [r.chunk_id for r in first] == [r.chunk_id for r in second]


def test_changed_candidate_content_forces_a_fresh_api_call(config, cache_dir):
    candidates_v1 = [_candidate("A", text="original wording")]
    candidates_v2 = [_candidate("A", text="edited wording")]
    responses = [
        FakeResponse("gpt-4o-mini-2024-07-18", '{"ranked_ids": ["A"]}'),
        FakeResponse("gpt-4o-mini-2024-07-18", '{"ranked_ids": ["A"]}'),
    ]
    reranker, fake_client = _make_reranker(config, cache_dir, responses)

    reranker.rerank("same question", candidates_v1)
    reranker.rerank("same question", candidates_v2)

    assert len(fake_client.chat.completions.calls) == 2, (
        "changed candidate content must not silently reuse the old text's cached ranking"
    )


def test_fresh_reranker_reuses_last_known_resolved_model_id_for_cold_start_cache_hit(
    config, cache_dir
):
    # First "run": a fresh Reranker with no prior state.
    candidates = [_candidate("A"), _candidate("B")]
    response = FakeResponse("gpt-4o-mini-2024-07-18", '{"ranked_ids": ["B", "A"]}')
    first_run, _ = _make_reranker(config, cache_dir, [response])
    first_run.rerank("stable question", candidates)
    assert first_run.stats.api_requests == 1

    # Second "run": a BRAND NEW Reranker instance (simulating a fresh
    # process), same cache_dir, no responses scripted at all -- if it
    # tries to call the API, the test fails outright (FakeCompletions
    # raises when it runs out of responses).
    second_run, second_client = _make_reranker(config, cache_dir, [])
    result = second_run.rerank("stable question", candidates)

    assert len(second_client.chat.completions.calls) == 0, (
        "a fresh Reranker instance must be able to reuse a previous "
        "run's persisted resolved_model_id to get a real cache hit "
        "without any API call, when nothing has actually changed"
    )
    assert second_run.stats.cache_hits == 1
    assert second_run.resolved_model_id == "gpt-4o-mini-2024-07-18"
    assert [r.chunk_id for r in result] == ["B", "A"]


def test_wrong_guessed_model_id_falls_through_to_a_real_api_call(config, cache_dir):
    # Seed a last-known model id that does NOT match what the next real
    # API call will actually resolve to (simulates OpenAI repointing the
    # alias between runs).
    rerank._save_last_resolved_model_id(cache_dir, config, "gpt-4o-mini-2024-01-01")

    candidates = [_candidate("A")]
    response = FakeResponse("gpt-4o-mini-2024-09-01", '{"ranked_ids": ["A"]}')
    reranker, fake_client = _make_reranker(config, cache_dir, [response])

    result = reranker.rerank("a question", candidates)

    assert len(fake_client.chat.completions.calls) == 1, (
        "a wrong guess must fall through to a real API call, not silently "
        "return a wrong-model cached result"
    )
    assert reranker.resolved_model_id == "gpt-4o-mini-2024-09-01"
    assert [r.chunk_id for r in result] == ["A"]
