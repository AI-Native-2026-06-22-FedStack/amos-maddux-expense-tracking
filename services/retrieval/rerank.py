"""LLM reranker: takes each question's baseline top-10 candidates (from
services/retrieval/eval/rankings.jsonl's "baseline" entries, produced by
eval/run_baseline.py's chunker.py -> embed.py -> retrieve.py pipeline)
and re-orders them using the reranker model family configured in
retrieval.toml's [rerank] section (gpt-4o-mini).

ONE model request per question. The entire numbered candidate list is
sent together in a single request -- never one request per candidate --
so the model can compare all ten candidates against the question and
against each other in one pass, the way a cross-encoder/rerank prompt is
meant to work. The model returns an ordering of candidate IDs, not new
per-candidate scores to add to anything: the original RRF fused_score is
never reused as the reranking judgment (see _build_prompt() -- it does
not tell the model the fused_score or leg ranks at all, only the
candidate id, section id, and text), and _RerankResponse.validate()
rejects any output that isn't an exact permutation of the supplied
candidate IDs before it's ever used to build a ranking.

Reranking is cached under .cache/rerank/ (see retrieval.toml's [cache]
section for the configured root), keyed by every input that can
materially change the result -- question text, the ordered candidate ID
list, each candidate's own content hash, the RESOLVED model ID (not the
configured alias), the prompt version, and the reranking configuration
(temperature/response format) -- see rerank_cache_key(). A cache hit
never calls the API at all.

Resolved model ID handling: retrieval.toml names a model FAMILY alias
("gpt-4o-mini"), which OpenAI resolves server-side to a concrete dated
model ID (response.model, e.g. "gpt-4o-mini-2024-07-18") that can change
between runs as OpenAI updates what an alias points to. The FIRST
uncached response in a run establishes resolved_model_id for that run;
every subsequent request in the same run must resolve to that same ID
(see RerankRun.resolved_model_id / _check_resolved_model_id_consistent())
-- if OpenAI ever resolves the alias differently mid-run, this raises
rather than silently mixing two different models' orderings into one
rankings.jsonl. Because resolved_model_id is itself part of the cache
key, a later run that resolves to a genuinely different model ID gets
fresh cache misses for that model, rather than reusing the old model's
cached ordering under a new model's name.
"""

from __future__ import annotations

import hashlib
import json
import tomllib
from dataclasses import dataclass
from pathlib import Path

RETRIEVAL_DIR = Path(__file__).resolve().parent
RETRIEVAL_TOML_PATH = RETRIEVAL_DIR / "retrieval.toml"

PROMPT_VERSION = "rerank-v2"
"""Bumped whenever _build_prompt()'s wording changes in a way that could
change model output -- part of the cache key so an old cached ordering
from a different prompt is never silently reused under a new prompt."""

RERANK_TEMPERATURE = 0.0
"""Deterministic-as-possible reranking judgment; part of the reranking
configuration folded into the cache key (see RerankConfig)."""


@dataclass(frozen=True)
class RerankConfig:
    provider: str
    model: str
    """The configured FAMILY ALIAS from retrieval.toml (e.g.
    "gpt-4o-mini") -- NOT the resolved model ID. See module docstring."""
    temperature: float
    prompt_version: str


def load_rerank_config(path: Path = RETRIEVAL_TOML_PATH) -> RerankConfig:
    with path.open("rb") as f:
        data = tomllib.load(f)
    rerank = data["rerank"]
    return RerankConfig(
        provider=rerank["provider"],
        model=rerank["model"],
        temperature=RERANK_TEMPERATURE,
        prompt_version=PROMPT_VERSION,
    )


def _default_cache_dir() -> Path:
    with RETRIEVAL_TOML_PATH.open("rb") as f:
        data = tomllib.load(f)
    cache_root = RETRIEVAL_DIR / data["cache"]["directory"]
    return cache_root / "rerank"


DEFAULT_CACHE_DIR = _default_cache_dir()


@dataclass(frozen=True)
class Candidate:
    """One baseline candidate handed to the reranker. content_hash is the
    candidate's own text hash (same sha256-of-text approach as
    chunker.content_hash()), used both to detect a changed chunk and as
    part of the rerank cache key -- so a candidate whose underlying text
    changed (re-chunked/re-embedded corpus) never reuses a stale reranked
    position for the old text."""

    chunk_id: str
    section_id: str
    source: str
    text: str
    content_hash: str


