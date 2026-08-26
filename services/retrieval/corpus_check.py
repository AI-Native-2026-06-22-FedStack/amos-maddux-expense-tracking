"""Acceptance checker for the synthetic expense-policy corpus in
data/corpus/, against the completed specification in
data/corpus/CORPUS-SPEC.md.

Runnable standalone (`python corpus_check.py` / `uv run python
corpus_check.py`) or imported by services/retrieval/tests/test_corpus_acceptance.py
for the pytest-integrated form of the same checks. Deliberately independent
of the (not yet implemented) chunker/embedder/retriever/reranker: it parses
the committed Markdown files directly so it can run before any of that code
exists.

This checker must not be relaxed to accommodate corpus content that fails
it -- corpus content is fixed to satisfy these checks, not the reverse. If
a check and the corpus disagree, either the corpus has a real defect (fix
the Markdown) or CORPUS-SPEC.md's decision changed (update the spec, this
module's constants, and the corpus together, deliberately).
"""

from __future__ import annotations

import re
import sys
from dataclasses import dataclass, field
from pathlib import Path

import yaml

RETRIEVAL_DIR = Path(__file__).resolve().parent
CORPUS_DIR = RETRIEVAL_DIR.parent.parent / "data" / "corpus"
SPEC_PATH = CORPUS_DIR / "CORPUS-SPEC.md"

SECTION_ID_PATTERN = re.compile(r"NWP-POL-(\d{3})-(\d{2})(?:\.(\d{2}))?")
HEADING_ID_PATTERN = re.compile(
    r"^#{2,4}\s+.*`(NWP-POL-\d{3}-\d{2}(?:\.\d{2})?)`\s*$", re.MULTILINE
)
FRONT_MATTER_PATTERN = re.compile(r"\A---\n(.*?)\n---\n", re.DOTALL)

MIN_DOCUMENT_COUNT = 10
MAX_DOCUMENT_COUNT = 12

REQUIRED_FRONT_MATTER_FIELDS = {
    "title",
    "doc_id",
    "tenant_id",
    "tenant_name",
    "issuer",
    "synthetic",
    "status",
    "effective_date",
    "version",
}

EXPECTED_TENANT_ID = "tenant-synthetic-northwind-prairie"
EXPECTED_ISSUER = "Northwind Prairie Holdings, Inc."

# (section_a, section_b, [required single material-difference detail, for
# a human reading a failure message -- not machine-checked beyond the
# marker-line presence check below).
NEAR_DUPLICATE_PAIRS = [
    ("NWP-POL-004-03", "NWP-POL-005-02", "category: solo employee meal vs. client entertainment"),
    (
        "NWP-POL-006-01",
        "NWP-POL-006-04",
        "threshold amount: general vs. corporate-card receipt threshold",
    ),
    ("NWP-POL-007-01", "NWP-POL-007-03", "approval level: single vs. dual sign-off at top tier"),
]

TABLE_BEARING_SECTIONS = [
    "NWP-POL-001-02",
    "NWP-POL-002-02",
    "NWP-POL-003-02",
    "NWP-POL-004-03",
    "NWP-POL-005-02",
    "NWP-POL-006-01",
    "NWP-POL-006-04",
    "NWP-POL-007-01",
    "NWP-POL-007-03",
    "NWP-POL-009-02",
    "NWP-POL-010-02",
    "NWP-POL-011-02",
    "NWP-POL-012-03",
]

SUPERSEDED_SECTION_ID = "NWP-POL-012-02"
REPLACEMENT_SECTION_ID = "NWP-POL-012-05"
SUPERSEDED_EFFECTIVE_DATE = "2019-01-01"
REPLACEMENT_EFFECTIVE_DATE = "2024-06-01"


class CorpusCheckError(AssertionError):
    """Raised for one failed corpus acceptance check. Always carries an
    actionable message: which document (or section pair), which property,
    and what was expected vs. found."""


