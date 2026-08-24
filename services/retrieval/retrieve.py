"""Hybrid retrieval over retrieval.corpus_chunk: a keyword (tsvector) leg,
a dense (vector cosine) leg, and Reciprocal Rank Fusion (RRF) combining
their two rankings into one. Reranking (services/retrieval/retrieval.toml's
[rerank] section -- gpt-4o-mini) is a later, separate pass over this
module's fused output and is not implemented here.

Both legs query the SAME table (retrieval.corpus_chunk -- see
services/retrieval/db/migrations/0001_corpus_chunks.sql) and BOTH legs
filter on tenant_id themselves (see _keyword_leg()/_dense_leg()'s own
"where tenant_id = %(tenant_id)s" clauses) -- there is no shared "fetch
candidates, then filter by tenant after the fact" step, so a bug in one
leg's query cannot silently leak another tenant's chunks through the
other leg.

Why RRF is rank-based, not score-based (the requirement this module and
its tests must uphold): the keyword leg's score is a Postgres
ts_rank_cd() value (roughly: term-frequency-weighted, unbounded above,
corpus/query-dependent scale) and the dense leg's score is a cosine
distance in [0, 2] converted to a similarity in [0, 1]. These two
numbers are not commensurable -- there's no principled way to add,
average, or weight them together, since a 0.7 from one leg does not mean
"as relevant as" a 0.7 from the other. RRF sidesteps this entirely: it
only ever asks "which rank did this chunk have in this leg's own
ordering", never "how big was its own-leg score". score(chunk) = sum
over each leg the chunk appeared in of 1 / (k + rank), where rank is
1-based position within that leg's own result list and k = 60 (the
constant from the original paper -- Cormack, Clarke & Buettcher 2009;
see retrieval.toml's [retrieval] section, not tuned per-corpus here).
"""

from __future__ import annotations

import re
import tomllib
from dataclasses import dataclass
from pathlib import Path

RETRIEVAL_DIR = Path(__file__).resolve().parent
RETRIEVAL_TOML_PATH = RETRIEVAL_DIR / "retrieval.toml"

SECTION_ID_PATTERN = re.compile(r"NWP-POL-\d{3}-\d{2}(?:\.\d{2})?")
"""Same NWP-POL-<doc>-<section>[.<subsection>] shape corpus_check.py and
chunker.py already use (see data/corpus/CORPUS-SPEC.md). Used here to
detect a literal section id embedded in free-text query input, e.g. "what
does NWP-POL-006-01 say about receipts" -- see _extract_literal_section_id().
"""


@dataclass(frozen=True)
class RetrievalConfig:
    rrf_k: int
    top_k: int
    candidates_per_leg: int


def load_retrieval_config(path: Path = RETRIEVAL_TOML_PATH) -> RetrievalConfig:
    with path.open("rb") as f:
        data = tomllib.load(f)
    retrieval = data["retrieval"]
    return RetrievalConfig(
        rrf_k=retrieval["rrf_k"],
        top_k=retrieval["top_k"],
        candidates_per_leg=retrieval["candidates_per_leg"],
    )


@dataclass(frozen=True)
class EmbeddingConfig:
    provider: str
    model: str
    dimensions: int


def load_embedding_config(path: Path = RETRIEVAL_TOML_PATH) -> EmbeddingConfig:
    with path.open("rb") as f:
        data = tomllib.load(f)
    embedding = data["embedding"]
    return EmbeddingConfig(
        provider=embedding["provider"],
        model=embedding["model"],
        dimensions=embedding["dimensions"],
    )


@dataclass(frozen=True)
class RetrievedChunk:
    """One fused result. Every field a caller (eval harness, a later
    reranker, a citation-rendering UI) needs is present directly on this
    object -- no second lookup back into Postgres or the corpus files is
    required to show or cite a result.
    """

    chunk_id: str
    source: str
    section_id: str
    offset: int
    text: str
    fused_score: float
    keyword_rank: int | None
    """1-based rank in the keyword leg's own ranking, or None if this
    chunk did not appear in the keyword leg's candidate list at all."""
    dense_rank: int | None
    """1-based rank in the dense leg's own ranking, or None if this chunk
    did not appear in the dense leg's candidate list at all."""


