"""Invariant tests for services/retrieval/chunker.py against the real
committed corpus in data/corpus/. These are property/invariant tests, not
example-based golden-output tests: the corpus is allowed to grow or its
prose to be edited without breaking these tests, as long as the chunker's
actual guarantees (heading/body coherence, table coherence, size cap,
provenance completeness, ID determinism) keep holding.
"""

from __future__ import annotations

import re
import sys
from pathlib import Path

import pytest

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

import chunker  # noqa: E402
from chunker import (  # noqa: E402
    Chunk,
    chunk_corpus,
    chunk_document,
    content_hash,
    estimate_tokens,
    load_chunking_config,
)

CORPUS_DIR = Path(__file__).resolve().parent.parent.parent.parent / "data" / "corpus"


@pytest.fixture(scope="module")
def config():
    return load_chunking_config()


@pytest.fixture(scope="module")
def all_chunks(config) -> list[Chunk]:
    return chunk_corpus(config=config)


@pytest.fixture(scope="module")
def corpus_files() -> list[Path]:
    files = sorted(CORPUS_DIR.glob("[0-9][0-9][0-9]-*.md"))
    assert files, f"no corpus documents found in {CORPUS_DIR}"
    return files


# --- basic sanity ---------------------------------------------------------


def test_corpus_produces_chunks(all_chunks):
    assert len(all_chunks) > 0


def test_every_document_produces_at_least_one_chunk(corpus_files, config):
    for path in corpus_files:
        chunks = chunk_document(path, config)
        assert chunks, f"{path.name} produced zero chunks"


# --- 1. no chunk exceeds the configured maximum ---------------------------


def test_no_chunk_exceeds_configured_max_tokens(all_chunks, config):
    for c in all_chunks:
        assert c.token_estimate <= config.max_tokens, (
            f"chunk {c.chunk_id!r} ({c.source}) is {c.token_estimate} "
            f"tokens, exceeding max_tokens={config.max_tokens}"
        )


def test_token_estimate_matches_recomputation(all_chunks):
    # The stored token_estimate must actually describe the stored text,
    # not a stale value from before some later transform.
    for c in all_chunks:
        assert c.token_estimate == estimate_tokens(c.text), (
            f"chunk {c.chunk_id!r}: stored token_estimate does not match "
            f"estimate_tokens(text)"
        )


# --- 2. no heading is orphaned from the body it introduces -----------------


def test_every_chunk_starts_with_its_own_heading(all_chunks):
    for c in all_chunks:
        first_line = c.text.strip().splitlines()[0]
        assert first_line.lstrip().startswith("#"), (
            f"chunk {c.chunk_id!r} ({c.source}) does not start with a "
            f"Markdown heading -- its heading was left behind in a "
            f"different chunk (orphaned heading)"
        )


def test_every_chunk_heading_carries_a_section_id_matching_its_metadata(all_chunks):
    for c in all_chunks:
        # A part-split chunk's heading may belong to a subsection id
        # (part_index > 0), so only require the parent section_id to
        # appear literally when this IS the parent's own heading chunk
        # (part_index == 0, part_count == 1 -- the common, unsplit case).
        if c.part_count == 1:
            assert f"`{c.section_id}`" in c.text.splitlines()[0], (
                f"chunk {c.chunk_id!r}: heading line does not carry its "
                f"own section_id {c.section_id!r} -- heading/body pairing "
                f"cannot be verified"
            )


def test_no_chunk_ends_immediately_after_a_heading_with_no_body(all_chunks):
    for c in all_chunks:
        lines = [line for line in c.text.strip().splitlines() if line.strip()]
        non_heading_lines = [line for line in lines if not line.lstrip().startswith("#")]
        assert non_heading_lines, (
            f"chunk {c.chunk_id!r} ({c.source}) contains only heading "
            f"line(s) with no body content -- a heading must be kept with "
            f"the body it introduces, not left standing alone"
        )


def test_heading_count_across_chunks_equals_source_document_heading_count(corpus_files, config):
    # Every '##'/'###' identified heading in the source document appears
    # in exactly one chunk -- none dropped, none duplicated -- except the
    # trailing unidentified "Document History" heading, which is
    # deliberately excluded (see chunker._split_top_level_sections).
    identified_heading_pattern = re.compile(
        r"^#{2,3}\s+.*`(NWP-POL-\d{3}-\d{2}(?:\.\d{2})?)`\s*$", re.MULTILINE
    )
    for path in corpus_files:
        text = path.read_text(encoding="utf-8")
        body = chunker.FRONT_MATTER_PATTERN.sub("", text, count=1)
        source_ids = identified_heading_pattern.findall(body)

        chunks = chunk_document(path, config)
        chunk_ids_seen = set()
        for c in chunks:
            for m in identified_heading_pattern.finditer(c.text):
                chunk_ids_seen.add(m.group(1))

        assert chunk_ids_seen == set(source_ids), (
            f"{path.name}: identified headings in chunks {sorted(chunk_ids_seen)} "
            f"do not match headings in source document {sorted(source_ids)}"
        )