@dataclass
class CheckResult:
    name: str
    passed: bool
    message: str = ""


@dataclass
class CorpusCheckReport:
    results: list[CheckResult] = field(default_factory=list)

    @property
    def ok(self) -> bool:
        return all(r.passed for r in self.results)

    def add(self, name: str, fn) -> None:
        try:
            fn()
        except CorpusCheckError as exc:
            self.results.append(CheckResult(name, False, str(exc)))
        except Exception as exc:  # noqa: BLE001 - surface any parse error as a failed check
            self.results.append(CheckResult(name, False, f"unexpected error: {exc}"))
        else:
            self.results.append(CheckResult(name, True))


def _fail(message: str) -> None:
    raise CorpusCheckError(message)


def _corpus_files() -> list[Path]:
    return sorted(CORPUS_DIR.glob("[0-9][0-9][0-9]-*.md"))


def _load_corpus_docs() -> dict[str, str]:
    files = _corpus_files()
    if not files:
        _fail(
            f"no corpus documents found in {CORPUS_DIR} "
            f"(expected files matching NNN-*.md)"
        )
    return {f.name: f.read_text(encoding="utf-8") for f in files}


def _parse_front_matter(name: str, text: str) -> dict:
    match = FRONT_MATTER_PATTERN.match(text)
    if not match:
        _fail(f"{name}: missing a leading '---' YAML front-matter block")
    try:
        data = yaml.safe_load(match.group(1))
    except yaml.YAMLError as exc:
        _fail(f"{name}: front matter is not valid YAML: {exc}")
    if not isinstance(data, dict):
        _fail(f"{name}: front matter did not parse to a mapping")
    return data


def _body_without_front_matter(text: str) -> str:
    return FRONT_MATTER_PATTERN.sub("", text, count=1)


def _section_ids_in(text: str) -> list[str]:
    return HEADING_ID_PATTERN.findall(text)


def _defines_section(text: str, section_id: str) -> bool:
    """True only if this document's own heading defines section_id (as
    opposed to merely mentioning/cross-referencing it in prose)."""
    return (
        re.search(rf"^#{{2,4}}\s+.*`{re.escape(section_id)}`\s*$", text, re.MULTILINE)
        is not None
    )


def _document_defining(corpus_docs: dict[str, str], section_id: str) -> tuple[str, str] | None:
    for name, text in corpus_docs.items():
        if _defines_section(text, section_id):
            return name, text
    return None


def _extract_section(name: str, text: str, section_id: str) -> str:
    """Return the body text of one section, from its heading up to (but
    excluding) the next heading of equal-or-shallower depth."""
    heading_match = re.search(
        rf"^(#{{2,4}})\s+.*`{re.escape(section_id)}`\s*$", text, re.MULTILINE
    )
    if not heading_match:
        _fail(f"{name}: section {section_id!r} heading not found")
    depth = len(heading_match.group(1))
    start = heading_match.end()
    next_heading = re.search(rf"^#{{2,{depth}}}\s+", text[start:], re.MULTILINE)
    end = start + next_heading.start() if next_heading else len(text)
    return text[start:end]


# --- individual checks -------------------------------------------------


def check_spec_exists_and_is_completed() -> None:
    if not SPEC_PATH.exists():
        _fail(f"missing specification file: {SPEC_PATH}")
    text = SPEC_PATH.read_text(encoding="utf-8")
    for placeholder in ("TBD", "TODO", "<fill", "FIXME"):
        if placeholder.lower() in text.lower():
            _fail(
                f"{SPEC_PATH.name}: contains an unresolved placeholder "
                f"({placeholder!r}) -- the specification must record concrete "
                f"decisions before the corpus is checked against it"
            )


def check_document_count(corpus_docs: dict[str, str]) -> None:
    count = len(corpus_docs)
    if not (MIN_DOCUMENT_COUNT <= count <= MAX_DOCUMENT_COUNT):
        _fail(
            f"data/corpus/: expected {MIN_DOCUMENT_COUNT}-{MAX_DOCUMENT_COUNT} "
            f"committed policy documents, found {count}"
        )


