"""Tests for services/retrieval/retrieve.py's hybrid retrieval:
reciprocal_rank_fusion()'s rank-based fusion math (pure unit tests, no
database), plus the keyword/dense legs and tenant isolation against the
real local Postgres (skipped if unreachable).
"""

from __future__ import annotations

import sys
from pathlib import Path

import pytest

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

import retrieve  # noqa: E402
from retrieve import (  # noqa: E402
    LegResult,
    RetrievalConfig,
    _extract_literal_section_id,
    _keyword_leg,
    _to_tsquery_or_terms,
    reciprocal_rank_fusion,
)
from retrieve import (
    retrieve as run_retrieve,
)

RRF_K = 60
REAL_TENANT_ID = "tenant-synthetic-northwind-prairie"


# --- RRF fusion is rank-based, not score-based --------------------------


def test_rrf_formula_matches_1_over_k_plus_rank():
    # A single leg, one chunk at rank 1: score must be exactly 1/(60+1).
    leg = LegResult(ranked_chunk_ids=["A"], rows_by_chunk_id={})
    fused = reciprocal_rank_fusion({"only": leg}, k=RRF_K)
    assert fused == [("A", pytest.approx(1 / (RRF_K + 1)), {"only": 1})]


def test_rrf_sums_across_legs_for_a_chunk_present_in_both():
    keyword_leg = LegResult(ranked_chunk_ids=["A", "B"], rows_by_chunk_id={})
    dense_leg = LegResult(ranked_chunk_ids=["B", "A"], rows_by_chunk_id={})
    fused = reciprocal_rank_fusion({"keyword": keyword_leg, "dense": dense_leg}, k=RRF_K)
    fused_by_id = {chunk_id: score for chunk_id, score, _ in fused}

    # A: rank 1 in keyword, rank 2 in dense
    assert fused_by_id["A"] == pytest.approx(1 / (RRF_K + 1) + 1 / (RRF_K + 2))
    # B: rank 2 in keyword, rank 1 in dense
    assert fused_by_id["B"] == pytest.approx(1 / (RRF_K + 2) + 1 / (RRF_K + 1))
    # Symmetric ranks (1+2 vs 2+1) must produce equal fused scores.
    assert fused_by_id["A"] == pytest.approx(fused_by_id["B"])


def test_rrf_chunk_only_in_one_leg_gets_only_that_legs_term():
    keyword_leg = LegResult(ranked_chunk_ids=["A", "B"], rows_by_chunk_id={})
    dense_leg = LegResult(ranked_chunk_ids=["B"], rows_by_chunk_id={})
    fused = reciprocal_rank_fusion({"keyword": keyword_leg, "dense": dense_leg}, k=RRF_K)
    fused_by_id = {chunk_id: score for chunk_id, score, _ in fused}

    assert fused_by_id["A"] == pytest.approx(1 / (RRF_K + 1))  # keyword rank 1 only
    assert fused_by_id["B"] == pytest.approx(1 / (RRF_K + 2) + 1 / (RRF_K + 1))


def test_rrf_uses_k_equal_60_from_config():
    config = retrieve.load_retrieval_config()
    assert config.rrf_k == 60


def test_rrf_ranking_is_position_based_not_score_based():
    # The defining property: construct two legs whose RAW per-leg scores
    # (stored in rows_by_chunk_id, deliberately nonsensical/misleading
    # here) say one thing, but whose RANK ORDER says another. The fused
    # ranking must follow rank order only -- reciprocal_rank_fusion()
    # never reads rows_by_chunk_id at all.
    keyword_leg = LegResult(
        ranked_chunk_ids=["low_score_but_rank_1", "huge_score_but_rank_2"],
        rows_by_chunk_id={
            "low_score_but_rank_1": {"keyword_score": 0.001},
            "huge_score_but_rank_2": {"keyword_score": 999.0},
        },
    )
    dense_leg = LegResult(ranked_chunk_ids=[], rows_by_chunk_id={})

    fused = reciprocal_rank_fusion({"keyword": keyword_leg, "dense": dense_leg}, k=RRF_K)

    assert fused[0][0] == "low_score_but_rank_1", (
        "RRF must rank by POSITION (rank 1 beats rank 2) even though the "
        "raw per-leg score stored alongside it says the opposite -- "
        "fusion must not add/average/normalize/weight raw scores"
    )
    assert fused[0][1] > fused[1][1]