def candidate_content_hash(text: str) -> str:
    return hashlib.sha256(text.encode("utf-8")).hexdigest()


@dataclass(frozen=True)
class RerankedResult:
    rank: int
    chunk_id: str
    """1-based position in the MODEL's returned ordering for this
    candidate -- this is the reranking judgment. Deliberately not a
    reused/derived fused_score: see module docstring."""


class RerankValidationError(ValueError):
    """Raised when the model's returned ordering fails validation --
    malformed output must never silently corrupt the ranking."""


def _build_prompt(question: str, candidates: list[Candidate]) -> str:
    """Builds the single combined prompt for one question + its entire
    numbered candidate list. Deliberately omits fused_score/keyword_rank/
    dense_rank -- the model must judge relevance from the question and
    candidate content alone, not from the retriever's own opinion of
    itself (the requirement this module and its tests must uphold: do
    not reuse the original retrieval scores as the reranking judgment).
    """
    numbered_candidates = "\n\n".join(
        f"[{i}] id={c.chunk_id} section={c.section_id}\n{c.text}"
        for i, c in enumerate(candidates, start=1)
    )
    candidate_ids = ", ".join(c.chunk_id for c in candidates)
    return (
        "You are ranking candidate policy document excerpts by how well "
        "each one answers the given question, from MOST relevant to LEAST "
        "relevant.\n\n"
        f"Question: {question}\n\n"
        f"Candidates:\n{numbered_candidates}\n\n"
        "Return your answer as a JSON object with a single key "
        '"ranked_ids", whose value is an array of the candidate "id" '
        "strings above, reordered from most to least relevant to the "
        f"question. There are exactly {len(candidates)} candidate ids, so "
        f'"ranked_ids" must contain exactly {len(candidates)} strings. '
        "Every id from the candidate list must appear exactly once, including "
        "ids that seem irrelevant. Do not return only the top matches. Do not "
        "invent ids that are not in the candidate list.\n\n"
        f"Required candidate ids: {candidate_ids}"
    )


def _call_rerank_api(
    client, model: str, question: str, candidates: list[Candidate]
) -> tuple[str, list[str]]:
    """Makes ONE chat completion request containing the question and the
    entire numbered candidate list together. Returns (resolved_model_id,
    raw_ranked_ids) -- raw_ranked_ids is NOT yet validated against the
    supplied candidates; see validate_ranked_ids()."""
    prompt = _build_prompt(question, candidates)
    response = client.chat.completions.create(
        model=model,
        temperature=RERANK_TEMPERATURE,
        response_format={"type": "json_object"},
        messages=[{"role": "user", "content": prompt}],
    )
    resolved_model_id = response.model
    raw_content = response.choices[0].message.content
    try:
        parsed = json.loads(raw_content)
    except json.JSONDecodeError as exc:
        raise RerankValidationError(
            f"model response was not valid JSON: {raw_content!r}"
        ) from exc

    if not isinstance(parsed, dict) or "ranked_ids" not in parsed:
        raise RerankValidationError(
            f"model response JSON is missing the required 'ranked_ids' key: {parsed!r}"
        )
    ranked_ids = parsed["ranked_ids"]
    if not isinstance(ranked_ids, list) or not all(isinstance(x, str) for x in ranked_ids):
        raise RerankValidationError(
            f"'ranked_ids' must be a list of strings, got: {ranked_ids!r}"
        )
    return resolved_model_id, ranked_ids


def validate_ranked_ids(ranked_ids: list[str], candidates: list[Candidate]) -> list[str]:
    """Validates that ranked_ids is an EXACT permutation of the supplied
    candidate ids -- same set, same count, no duplicates, no invented
    ids. This is the boundary that stops malformed model output from
    silently corrupting the ranking: any deviation raises
    RerankValidationError rather than being coerced, truncated, or
    padded into something that looks plausible.
    """
    expected_ids = {c.chunk_id for c in candidates}
    returned_ids = ranked_ids

    if len(returned_ids) != len(set(returned_ids)):
        seen = set()
        duplicates = {x for x in returned_ids if x in seen or seen.add(x)}
        raise RerankValidationError(f"model returned duplicate candidate ids: {duplicates}")

    returned_set = set(returned_ids)
    missing = expected_ids - returned_set
    if missing:
        raise RerankValidationError(
            f"model response is missing {len(missing)} candidate id(s) "
            f"that were supplied: {missing}"
        )

    invented = returned_set - expected_ids
    if invented:
        raise RerankValidationError(
            f"model response invented {len(invented)} candidate id(s) "
            f"that were never supplied: {invented}"
        )

    if len(returned_ids) != len(candidates):
        raise RerankValidationError(
            f"model returned {len(returned_ids)} ids, expected exactly {len(candidates)}"
        )

    return returned_ids