def check_tenant_metadata_present(corpus_docs: dict[str, str]) -> None:
    for name, text in corpus_docs.items():
        front_matter = _parse_front_matter(name, text)
        for field_name in ("tenant_id", "tenant_name"):
            if not front_matter.get(field_name):
                _fail(f"{name}: front matter is missing required tenant field {field_name!r}")
        if front_matter["tenant_id"] != EXPECTED_TENANT_ID:
            _fail(
                f"{name}: tenant_id is {front_matter['tenant_id']!r}, "
                f"expected the fixed synthetic constant {EXPECTED_TENANT_ID!r}"
            )


def check_every_document_labelled_synthetic(corpus_docs: dict[str, str]) -> None:
    for name, text in corpus_docs.items():
        front_matter = _parse_front_matter(name, text)
        if "synthetic" not in front_matter:
            _fail(f"{name}: front matter is missing the 'synthetic' field")
        if front_matter["synthetic"] is not True:
            _fail(
                f"{name}: front matter 'synthetic' must be boolean true, "
                f"found {front_matter['synthetic']!r}"
            )
        body = _body_without_front_matter(text)
        if "synthetic" not in body.lower():
            _fail(f"{name}: document body does not disclose synthetic/generated status")


def check_every_document_identifies_fictional_issuer(corpus_docs: dict[str, str]) -> None:
    for name, text in corpus_docs.items():
        front_matter = _parse_front_matter(name, text)
        if front_matter.get("issuer") != EXPECTED_ISSUER:
            _fail(
                f"{name}: front matter issuer is {front_matter.get('issuer')!r}, "
                f"expected {EXPECTED_ISSUER!r}"
            )
        body = _body_without_front_matter(text)
        if EXPECTED_ISSUER not in body:
            _fail(f"{name}: document body does not name the fictional issuer {EXPECTED_ISSUER!r}")
        if "fictional" not in body.lower():
            _fail(f"{name}: document body does not disclose that the issuer is fictional")


def check_every_section_has_stable_identifier(corpus_docs: dict[str, str]) -> None:
    for name, text in corpus_docs.items():
        body = _body_without_front_matter(text)
        section_ids = _section_ids_in(body)
        if len(section_ids) < 3:
            _fail(
                f"{name}: expected at least 3 section identifiers "
                f"(pattern NWP-POL-<doc>-<section>), found {len(section_ids)}"
            )
        for section_id in section_ids:
            if not SECTION_ID_PATTERN.fullmatch(section_id):
                _fail(
                    f"{name}: section id {section_id!r} does not match the "
                    f"NWP-POL-<doc>-<section>[.<subsection>] convention"
                )


def check_section_identifiers_unique_corpus_wide(corpus_docs: dict[str, str]) -> None:
    seen: dict[str, str] = {}
    for name, text in corpus_docs.items():
        body = _body_without_front_matter(text)
        for section_id in _section_ids_in(body):
            if section_id in seen:
                _fail(
                    f"duplicate section id {section_id!r}: defined in both "
                    f"{seen[section_id]!r} and {name!r} -- section identifiers "
                    f"must be unique corpus-wide"
                )
            seen[section_id] = name


def check_threshold_table_sections_exist(corpus_docs: dict[str, str]) -> None:
    for section_id in TABLE_BEARING_SECTIONS:
        found = _document_defining(corpus_docs, section_id)
        if found is None:
            _fail(
                f"required table-bearing section {section_id!r} was not found "
                f"defined (as a heading) in any corpus document"
            )
        name, text = found
        section_text = _extract_section(name, text, section_id)
        has_table = "|" in section_text and re.search(r"\|\s*-{2,}\s*\|", section_text)
        if not has_table:
            _fail(f"{name}: section {section_id!r} must contain a Markdown table")
        if not re.search(r"\$?\d+(\.\d+)?", section_text):
            _fail(f"{name}: section {section_id!r} must contain real numeric threshold values")