def test_rrf_does_not_read_any_score_field_from_leg_rows():
    # A stronger version of the above: rows_by_chunk_id can be completely
    # EMPTY (no score field to read at all) and the fused result must be
    # identical to a run where rows carry misleading scores -- proving
    # the fusion math has literally no dependency on that data.
    leg_with_scores = LegResult(
        ranked_chunk_ids=["A", "B", "C"],
        rows_by_chunk_id={
            "A": {"keyword_score": 5.0},
            "B": {"keyword_score": 500.0},
            "C": {"keyword_score": 0.5},
        },
    )
    leg_without_scores = LegResult(ranked_chunk_ids=["A", "B", "C"], rows_by_chunk_id={})

    fused_with = reciprocal_rank_fusion({"keyword": leg_with_scores}, k=RRF_K)
    fused_without = reciprocal_rank_fusion({"keyword": leg_without_scores}, k=RRF_K)

    assert fused_with == fused_without


def test_rrf_is_symmetric_in_leg_naming_not_hardcoded_to_keyword_dense():
    # Fusion takes an arbitrary dict of named legs -- proving it isn't
    # secretly hardcoded to expect exactly "keyword"/"dense" keys.
    leg_a = LegResult(ranked_chunk_ids=["X"], rows_by_chunk_id={})
    leg_b = LegResult(ranked_chunk_ids=["X"], rows_by_chunk_id={})
    fused = reciprocal_rank_fusion({"legA": leg_a, "legB": leg_b}, k=RRF_K)
    assert fused == [("X", pytest.approx(2 / (RRF_K + 1)), {"legA": 1, "legB": 1})]


def test_rrf_breaks_score_ties_by_chunk_id_for_determinism():
    leg = LegResult(ranked_chunk_ids=["Z"], rows_by_chunk_id={})
    other_leg = LegResult(ranked_chunk_ids=["A"], rows_by_chunk_id={})
    # Both "Z" (rank 1 in leg) and "A" (rank 1 in other_leg) get the same
    # fused score (1/(k+1)) -- tie must break deterministically.
    fused = reciprocal_rank_fusion({"leg": leg, "other": other_leg}, k=RRF_K)
    assert [chunk_id for chunk_id, _, _ in fused] == ["A", "Z"]


# --- literal section-id extraction (pure function, no DB) ----------------


def test_extracts_literal_section_id_from_query_text():
    assert _extract_literal_section_id("what does NWP-POL-006-01 say") == "NWP-POL-006-01"


def test_extracts_literal_section_id_with_subsection():
    assert _extract_literal_section_id("see NWP-POL-001-02.01 please") == "NWP-POL-001-02.01"


def test_extracts_literal_section_id_case_insensitively():
    assert _extract_literal_section_id("nwp-pol-006-01") == "NWP-POL-006-01"


def test_no_literal_section_id_in_ordinary_query():
    assert _extract_literal_section_id("what is the mileage rate") is None


def test_to_tsquery_or_terms_ors_query_words():
    assert _to_tsquery_or_terms("mileage rate") == "mileage | rate"


def test_to_tsquery_or_terms_empty_for_no_words():
    assert _to_tsquery_or_terms("???") == ""


# --- live-database tests (skipped if Postgres unreachable) --------------


def _connection_or_skip():
    import os

    import psycopg

    database_uri = os.environ.get("DATABASE_URI")
    if not database_uri:
        pytest.skip("DATABASE_URI not set")
    try:
        connection = psycopg.connect(database_uri, connect_timeout=2)
    except Exception as exc:  # noqa: BLE001
        pytest.skip(f"Postgres not reachable: {exc}")
    return connection


@pytest.fixture()
def db_connection():
    connection = _connection_or_skip()
    yield connection
    connection.close()


@pytest.fixture()
def has_real_corpus_loaded(db_connection):
    with db_connection.cursor() as cursor:
        cursor.execute(
            "select count(*) from retrieval.corpus_chunk where tenant_id = %(tenant_id)s",
            {"tenant_id": REAL_TENANT_ID},
        )
        count = cursor.fetchone()[0]
    if count == 0:
        pytest.skip("corpus not loaded for the real tenant -- run embed.py first")
    return count


def test_keyword_leg_literal_section_id_ranks_that_chunk_first(
    db_connection, has_real_corpus_loaded
):
    leg = _keyword_leg(db_connection, REAL_TENANT_ID, "NWP-POL-006-01", limit=20)
    assert leg.ranked_chunk_ids[0] == "NWP-POL-006-01", (
        "a literal section id in the query must rank its own defining "
        "chunk first in the keyword leg, regardless of tsvector fuzziness"
    )