@dataclass(frozen=True)
class LegResult:
    """One leg's own ranking: chunk_id in rank order (index 0 = rank 1),
    plus every chunk's row data keyed by chunk_id so the fusion step can
    assemble RetrievedChunk objects without a second query."""

    ranked_chunk_ids: list[str]
    rows_by_chunk_id: dict[str, dict]


# --- keyword leg -----------------------------------------------------

_KEYWORD_LEG_SQL = """
select chunk_id, source, section_id, chunk_offset, chunk_text,
       ts_rank_cd(search_vector, query) as keyword_score
from retrieval.corpus_chunk, to_tsquery('english', %(tsquery)s) as query
where tenant_id = %(tenant_id)s
  and search_vector @@ query
order by keyword_score desc, chunk_id asc
limit %(limit)s
"""

_EXACT_SECTION_ID_SQL = """
select chunk_id, source, section_id, chunk_offset, chunk_text
from retrieval.corpus_chunk
where tenant_id = %(tenant_id)s
  and section_id = %(section_id)s
"""


def _extract_literal_section_id(query_text: str) -> str | None:
    """If the query text contains a literal NWP-POL-<doc>-<section> string,
    return it (uppercased to match the corpus's own casing convention --
    see data/corpus/CORPUS-SPEC.md's section-identifier pattern). Returns
    None for ordinary natural-language queries with no embedded id."""
    match = SECTION_ID_PATTERN.search(query_text.upper())
    return match.group(0) if match else None


def _to_tsquery_or_terms(query_text: str) -> str:
    """Builds a to_tsquery() input string that ORs together the individual
    words of the query -- a natural-language question should match a chunk
    containing ANY of its meaningful terms (ts_rank_cd then ranks by how
    many/how weighted), not require every single word to be present."""
    words = re.findall(r"[A-Za-z0-9]+", query_text)
    if not words:
        return ""
    return " | ".join(words)


def _keyword_leg(connection, tenant_id: str, query_text: str, limit: int) -> LegResult:
    """Keyword (tsvector) leg, tenant-scoped inside this function's own
    query (both leg functions filter tenant_id themselves -- see module
    docstring). Guarantees literal section-id retrieval (a documented
    requirement, and one plain tsvector matching cannot reliably satisfy
    on its own -- see this module's docstring / the prompt-journal entry
    for why: to_tsquery on a hyphenated id like 'NWP-POL-006-01' also
    matches chunks that merely CITE that id in cross-reference prose, so a
    literal id match is resolved as an explicit equality lookup and always
    ranked first, ahead of ordinary tsvector-ranked results for the rest
    of the query terms.
    """
    ranked_chunk_ids: list[str] = []
    rows_by_chunk_id: dict[str, dict] = {}

    literal_section_id = _extract_literal_section_id(query_text)
    if literal_section_id is not None:
        with connection.cursor() as cursor:
            cursor.execute(
                _EXACT_SECTION_ID_SQL,
                {"tenant_id": tenant_id, "section_id": literal_section_id},
            )
            columns = [d.name for d in cursor.description]
            for row in cursor.fetchall():
                row_dict = dict(zip(columns, row))
                chunk_id = row_dict["chunk_id"]
                if chunk_id not in rows_by_chunk_id:
                    ranked_chunk_ids.append(chunk_id)
                    rows_by_chunk_id[chunk_id] = row_dict

    remaining = limit - len(ranked_chunk_ids)
    tsquery_input = _to_tsquery_or_terms(query_text)
    if remaining > 0 and tsquery_input:
        with connection.cursor() as cursor:
            cursor.execute(
                _KEYWORD_LEG_SQL,
                {"tenant_id": tenant_id, "tsquery": tsquery_input, "limit": limit},
            )
            columns = [d.name for d in cursor.description]
            for row in cursor.fetchall():
                row_dict = dict(zip(columns, row))
                chunk_id = row_dict["chunk_id"]
                if chunk_id in rows_by_chunk_id:
                    continue  # already ranked first via the literal-id match above
                if len(ranked_chunk_ids) >= limit:
                    break
                ranked_chunk_ids.append(chunk_id)
                rows_by_chunk_id[chunk_id] = row_dict

    return LegResult(ranked_chunk_ids=ranked_chunk_ids, rows_by_chunk_id=rows_by_chunk_id)


