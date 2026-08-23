"""Hierarchical chunker for the synthetic expense-policy corpus in
data/corpus/.

Splits each Markdown document using its own heading structure (H1 title,
then the `NWP-POL-<doc>-<section>[.<subsection>]`-identified H2/H3
headings -- see data/corpus/CORPUS-SPEC.md) rather than a fixed-size
character/token window. A document's real section boundaries are already
known and meaningful here (each one carries a stable, unique identifier),
so cutting chunks anywhere else would separate a heading from the body it
introduces, or split a threshold table away from the prose that explains
what its numbers mean -- both of which this module's tests assert never
happens.

Two-level hierarchy, matching this corpus's actual document shape:

1. Primary split: each top-level identified section (`## ... `id``) is one
   chunk, INCLUDING any nested subsections (`### ... `id.NN``) and any
   Markdown table inside it. This is what keeps a table together with the
   heading/prose that explains its numbers (see test_chunker.py's
   coherent-table assertions) -- a table is never a good split point on
   its own.
2. Fallback split (rarely needed -- see the "Why hierarchical splitting"
   discussion in the retrieval prompt-journal entry for this task; no
   section in the current corpus is close to max_tokens): if a section
   plus its subsections exceeds `max_tokens` from retrieval.toml, split
   at subsection boundaries first, and only fall back to paragraph
   boundaries within a single oversized leaf. Fixed-size character/token
   windows are never the primary strategy and are not implemented here at
   all -- paragraph boundaries are the smallest unit this chunker ever
   cuts on.

This module only chunks already-loaded document text. It does not call
any embedding API and does not write to Postgres -- see
services/retrieval/retrieval.toml's [chunking] section for the configured
max_tokens/overlap_tokens values this module reads, and the module
docstring in a later embedding-loader module (not yet implemented) for
where these Chunk objects go next.
"""

from __future__ import annotations

import hashlib
import re
import tomllib
from dataclasses import dataclass
from pathlib import Path

RETRIEVAL_DIR = Path(__file__).resolve().parent
CORPUS_DIR = RETRIEVAL_DIR.parent.parent / "data" / "corpus"
RETRIEVAL_TOML_PATH = RETRIEVAL_DIR / "retrieval.toml"

FRONT_MATTER_PATTERN = re.compile(r"\A---\n(.*?)\n---\n", re.DOTALL)
SECTION_HEADING_PATTERN = re.compile(
    r"^(#{2,3})\s+.*`([A-Z]+-POL-\d{3}-\d{2}(?:\.\d{2})?)`\s*$", re.MULTILINE
)
"""Generic <PREFIX>-POL-<doc>-<section>[.<subsection>] shape -- NOT
hardcoded to Northwind Prairie's own NWP-POL- prefix. Each fictional
company/tenant in this corpus uses its own prefix (Northwind Prairie:
NWP-POL-, see data/corpus/CORPUS-SPEC.md; Rival Corp:
RVL-POL-, see data/corpus-tenant-b/ -- the tenant-isolation regression
test's adversarial second-tenant content), and the chunker must not
assume there is only ever one company's convention -- the '-POL-' +
3-digit-doc + 2-digit-section shape is the real structural invariant,
the letters before it are not."""
TOP_LEVEL_HEADING_DEPTH = 2  # "##"

# A rough, deterministic token estimate (characters / 4) used only to
# compare against max_tokens/min_tokens. This is intentionally not tied to
# any specific tokenizer -- the embedding loader (not yet implemented)
# will encode the final chunk text with the real text-embedding-3-small
# tokenizer at call time; this estimate exists solely so the chunker can
# reason about size *before* that dependency exists.
_CHARS_PER_TOKEN_ESTIMATE = 4