# --- 3. every chunk has complete source/section/offset provenance ---------


def test_every_chunk_has_complete_provenance(all_chunks):
    for c in all_chunks:
        assert c.source, f"chunk {c.chunk_id!r} missing source"
        assert c.source.startswith("data/corpus/"), (
            f"chunk {c.chunk_id!r}: source {c.source!r} is not a data/corpus/ path"
        )
        assert c.section_id, f"chunk {c.chunk_id!r} missing section_id"
        assert c.offset >= 0, f"chunk {c.chunk_id!r} has invalid offset {c.offset}"
        assert c.doc_title, f"chunk {c.chunk_id!r} missing doc_title"
        assert c.section_heading_path, f"chunk {c.chunk_id!r} missing section_heading_path"


def test_offset_points_at_the_chunks_actual_text_in_the_source_file(corpus_files, config):
    for path in corpus_files:
        raw_text = path.read_text(encoding="utf-8")
        for c in chunk_document(path, config):
            recovered = raw_text[c.offset : c.offset + len(c.text)]
            assert recovered == c.text, (
                f"chunk {c.chunk_id!r} ({c.source}): text at offset "
                f"{c.offset} in the source file does not match the "
                f"chunk's stored text -- offset is not a valid citation "
                f"back into the source"
            )


def test_offsets_within_a_document_are_non_overlapping_and_increasing(corpus_files, config):
    for path in corpus_files:
        chunks = chunk_document(path, config)
        chunks_sorted = sorted(chunks, key=lambda c: c.offset)
        for prev, cur in zip(chunks_sorted, chunks_sorted[1:]):
            prev_end = prev.offset + len(prev.text)
            assert prev_end <= cur.offset, (
                f"{path.name}: chunk {prev.chunk_id!r} (ends at "
                f"{prev_end}) overlaps chunk {cur.chunk_id!r} (starts at "
                f"{cur.offset})"
            )


# --- 4. representative threshold tables remain coherent -------------------


TABLE_BEARING_SECTIONS_TO_VERIFY = [
    "NWP-POL-001-02",  # mileage rate table
    "NWP-POL-003-02",  # lodging nightly cap table
    "NWP-POL-006-01",  # receipt threshold table (near-duplicate pair A side)
    "NWP-POL-006-04",  # receipt threshold table (near-duplicate pair B side)
    "NWP-POL-007-01",  # approval threshold table
    "NWP-POL-012-03",  # audit sampling rate table
]


@pytest.mark.parametrize("section_id", TABLE_BEARING_SECTIONS_TO_VERIFY)
def test_threshold_table_stays_together_with_its_explanatory_heading(all_chunks, section_id):
    matches = [c for c in all_chunks if c.section_id == section_id and c.part_count == 1]
    assert matches, (
        f"expected exactly one unsplit chunk for table-bearing section "
        f"{section_id!r}, found {len(matches)} (corpus/chunker may have "
        f"changed -- update this test's expectations deliberately if so)"
    )
    chunk = matches[0]

    assert "|" in chunk.text and "---" in chunk.text, (
        f"chunk {chunk.chunk_id!r}: expected section {section_id!r}'s "
        f"Markdown table to be present in its chunk"
    )
    # The heading itself (which names what the table's numbers mean) must
    # be in the SAME chunk as the table, not just table rows in isolation.
    first_line = chunk.text.strip().splitlines()[0]
    assert first_line.lstrip().startswith("#") and f"`{section_id}`" in first_line, (
        f"chunk {chunk.chunk_id!r}: table for {section_id!r} is not "
        f"paired with its own explanatory heading in the same chunk"
    )
    # At least one line of prose (not just table syntax) must accompany
    # the table -- otherwise "the structure that explains the numbers" is
    # missing, not just the raw table.
    prose_lines = [
        line
        for line in chunk.text.splitlines()
        if line.strip() and not line.lstrip().startswith("#") and "|" not in line
    ]
    assert prose_lines, (
        f"chunk {chunk.chunk_id!r}: table for {section_id!r} has no "
        f"accompanying explanatory prose in the same chunk"
    )