# --- dense leg -----------------------------------------------------------

_DENSE_LEG_SQL = """
select chunk_id, source, section_id, chunk_offset, chunk_text,
       1 - (embedding <=> %(query_embedding)s) as cosine_similarity
from retrieval.corpus_chunk
where tenant_id = %(tenant_id)s
  and embedding is not null
order by embedding <=> %(query_embedding)s asc
limit %(limit)s
"""

_ANN_FIRST_DENSE_LEG_SQL = """
select chunk_id, source, section_id, chunk_offset, chunk_text, cosine_similarity
from (
    select tenant_id, chunk_id, source, section_id, chunk_offset, chunk_text,
           embedding <=> %(query_embedding)s as cosine_distance,
           1 - (embedding <=> %(query_embedding)s) as cosine_similarity
    from retrieval.corpus_chunk
    where embedding is not null
    order by embedding <=> %(query_embedding)s asc
    limit %(ann_limit)s
) nearest
where tenant_id = %(tenant_id)s
order by cosine_distance asc, chunk_id asc
limit %(limit)s
"""


def _vector_literal(embedding: list[float]) -> str:
    return "[" + ",".join(repr(x) for x in embedding) + "]"


def _dense_leg(
    connection, tenant_id: str, query_embedding: list[float], limit: int
) -> LegResult:
    """Dense (vector cosine) leg, tenant-scoped inside this function's own
    query -- same tenant-isolation guarantee as _keyword_leg(), enforced
    independently rather than relying on a shared filter applied once
    somewhere else. pgvector's <=> operator is cosine DISTANCE (0 =
    identical, up to 2 = opposite); this query orders by that distance
    ascending (closest first) and also returns 1 - distance as a cosine
    SIMILARITY for display, though similarity/distance values themselves
    are never used in the fusion math (see module docstring: fusion is
    rank-only)."""
    rows = _dense_leg_rows_ann_first(connection, tenant_id, query_embedding, limit)
    if len(rows) < limit:
        rows = _dense_leg_rows_exact_tenant(connection, tenant_id, query_embedding, limit)

    ranked_chunk_ids = [row["chunk_id"] for row in rows]
    rows_by_chunk_id = {row["chunk_id"]: row for row in rows}
    return LegResult(ranked_chunk_ids=ranked_chunk_ids, rows_by_chunk_id=rows_by_chunk_id)


def _dense_ann_limit(limit: int) -> int:
    return max(limit * 10, 100)


def _dense_leg_rows_ann_first(
    connection,
    tenant_id: str,
    query_embedding: list[float],
    limit: int,
) -> list[dict]:
    with connection.cursor() as cursor:
        cursor.execute("set local enable_seqscan = off")
        cursor.execute(
            _ANN_FIRST_DENSE_LEG_SQL,
            {
                "tenant_id": tenant_id,
                "query_embedding": _vector_literal(query_embedding),
                "ann_limit": _dense_ann_limit(limit),
                "limit": limit,
            },
        )
        columns = [d.name for d in cursor.description]
        return [dict(zip(columns, row)) for row in cursor.fetchall()]