# --- cache -----------------------------------------------------------


def rerank_cache_key(
    question: str,
    candidates: list[Candidate],
    resolved_model_id: str,
    config: RerankConfig,
) -> str:
    """Cache key covering every input that can materially change the
    reranked result: question text, the ORDERED candidate id list (order
    matters -- a different baseline ordering is a different prompt),
    each candidate's own content_hash (so a changed chunk's stale
    reranking is never reused), the RESOLVED model id (not the
    configured family alias -- see module docstring), the prompt
    version, and the reranking configuration (temperature). Deliberately
    NOT keyed by fused_score/keyword_rank/dense_rank -- those aren't
    part of what's sent to the model at all (see _build_prompt()), so
    they can't be part of what makes a cache entry valid or stale.
    """
    payload = {
        "question": question,
        "candidate_ids_in_order": [c.chunk_id for c in candidates],
        "candidate_content_hashes": [c.content_hash for c in candidates],
        "resolved_model_id": resolved_model_id,
        "prompt_version": config.prompt_version,
        "temperature": config.temperature,
    }
    canonical = json.dumps(payload, sort_keys=True, separators=(",", ":"))
    return hashlib.sha256(canonical.encode("utf-8")).hexdigest()


def _cache_path(cache_dir: Path, key: str) -> Path:
    return cache_dir / f"{key}.json"


def _load_from_cache(cache_dir: Path, key: str) -> list[str] | None:
    path = _cache_path(cache_dir, key)
    if not path.exists():
        return None
    with path.open("r", encoding="utf-8") as f:
        data = json.load(f)
    return data["ranked_ids"]


def _save_to_cache(
    cache_dir: Path, key: str, ranked_ids: list[str], resolved_model_id: str
) -> None:
    cache_dir.mkdir(parents=True, exist_ok=True)
    path = _cache_path(cache_dir, key)
    payload = {"ranked_ids": ranked_ids, "resolved_model_id": resolved_model_id}
    tmp_path = path.with_suffix(".json.tmp")
    with tmp_path.open("w", encoding="utf-8") as f:
        json.dump(payload, f)
    tmp_path.replace(path)


def _last_resolved_model_id_path(cache_dir: Path, config: RerankConfig) -> Path:
    # Keyed by configured model FAMILY, not a fixed filename -- if
    # retrieval.toml's [rerank].model is ever changed to a different
    # family, that family's own last-known resolved id is tracked
    # separately rather than colliding with a different family's record.
    safe_family = "".join(c if c.isalnum() else "_" for c in config.model)
    return cache_dir / f"last_resolved_model_id.{safe_family}.json"


def _load_last_resolved_model_id(cache_dir: Path, config: RerankConfig) -> str | None:
    """Best-effort GUESS at what resolved_model_id a fresh run will get,
    read from a small file this module writes after each successful API
    call (see _save_last_resolved_model_id()). This is only ever used to
    attempt ONE cache lookup before the first API call of a run -- it is
    never trusted as ground truth. If the guess is wrong (the real API
    response resolves to something else), the guess is simply discarded
    and normal behavior (call the API, use whatever id it actually
    returns) takes over -- see Reranker.rerank()."""
    path = _last_resolved_model_id_path(cache_dir, config)
    if not path.exists():
        return None
    try:
        with path.open("r", encoding="utf-8") as f:
            data = json.load(f)
        return data["resolved_model_id"]
    except (json.JSONDecodeError, KeyError, OSError):
        return None


