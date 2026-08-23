"""pytest-integrated form of services/retrieval/corpus_check.py's checks
against the synthetic expense-policy corpus in data/corpus/. See that
module for the actual check implementations and the specification in
data/corpus/CORPUS-SPEC.md for the requirements being enforced.

This module intentionally contains no duplicated check logic -- each test
here calls the corresponding check_*() function in corpus_check.py so the
standalone script (`python corpus_check.py`) and pytest suite can never
drift apart.
"""

from __future__ import annotations

import sys
from pathlib import Path

import pytest

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

import corpus_check  # noqa: E402


@pytest.fixture(scope="module")
def corpus_docs() -> dict[str, str]:
    return corpus_check._load_corpus_docs()


def test_spec_exists_and_is_completed():
    corpus_check.check_spec_exists_and_is_completed()


def test_document_count_in_range(corpus_docs):
    corpus_check.check_document_count(corpus_docs)


def test_tenant_metadata_present(corpus_docs):
    corpus_check.check_tenant_metadata_present(corpus_docs)


def test_every_document_labelled_synthetic(corpus_docs):
    corpus_check.check_every_document_labelled_synthetic(corpus_docs)


def test_every_document_identifies_fictional_issuer(corpus_docs):
    corpus_check.check_every_document_identifies_fictional_issuer(corpus_docs)


def test_every_section_has_stable_identifier(corpus_docs):
    corpus_check.check_every_section_has_stable_identifier(corpus_docs)


def test_section_identifiers_unique_corpus_wide(corpus_docs):
    corpus_check.check_section_identifiers_unique_corpus_wide(corpus_docs)


def test_threshold_table_sections_exist(corpus_docs):
    corpus_check.check_threshold_table_sections_exist(corpus_docs)


def test_near_duplicate_pairs_exist(corpus_docs):
    corpus_check.check_near_duplicate_pairs_exist(corpus_docs)


def test_near_duplicate_pairs_have_one_material_difference(corpus_docs):
    corpus_check.check_near_duplicate_pairs_have_one_material_difference(corpus_docs)


def test_superseded_and_replacement_rules_exist(corpus_docs):
    corpus_check.check_superseded_and_replacement_rules_exist(corpus_docs)


def test_effective_dates_present(corpus_docs):
    corpus_check.check_effective_dates_present(corpus_docs)


def test_documents_meaningfully_distinct(corpus_docs):
    corpus_check.check_documents_meaningfully_distinct(corpus_docs)