def check_near_duplicate_pairs_exist(corpus_docs: dict[str, str]) -> None:
    for section_a, section_b, _detail in NEAR_DUPLICATE_PAIRS:
        for section_id in (section_a, section_b):
            if _document_defining(corpus_docs, section_id) is None:
                _fail(
                    f"near-duplicate pair ({section_a}, {section_b}): "
                    f"section {section_id!r} was not found defined in any document"
                )


def check_near_duplicate_pairs_have_one_material_difference(
    corpus_docs: dict[str, str],
) -> None:
    marker = "**Material difference from"
    for section_a, section_b, detail in NEAR_DUPLICATE_PAIRS:
        found_a = _document_defining(corpus_docs, section_a)
        found_b = _document_defining(corpus_docs, section_b)
        if found_a is None or found_b is None:
            missing = section_a if found_a is None else section_b
            _fail(
                f"near-duplicate pair ({section_a}, {section_b}): cannot check "
                f"the material difference because {missing!r} is not defined in "
                f"any document -- see the 'near_duplicate_pairs_exist' check"
            )
        name_a, text_a = found_a
        name_b, text_b = found_b
        body_a = _extract_section(name_a, text_a, section_a)
        body_b = _extract_section(name_b, text_b, section_b)

        if not ("|" in body_a and "|" in body_b):
            _fail(
                f"near-duplicate pair ({section_a} in {name_a}, {section_b} in "
                f"{name_b}): both sides must contain a table to be a genuine "
                f"near-duplicate pair, not just a topical cross-reference"
            )
        if body_a.strip() == body_b.strip():
            _fail(
                f"near-duplicate pair ({section_a} in {name_a}, {section_b} in "
                f"{name_b}): sections are byte-identical -- they must differ in "
                f"exactly one material detail ({detail}), not be a literal copy"
            )
        if marker not in body_a and marker not in body_b:
            _fail(
                f"near-duplicate pair ({section_a} in {name_a}, {section_b} in "
                f"{name_b}): neither section states its material difference "
                f"explicitly (expected a {marker!r} line documenting: {detail})"
            )


def check_superseded_and_replacement_rules_exist(corpus_docs: dict[str, str]) -> None:
    for section_id, role in (
        (SUPERSEDED_SECTION_ID, "superseded"),
        (REPLACEMENT_SECTION_ID, "replacement"),
    ):
        if _document_defining(corpus_docs, section_id) is None:
            _fail(f"required {role} section {section_id!r} was not found defined in any document")


def check_effective_dates_present(corpus_docs: dict[str, str]) -> None:
    superseded_name, superseded_text = _document_defining(corpus_docs, SUPERSEDED_SECTION_ID)
    replacement_name, replacement_text = _document_defining(corpus_docs, REPLACEMENT_SECTION_ID)

    superseded_body = _extract_section(superseded_name, superseded_text, SUPERSEDED_SECTION_ID)
    replacement_body = _extract_section(
        replacement_name, replacement_text, REPLACEMENT_SECTION_ID
    )

    if "SUPERSEDED" not in superseded_body:
        _fail(f"{superseded_name}: section {SUPERSEDED_SECTION_ID!r} must be marked SUPERSEDED")
    if SUPERSEDED_EFFECTIVE_DATE not in superseded_body:
        _fail(
            f"{superseded_name}: section {SUPERSEDED_SECTION_ID!r} must state its "
            f"effective date {SUPERSEDED_EFFECTIVE_DATE}"
        )
    if REPLACEMENT_SECTION_ID not in superseded_body:
        _fail(
            f"{superseded_name}: section {SUPERSEDED_SECTION_ID!r} must reference "
            f"its replacement {REPLACEMENT_SECTION_ID!r}"
        )

    if "CURRENT" not in replacement_body:
        _fail(f"{replacement_name}: section {REPLACEMENT_SECTION_ID!r} must be marked CURRENT")
    if REPLACEMENT_EFFECTIVE_DATE not in replacement_body:
        _fail(
            f"{replacement_name}: section {REPLACEMENT_SECTION_ID!r} must state its "
            f"effective date {REPLACEMENT_EFFECTIVE_DATE}"
        )
    if SUPERSEDED_SECTION_ID not in replacement_body:
        _fail(
            f"{replacement_name}: section {REPLACEMENT_SECTION_ID!r} must reference "
            f"the rule it supersedes ({SUPERSEDED_SECTION_ID!r})"
        )

    for name, text in corpus_docs.items():
        front_matter = _parse_front_matter(name, text)
        if not front_matter.get("effective_date"):
            _fail(f"{name}: front matter is missing a required 'effective_date'")