def test_keyword_leg_is_tenant_scoped(db_connection, has_real_corpus_loaded):
    leg = _keyword_leg(db_connection, "tenant-does-not-exist", "receipt threshold", limit=20)
    assert leg.ranked_chunk_ids == []


def test_dense_leg_is_tenant_scoped(db_connection, has_real_corpus_loaded):
    fake_embedding = [0.001] * 1536
    leg = retrieve._dense_leg(db_connection, "tenant-does-not-exist", fake_embedding, limit=20)
    assert leg.ranked_chunk_ids == []


def _fetch_embedding_as_list(db_connection, chunk_id: str, tenant_id: str) -> list[float]:
    # _dense_leg()/retrieve() take query_embedding as list[float] (what a
    # real caller gets back from embed_query_text() / the OpenAI SDK) and
    # format it themselves via _vector_literal() -- psycopg returns a
    # stored vector column as an already-formatted '[x,y,...]' string, so
    # tests that fetch a real stored embedding to use AS a query embedding
    # must parse it back into a list first, matching what a real caller
    # would actually pass in.
    with db_connection.cursor() as cursor:
        cursor.execute(
            "select embedding from retrieval.corpus_chunk "
            "where tenant_id = %(tenant_id)s and chunk_id = %(chunk_id)s",
            {"tenant_id": tenant_id, "chunk_id": chunk_id},
        )
        (embedding_str,) = cursor.fetchone()
    return [float(x) for x in embedding_str.strip("[]").split(",")]


def test_dense_leg_orders_by_cosine_distance_ascending(db_connection, has_real_corpus_loaded):
    embedding = _fetch_embedding_as_list(db_connection, "NWP-POL-006-01", REAL_TENANT_ID)

    leg = retrieve._dense_leg(db_connection, REAL_TENANT_ID, embedding, limit=5)
    # Querying with a chunk's OWN embedding must rank that exact chunk
    # first (cosine distance to itself is 0, the minimum possible).
    assert leg.ranked_chunk_ids[0] == "NWP-POL-006-01"


def test_candidates_per_leg_is_honored_as_a_hard_limit(db_connection, has_real_corpus_loaded):
    leg = _keyword_leg(db_connection, REAL_TENANT_ID, "policy expense report travel", limit=3)
    assert len(leg.ranked_chunk_ids) <= 3


def test_retrieve_end_to_end_result_shape(db_connection, has_real_corpus_loaded):
    embedding = _fetch_embedding_as_list(db_connection, "NWP-POL-006-01", REAL_TENANT_ID)

    config = RetrievalConfig(rrf_k=60, top_k=5, candidates_per_leg=20)
    results = run_retrieve(
        db_connection, REAL_TENANT_ID, "receipt threshold for meals", embedding, config
    )

    assert 1 <= len(results) <= 5
    for result in results:
        assert result.chunk_id
        assert result.source.startswith("data/corpus/")
        assert result.section_id
        assert result.offset >= 0
        assert result.text
        assert isinstance(result.fused_score, float)
        assert result.keyword_rank is not None or result.dense_rank is not None


def test_retrieve_never_returns_another_tenants_chunks(db_connection, has_real_corpus_loaded):
    fake_embedding = [0.001] * 1536
    config = RetrievalConfig(rrf_k=60, top_k=5, candidates_per_leg=20)
    results = run_retrieve(
        db_connection, "tenant-does-not-exist", "receipt threshold", fake_embedding, config
    )
    assert results == []


def test_retrieve_literal_section_id_query_returns_that_chunk_first(
    db_connection, has_real_corpus_loaded
):
    # Use an embedding that is a poor dense match (all-zero-ish vector)
    # so the dense leg alone would NOT favor NWP-POL-012-05 -- proving
    # the literal-id guarantee holds even against an unfavorable dense
    # leg, not just when both legs happen to agree.
    fake_embedding = [0.001] * 1536
    config = RetrievalConfig(rrf_k=60, top_k=5, candidates_per_leg=20)
    results = run_retrieve(
        db_connection, REAL_TENANT_ID, "NWP-POL-012-05", fake_embedding, config
    )
    assert results[0].chunk_id == "NWP-POL-012-05", (
        "a literal section id in the query text must be retrievable as "
        "the #1 result, not merely present somewhere in the fused list"
    )