def _save_last_resolved_model_id(
    cache_dir: Path, config: RerankConfig, resolved_model_id: str
) -> None:
    cache_dir.mkdir(parents=True, exist_ok=True)
    path = _last_resolved_model_id_path(cache_dir, config)
    tmp_path = path.with_suffix(".json.tmp")
    with tmp_path.open("w", encoding="utf-8") as f:
        json.dump({"resolved_model_id": resolved_model_id}, f)
    tmp_path.replace(path)


# --- rerank run --------------------------------------------------------


@dataclass
class RerankStats:
    cache_hits: int = 0
    cache_misses: int = 0
    api_requests: int = 0


class ResolvedModelMismatchError(RuntimeError):
    """Raised when a later API call in the same run resolves to a
    different model id than the run's first uncached call established.
    Prevents silently mixing two different models' orderings into one
    rankings.jsonl -- see module docstring."""


class Reranker:
    """One Reranker instance = one run's worth of resolved-model-id
    consistency tracking. The first uncached API response in the run's
    lifetime sets self.resolved_model_id; every later API call in the
    same run must match it (a cache HIT never triggers this check at
    all, since a hit means resolved_model_id was already part of the key
    that produced the hit)."""

    def __init__(
        self,
        config: RerankConfig,
        api_key: str,
        cache_dir: Path = DEFAULT_CACHE_DIR,
        stats: RerankStats | None = None,
    ) -> None:
        from openai import OpenAI

        self.config = config
        self.cache_dir = cache_dir
        self.stats = stats if stats is not None else RerankStats()
        self._client = OpenAI(api_key=api_key)
        self.resolved_model_id: str | None = None

    def rerank(self, question: str, candidates: list[Candidate]) -> list[RerankedResult]:
        if not candidates:
            return []

        # cache_probe_model_id is what THIS run has confirmed so far
        # (None until the first real API response). Before that's known,
        # try ONE cache lookup under the LAST model id a previous run
        # confirmed and persisted (see _load_last_resolved_model_id) --
        # a guess, never trusted as ground truth. If it hits, this run
        # never has to call the API to learn what it already knows from
        # a prior run; if it misses (wrong guess, or no prior run), fall
        # through to the API exactly as before.
        cache_probe_model_id = self.resolved_model_id
        used_guessed_model_id = False
        if cache_probe_model_id is None:
            cache_probe_model_id = _load_last_resolved_model_id(self.cache_dir, self.config)
            used_guessed_model_id = cache_probe_model_id is not None

        cached_ranked_ids: list[str] | None = None
        if cache_probe_model_id is not None:
            key = rerank_cache_key(question, candidates, cache_probe_model_id, self.config)
            cached_ranked_ids = _load_from_cache(self.cache_dir, key)

        if cached_ranked_ids is not None:
            self.stats.cache_hits += 1
            if used_guessed_model_id and self.resolved_model_id is None:
                # The guess paid off: this run can now trust it as the
                # confirmed resolved_model_id for every later question,
                # without ever having called the API to learn it.
                self.resolved_model_id = cache_probe_model_id
            validated = validate_ranked_ids(cached_ranked_ids, candidates)
            return self._to_results(validated)

        self.stats.cache_misses += 1
        self.stats.api_requests += 1
        resolved_model_id, raw_ranked_ids = _call_rerank_api(
            self._client, self.config.model, question, candidates
        )

        if self.resolved_model_id is None:
            self.resolved_model_id = resolved_model_id
        elif self.resolved_model_id != resolved_model_id:
            raise ResolvedModelMismatchError(
                f"this run already established resolved_model_id="
                f"{self.resolved_model_id!r} from an earlier request, but "
                f"a later request for the same configured model family "
                f"{self.config.model!r} resolved to {resolved_model_id!r} "
                f"instead -- refusing to mix two different models' "
                f"orderings into one rankings.jsonl run"
            )

        validated = validate_ranked_ids(raw_ranked_ids, candidates)

        key = rerank_cache_key(question, candidates, resolved_model_id, self.config)
        _save_to_cache(self.cache_dir, key, validated, resolved_model_id)
        _save_last_resolved_model_id(self.cache_dir, self.config, resolved_model_id)

        return self._to_results(validated)

    def _to_results(self, ranked_ids: list[str]) -> list[RerankedResult]:
        return [
            RerankedResult(rank=i, chunk_id=chunk_id)
            for i, chunk_id in enumerate(ranked_ids, start=1)
        ]