def check_documents_meaningfully_distinct(corpus_docs: dict[str, str]) -> None:
    titles = set()
    for name, text in corpus_docs.items():
        front_matter = _parse_front_matter(name, text)
        title = front_matter.get("title")
        if title in titles:
            _fail(f"{name}: title {title!r} duplicates another document's title")
        titles.add(title)

    bodies = {name: _body_without_front_matter(text) for name, text in corpus_docs.items()}
    for name, body in bodies.items():
        if len(body) <= 800:
            _fail(
                f"{name}: document body is only {len(body)} characters -- "
                f"too short to be real policy content, not a stub"
            )


# --- runner --------------------------------------------------------------


def run_all_checks() -> CorpusCheckReport:
    report = CorpusCheckReport()
    report.add("spec_exists_and_is_completed", check_spec_exists_and_is_completed)

    try:
        corpus_docs = _load_corpus_docs()
    except CorpusCheckError as exc:
        report.results.append(CheckResult("corpus_loadable", False, str(exc)))
        return report
    report.results.append(CheckResult("corpus_loadable", True))

    checks = [
        ("document_count_in_range", lambda: check_document_count(corpus_docs)),
        ("tenant_metadata_present", lambda: check_tenant_metadata_present(corpus_docs)),
        (
            "every_document_labelled_synthetic",
            lambda: check_every_document_labelled_synthetic(corpus_docs),
        ),
        (
            "every_document_identifies_fictional_issuer",
            lambda: check_every_document_identifies_fictional_issuer(corpus_docs),
        ),
        (
            "every_section_has_stable_identifier",
            lambda: check_every_section_has_stable_identifier(corpus_docs),
        ),
        (
            "section_identifiers_unique_corpus_wide",
            lambda: check_section_identifiers_unique_corpus_wide(corpus_docs),
        ),
        (
            "threshold_table_sections_exist",
            lambda: check_threshold_table_sections_exist(corpus_docs),
        ),
        ("near_duplicate_pairs_exist", lambda: check_near_duplicate_pairs_exist(corpus_docs)),
        (
            "near_duplicate_pairs_have_one_material_difference",
            lambda: check_near_duplicate_pairs_have_one_material_difference(corpus_docs),
        ),
        (
            "superseded_and_replacement_rules_exist",
            lambda: check_superseded_and_replacement_rules_exist(corpus_docs),
        ),
        ("effective_dates_present", lambda: check_effective_dates_present(corpus_docs)),
        (
            "documents_meaningfully_distinct",
            lambda: check_documents_meaningfully_distinct(corpus_docs),
        ),
    ]
    for name, fn in checks:
        report.add(name, fn)
    return report


def main() -> int:
    report = run_all_checks()
    for result in report.results:
        status = "PASS" if result.passed else "FAIL"
        line = f"[{status}] {result.name}"
        if not result.passed:
            line += f"\n        {result.message}"
        print(line)

    passed = sum(1 for r in report.results if r.passed)
    total = len(report.results)
    print(f"\n{passed}/{total} checks passed")

    return 0 if report.ok else 1


if __name__ == "__main__":
    sys.exit(main())