def estimate_tokens(text: str) -> int:
    return max(1, len(text) // _CHARS_PER_TOKEN_ESTIMATE)


@dataclass(frozen=True)
class ChunkingConfig:
    max_tokens: int
    min_tokens: int
    overlap_tokens: int


def load_chunking_config(path: Path = RETRIEVAL_TOML_PATH) -> ChunkingConfig:
    with path.open("rb") as f:
        data = tomllib.load(f)
    chunking = data["chunking"]
    return ChunkingConfig(
        max_tokens=chunking["max_tokens"],
        min_tokens=chunking["min_tokens"],
        overlap_tokens=chunking["overlap_tokens"],
    )


@dataclass(frozen=True)
class Chunk:
    """One retrievable unit, ready for the (not yet implemented) embedding
    loader. Every field here is part of this module's contract with that
    loader and with citation/evaluation code downstream.
    """

    chunk_id: str
    """Stable, deterministic ID: '{section_id}' when a section fits in one
    chunk (the common case for this corpus), or '{section_id}#{part}' when
    a section had to be split further (see _split_oversized_section).
    Stable across re-runs of unchanged content: it depends only on the
    section id and split position, never on a content hash or a random
    value, so re-chunking the same corpus produces identical IDs -- the
    property test_chunker.py's determinism tests assert."""

    source: str
    """Corpus-relative file path, e.g. 'data/corpus/001-travel-and-mileage-policy.md'."""

    section_id: str
    """The NWP-POL-<doc>-<section>[.<subsection>] identifier of the
    section this chunk was cut from (see data/corpus/CORPUS-SPEC.md).
    Always the top-level section id, even for a chunk that is really a
    subsection-level split of an oversized parent -- section_heading_path
    below carries the more specific heading text."""

    section_heading_path: str
    """Human-readable heading trail, e.g. 'Personal Vehicle Mileage
    Reimbursement' or, for a split subsection chunk, 'Personal Vehicle
    Mileage Reimbursement > Odometer and Mapping Evidence'."""

    doc_title: str
    """The source document's H1 title, for display/citation without a
    second file read."""

    offset: int
    """Character offset of this chunk's text within the ORIGINAL document
    file (post-front-matter body), so a citation can point back to an
    exact location, not just a section id."""

    part_index: int
    """0 for a section that fit in one chunk. Increments for each
    additional part when a section had to be split further (see
    chunk_id)."""

    part_count: int
    """Total number of chunks this section was split into (1 in the
    common case)."""

    text: str
    """The chunk's own Markdown text, including its heading line(s)."""

    token_estimate: int
    """estimate_tokens(text) at chunk-creation time, stored so downstream
    code (and tests) don't need to recompute it or import a tokenizer."""


def _load_front_matter_and_body(text: str) -> tuple[dict, str, int]:
    """Returns (front_matter_dict, body_text, body_start_offset). Only the
    'title' field is parsed out of front matter here -- a bare split on
    the leading '---' block, not a full YAML parse, since this module has
    no need for the rest of the front-matter fields corpus_check.py
    already validates."""
    match = FRONT_MATTER_PATTERN.match(text)
    if not match:
        msg = "document is missing a leading YAML front-matter block"
        raise ValueError(msg)
    body_start = match.end()
    body = text[body_start:]
    title_match = re.search(r"^title:\s*(.+)$", match.group(1), re.MULTILINE)
    title = title_match.group(1).strip().strip('"') if title_match else ""
    return {"title": title}, body, body_start


def _heading_text(heading_line: str, section_id: str) -> str:
    """Strip the leading '#'s, trailing '`section_id`' code span, and
    numeric prefix (e.g. '2. ') from a heading line, leaving just the
    human-readable heading text."""
    text = re.sub(r"^#{2,3}\s+", "", heading_line)
    text = text.replace(f"`{section_id}`", "").strip()
    text = re.sub(r"^\d+(\.\d+)*\.?\s+", "", text)
    return text


_UNIDENTIFIED_TRAILING_HEADING_PATTERN = re.compile(r"^##\s+\S.*$", re.MULTILINE)


def _split_top_level_sections(body: str) -> list[tuple[str, str, int]]:
    """Split a document body into (section_id, section_text, offset)
    triples at TOP-LEVEL ('##') identified-heading boundaries only.
    Nested ('###') subsections stay INSIDE their parent's section_text --
    that is what keeps a subsection's prose and any table together with
    the top-level section that introduces it.

    Every corpus document ends with an unidentified 'Document History'
    '##' heading (see CORPUS-SPEC.md -- it deliberately carries no
    NWP-POL-* id, since it is document metadata, not policy content). A
    naive last-identified-heading-to-end-of-file slice would silently
    absorb that trailing heading's text into the last REAL section's
    chunk, misattributing its content. This function stops each
    document's sections at the first unidentified top-level heading that
    follows the last identified one, so that text is excluded from every
    chunk instead of being attributed to the wrong section."""
    headings = [
        (m.start(), m.group(1), m.group(2))
        for m in SECTION_HEADING_PATTERN.finditer(body)
        if len(m.group(1)) == TOP_LEVEL_HEADING_DEPTH
    ]
    if not headings:
        return []

    document_end = len(body)
    last_identified_start = headings[-1][0]
    for m in _UNIDENTIFIED_TRAILING_HEADING_PATTERN.finditer(body):
        if m.start() > last_identified_start:
            document_end = m.start()
            break

    sections: list[tuple[str, str, int]] = []
    for i, (start, _hashes, section_id) in enumerate(headings):
        end = headings[i + 1][0] if i + 1 < len(headings) else document_end
        sections.append((section_id, body[start:end], start))
    return sections


def _split_oversized_section(
    section_id: str, section_text: str, offset: int, config: ChunkingConfig
) -> list[tuple[str, str, int]]:
    """Fallback for a top-level section (rare in this corpus -- see module
    docstring) that exceeds max_tokens on its own. Splits at nested ('###')
    subsection boundaries first; a subsection that is STILL oversized on
    its own is split at paragraph boundaries (blank-line-separated
    blocks). Never splits mid-table, mid-heading, or at a fixed character
    window: a Markdown table has no blank line inside it, so paragraph
    splitting cannot land inside one.

    Returns (part_label, part_text, part_offset) triples, where
    part_label is a human-readable fragment used to build
    section_heading_path for that part.
    """
    subsection_pattern = re.compile(
        r"^(###)\s+.*`([A-Z]+-POL-\d{3}-\d{2}\.\d{2})`\s*$", re.MULTILINE
    )
    subheadings = list(subsection_pattern.finditer(section_text))

    if not subheadings:
        return _split_by_paragraph(section_text, offset, config)

    parts: list[tuple[str, str, int]] = []
    # Everything before the first subsection heading is the parent
    # section's own intro prose -- keep it as its own leading part rather
    # than silently dropping it or gluing it onto the first subsection.
    first_start = subheadings[0].start()
    if section_text[:first_start].strip():
        parts.append(("", section_text[:first_start], offset))

    for i, m in enumerate(subheadings):
        start = m.start()
        end = subheadings[i + 1].start() if i + 1 < len(subheadings) else len(section_text)
        sub_text = section_text[start:end]
        sub_label = _heading_text(m.group(0).splitlines()[0], m.group(2))
        if estimate_tokens(sub_text) > config.max_tokens:
            parts.extend(_split_by_paragraph(sub_text, offset + start, config, label=sub_label))
        else:
            parts.append((sub_label, sub_text, offset + start))

    return parts


def _split_by_paragraph(
    text: str, offset: int, config: ChunkingConfig, label: str = ""
) -> list[tuple[str, str, int]]:
    """Split on blank-line-separated paragraph boundaries, then greedily
    pack consecutive paragraphs into parts up to max_tokens. A Markdown
    table (a contiguous block of '|'-led lines with no internal blank
    line) is always one paragraph by this definition, so it is never cut
    internally by this fallback."""
    paragraphs = []
    pos = 0
    for m in re.finditer(r"\n{2,}", text):
        paragraphs.append((text[pos : m.start()], pos))
        pos = m.end()
    paragraphs.append((text[pos:], pos))
    paragraphs = [(p, o) for p, o in paragraphs if p.strip()]

    parts: list[tuple[str, str, int]] = []
    current_text = ""
    current_offset = None
    for para, para_offset in paragraphs:
        candidate = f"{current_text}\n\n{para}" if current_text else para
        if current_text and estimate_tokens(candidate) > config.max_tokens:
            parts.append((label, current_text, offset + current_offset))
            current_text = para
            current_offset = para_offset
        else:
            current_text = candidate
            if current_offset is None:
                current_offset = para_offset
    if current_text:
        parts.append((label, current_text, offset + current_offset))
    return parts


def _make_chunk_id(section_id: str, part_index: int, part_count: int) -> str:
    if part_count == 1:
        return section_id
    return f"{section_id}#{part_index}"


def _source_path(path: Path) -> str:
    """Repo-relative path string for provenance (Chunk.source), derived
    from the file's ACTUAL location rather than assuming data/corpus/ --
    a second corpus directory (e.g. data/corpus-tenant-b/, used by the
    tenant-isolation regression test) must produce a source that reflects
    where its file really lives, not a hardcoded data/corpus/ prefix."""
    repo_root = RETRIEVAL_DIR.parent.parent
    try:
        return str(path.resolve().relative_to(repo_root))
    except ValueError:
        # Path isn't under the repo root (e.g. a tmp_path in a test) --
        # fall back to a 'data/<parent-dir-name>/<file-name>' shape so
        # source still reads as a plausible corpus-relative path rather
        # than leaking an absolute filesystem path into stored provenance.
        return f"data/{path.resolve().parent.name}/{path.name}"


def chunk_document(path: Path, config: ChunkingConfig) -> list[Chunk]:
    """Chunk one corpus Markdown file into a list of Chunk objects."""
    raw_text = path.read_text(encoding="utf-8")
    front_matter, body, body_start = _load_front_matter_and_body(raw_text)
    doc_title = front_matter["title"]
    source = _source_path(path)

    top_level_sections = _split_top_level_sections(body)

    chunks: list[Chunk] = []
    for section_id, section_text, rel_offset in top_level_sections:
        heading_line = section_text.splitlines()[0]
        heading_path = _heading_text(heading_line, section_id)
        absolute_offset = body_start + rel_offset

        if estimate_tokens(section_text) <= config.max_tokens:
            chunks.append(
                Chunk(
                    chunk_id=_make_chunk_id(section_id, 0, 1),
                    source=source,
                    section_id=section_id,
                    section_heading_path=heading_path,
                    doc_title=doc_title,
                    offset=absolute_offset,
                    part_index=0,
                    part_count=1,
                    text=section_text,
                    token_estimate=estimate_tokens(section_text),
                )
            )
            continue

        parts = _split_oversized_section(section_id, section_text, rel_offset, config)
        part_count = len(parts)
        for part_index, (sub_label, part_text, part_rel_offset) in enumerate(parts):
            full_path = f"{heading_path} > {sub_label}" if sub_label else heading_path
            chunks.append(
                Chunk(
                    chunk_id=_make_chunk_id(section_id, part_index, part_count),
                    source=source,
                    section_id=section_id,
                    section_heading_path=full_path,
                    doc_title=doc_title,
                    offset=body_start + part_rel_offset,
                    part_index=part_index,
                    part_count=part_count,
                    text=part_text,
                    token_estimate=estimate_tokens(part_text),
                )
            )

    return chunks


def chunk_corpus(
    corpus_dir: Path = CORPUS_DIR, config: ChunkingConfig | None = None
) -> list[Chunk]:
    if config is None:
        config = load_chunking_config()
    chunks: list[Chunk] = []
    for path in sorted(corpus_dir.glob("[0-9][0-9][0-9]-*.md")):
        chunks.extend(chunk_document(path, config))
    return chunks


def content_hash(chunk: Chunk) -> str:
    """A content hash for CHANGE DETECTION (e.g. deciding whether an
    embedding needs to be recomputed), deliberately separate from
    chunk_id. chunk_id names *where* a chunk is (stable across content
    edits that don't change section structure); this hash names *what*
    a chunk currently says (changes whenever the text changes). Keeping
    these two concerns apart means editing a section's numbers doesn't
    silently break every citation that already points at its chunk_id."""
    return hashlib.sha256(chunk.text.encode("utf-8")).hexdigest()


if __name__ == "__main__":
    cfg = load_chunking_config()
    all_chunks = chunk_corpus(config=cfg)
    print(f"{len(all_chunks)} chunks from {CORPUS_DIR}")
    for c in all_chunks[:5]:
        print(f"  {c.chunk_id:24s} {c.token_estimate:4d}tok  {c.source}  {c.section_heading_path}")