def _dense_leg_rows_exact_tenant(
    connection,
    tenant_id: str,
    query_embedding: list[float],
    limit: int,
) -> list[dict]:
    with connection.cursor() as cursor:
        cursor.execute(
            _DENSE_LEG_SQL,
            {
                "tenant_id": tenant_id,
                "query_embedding": _vector_literal(query_embedding),
                "limit": limit,
            },
        )
        columns = [d.name for d in cursor.description]
        return [dict(zip(columns, row)) for row in cursor.fetchall()]


# --- RRF fusion ------------------------------------------------------

def reciprocal_rank_fusion(
    legs: dict[str, LegResult], k: int
) -> list[tuple[str, float, dict[str, int]]]:
    """Fuses N named leg rankings by RANK POSITION ONLY.

    For each chunk_id, fused_score = sum over every leg it appears in of
    1 / (k + rank), where rank is that chunk's 1-based position within
    that leg's own ranked_chunk_ids list. A chunk absent from a leg
    contributes 0 for that leg (not a penalty term, not an imputed worst
    rank) -- it simply has fewer terms summed.

    This function never reads any score/distance/similarity value from
    either leg -- LegResult's rows_by_chunk_id data is not consulted here
    at all, only the ORDER of ranked_chunk_ids. That is what "fusion uses
    rank positions, not raw leg scores" means operationally, and is what
    this module's tests assert directly (constructing LegResults with
    deliberately wrong/absent scores to prove the fused ranking is
    unaffected by them).

    Returns (chunk_id, fused_score, {leg_name: rank}) tuples sorted by
    fused_score descending, chunk_id ascending as a stable tiebreak.
    """
    scores: dict[str, float] = {}
    ranks_by_chunk: dict[str, dict[str, int]] = {}

    for leg_name, leg in legs.items():
        for rank_index, chunk_id in enumerate(leg.ranked_chunk_ids):
            rank = rank_index + 1  # 1-based rank, per the RRF formula
            scores[chunk_id] = scores.get(chunk_id, 0.0) + 1.0 / (k + rank)
            ranks_by_chunk.setdefault(chunk_id, {})[leg_name] = rank

    fused = [(chunk_id, score, ranks_by_chunk[chunk_id]) for chunk_id, score in scores.items()]
    fused.sort(key=lambda item: (-item[1], item[0]))
    return fused


# --- public entrypoint -----------------------------------------------


def retrieve(
    connection,
    tenant_id: str,
    query_text: str,
    query_embedding: list[float],
    config: RetrievalConfig | None = None,
) -> list[RetrievedChunk]:
    """Runs both legs (each independently tenant-scoped -- see
    _keyword_leg()/_dense_leg()), fuses their rankings with RRF, and
    returns the top config.top_k results with full provenance.

    Literal section-id guarantee: if query_text contains a literal
    NWP-POL-<doc>-<section> string, the chunk whose OWN section_id equals
    it is placed first in the returned results unconditionally -- not
    merely favored by RRF. This is deliberately a post-fusion result
    reordering, not a change to reciprocal_rank_fusion()'s own math: that
    function stays purely rank-based (see its docstring and this module's
    tests), and "exact section identifiers must be retrievable literally"
    is enforced here, one layer up, as an explicit guarantee rather than
    an emergent property of RRF scores (which cannot be guaranteed to
    place a rank-1-in-one-leg chunk first overall when a second leg's
    unrelated top hits accumulate a comparable fused score -- verified
    this happens in practice with this corpus before adding this
    short-circuit).

    query_embedding must already be computed with the SAME model and
    dimensions used to index the corpus (services/retrieval/embed.py --
    text-embedding-3-small, 1536 dims, per retrieval.toml's [embedding]
    section) -- this function does not call the embedding API itself, so
    that guarantee is the caller's responsibility (see
    embed_query_text() below for the one place that call is made).
    """
    if config is None:
        config = load_retrieval_config()

    keyword_leg = _keyword_leg(connection, tenant_id, query_text, config.candidates_per_leg)
    dense_leg = _dense_leg(connection, tenant_id, query_embedding, config.candidates_per_leg)

    fused = reciprocal_rank_fusion(
        {"keyword": keyword_leg, "dense": dense_leg}, k=config.rrf_k
    )

    all_rows = {**keyword_leg.rows_by_chunk_id, **dense_leg.rows_by_chunk_id}

    literal_section_id = _extract_literal_section_id(query_text)
    ordered_fused = fused
    if literal_section_id is not None:
        literal_match = next(
            (item for item in fused if all_rows[item[0]]["section_id"] == literal_section_id),
            None,
        )
        if literal_match is not None:
            rest = [item for item in fused if item is not literal_match]
            ordered_fused = [literal_match, *rest]

    results: list[RetrievedChunk] = []
    for chunk_id, fused_score, ranks in ordered_fused[: config.top_k]:
        row = all_rows[chunk_id]
        results.append(
            RetrievedChunk(
                chunk_id=row["chunk_id"],
                source=row["source"],
                section_id=row["section_id"],
                offset=row["chunk_offset"],
                text=row["chunk_text"],
                fused_score=fused_score,
                keyword_rank=ranks.get("keyword"),
                dense_rank=ranks.get("dense"),
            )
        )
    return results