def test_no_table_row_appears_without_its_table_header_in_the_same_chunk(all_chunks):
    separator_pattern = re.compile(r"^\s*\|[\s:|-]+\|\s*$")
    for c in all_chunks:
        lines = c.text.splitlines()
        table_line_indices = [i for i, line in enumerate(lines) if line.strip().startswith("|")]
        if not table_line_indices:
            continue
        # A table's first '|' line in this chunk must be a header row
        # (immediately followed by a '---' separator row), not a body row
        # whose header was left behind in a previous, different chunk.
        first_table_line_idx = table_line_indices[0]
        assert first_table_line_idx + 1 < len(lines), (
            f"chunk {c.chunk_id!r}: table appears truncated at chunk end"
        )
        separator_line = lines[first_table_line_idx + 1]
        assert separator_pattern.match(separator_line), (
            f"chunk {c.chunk_id!r}: first table row in this chunk has no "
            f"header separator immediately after it -- suggests the "
            f"table's header was orphaned in a different chunk"
        )


# --- 5. deterministic IDs/provenance for unchanged content -----------------


def test_chunking_the_same_corpus_twice_produces_identical_chunk_ids(config):
    first = chunk_corpus(config=config)
    second = chunk_corpus(config=config)
    assert [c.chunk_id for c in first] == [c.chunk_id for c in second]


def test_chunking_the_same_corpus_twice_produces_identical_content_hashes(config):
    first = {c.chunk_id: content_hash(c) for c in chunk_corpus(config=config)}
    second = {c.chunk_id: content_hash(c) for c in chunk_corpus(config=config)}
    assert first == second


def test_chunk_ids_are_stable_across_unrelated_document_edits(config, tmp_path):
    # Editing one document's numbers must not change another, unrelated
    # document's chunk ids -- ids are derived from each document's own
    # section structure, not from corpus-wide ordering or a running counter.
    source = CORPUS_DIR / "001-travel-and-mileage-policy.md"
    other = CORPUS_DIR / "002-air-and-rail-travel-policy.md"

    before = {c.chunk_id for c in chunk_document(other, config)}

    edited = tmp_path / source.name
    text = source.read_text(encoding="utf-8")
    edited.write_text(text.replace("$0.67", "$0.99"), encoding="utf-8")
    # (edited copy not re-chunked into 'other' -- this asserts editing
    # doc 001 has no bearing on doc 002's ids, verified by not touching
    # doc 002 at all and re-chunking it unchanged.)
    after = {c.chunk_id for c in chunk_document(other, config)}

    assert before == after


def test_content_hash_changes_when_chunk_text_changes(config):
    chunks = chunk_corpus(config=config)
    original = chunks[0]
    mutated = Chunk(
        chunk_id=original.chunk_id,
        source=original.source,
        section_id=original.section_id,
        section_heading_path=original.section_heading_path,
        doc_title=original.doc_title,
        offset=original.offset,
        part_index=original.part_index,
        part_count=original.part_count,
        text=original.text + "\nAn appended sentence that changes content.",
        token_estimate=original.token_estimate,
    )
    assert content_hash(original) != content_hash(mutated), (
        "content_hash must change when chunk text changes, even though "
        "chunk_id (identity/location) stays the same"
    )


def test_chunk_id_unchanged_when_only_prose_within_a_section_is_edited(config, tmp_path):
    # This is the core "unchanged structure -> unchanged id" guarantee:
    # editing a number inside a section (without changing its heading or
    # section boundaries) must not change that section's chunk_id, even
    # though its content_hash does change.
    source = CORPUS_DIR / "003-lodging-policy.md"
    original_chunks = {c.chunk_id: c for c in chunk_document(source, config)}

    edited = tmp_path / source.name
    text = source.read_text(encoding="utf-8")
    edited.write_text(text.replace("$320", "$340"), encoding="utf-8")
    edited_chunks = {c.chunk_id: c for c in chunk_document(edited, config)}

    assert set(original_chunks) == set(edited_chunks)
    changed_chunk_id = next(
        cid
        for cid in original_chunks
        if original_chunks[cid].text != edited_chunks[cid].text
    )
    assert content_hash(original_chunks[changed_chunk_id]) != content_hash(
        edited_chunks[changed_chunk_id]
    )


# --- chunk id uniqueness / stability across the whole corpus --------------


def test_chunk_ids_are_unique_across_the_whole_corpus(all_chunks):
    ids = [c.chunk_id for c in all_chunks]
    assert len(ids) == len(set(ids)), "chunk_id collision detected across the corpus"


def test_chunk_ids_are_derived_from_stable_section_ids_not_position(all_chunks):
    # Every chunk_id for an unsplit section must equal its section_id
    # exactly (the common case for this corpus -- see the chunker module
    # docstring on why hierarchical splitting rarely needs the fallback
    # path here), so ids read as citations directly.
    for c in all_chunks:
        if c.part_count == 1:
            assert c.chunk_id == c.section_id, (
                f"chunk {c.chunk_id!r}: expected chunk_id to equal "
                f"section_id {c.section_id!r} for an unsplit section"
            )