def embed_query_text(query_text: str, api_key: str, config: EmbeddingConfig) -> list[float]:
    """The one place a query is embedded for the dense leg -- always with
    the same model/dimensions the corpus was indexed with (see embed.py's
    identical [embedding] section usage), so a query embedding is always
    comparable to the stored embeddings via cosine distance."""
    from openai import OpenAI

    client = OpenAI(api_key=api_key)
    response = client.embeddings.create(
        input=[query_text], model=config.model, dimensions=config.dimensions
    )
    return response.data[0].embedding


def explain_dense_leg_query_plan(
    connection,
    tenant_id: str,
    query_embedding: list[float],
    limit: int,
) -> list[str]:
    """Return the query plan for the same ANN-first dense-leg SQL shape.

    Tests and evidence use this helper so the HNSW proof cannot silently
    drift away from _dense_leg()'s production dense-search query shape.
    """
    with connection.cursor() as cursor:
        cursor.execute("set local enable_seqscan = off")
        cursor.execute(
            "explain (analyze, buffers) " + _ANN_FIRST_DENSE_LEG_SQL,
            {
                "tenant_id": tenant_id,
                "query_embedding": _vector_literal(query_embedding),
                "ann_limit": _dense_ann_limit(limit),
                "limit": limit,
            },
        )
        return [row[0] for row in cursor.fetchall()]


if __name__ == "__main__":
    import os
    import sys

    import psycopg

    if len(sys.argv) < 2:
        print("usage: python retrieve.py '<query text>' [tenant_id]", file=sys.stderr)
        sys.exit(1)

    cli_query_text = sys.argv[1]
    cli_tenant_id = sys.argv[2] if len(sys.argv) > 2 else "tenant-synthetic-northwind-prairie"

    cli_database_uri = os.environ["DATABASE_URI"]
    cli_api_key = os.environ["OPENAI_API_KEY"]

    cli_embedding_config = load_embedding_config()
    cli_retrieval_config = load_retrieval_config()
    cli_query_embedding = embed_query_text(cli_query_text, cli_api_key, cli_embedding_config)

    with psycopg.connect(cli_database_uri) as cli_connection:
        cli_results = retrieve(
            cli_connection, cli_tenant_id, cli_query_text, cli_query_embedding, cli_retrieval_config
        )

    for cli_rank, cli_result in enumerate(cli_results, start=1):
        print(
            f"{cli_rank}. {cli_result.chunk_id}  fused={cli_result.fused_score:.5f}  "
            f"kw_rank={cli_result.keyword_rank}  dense_rank={cli_result.dense_rank}  "
            f"{cli_result.source}"
        )
