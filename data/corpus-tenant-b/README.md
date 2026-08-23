# Tenant-B Adversarial Fixture

This directory is **not** part of the Deliverable 1/2 evaluation corpus
documented in [`../corpus/CORPUS-SPEC.md`](../corpus/CORPUS-SPEC.md).
That spec and its acceptance checker
(`services/retrieval/corpus_check.py`) are built around exactly one
fictional tenant (Northwind Prairie Holdings, Inc.,
`tenant-synthetic-northwind-prairie`) and are not weakened here to
accommodate a second one.

`001-lodging-policy.md` is a second fictional company's ("Rival Corp
Holdings, Inc.", `tenant-synthetic-rival-corp`) lodging policy, created
solely to give `services/retrieval`'s automated tenant-isolation
regression test
(`services/retrieval/tests/test_retrieve_named_queries.py`) a genuinely
adversarial second-tenant chunk: it deliberately overlaps in vocabulary,
structure, and dollar amounts with
`../corpus/003-lodging-policy.md`'s `NWP-POL-003-02` section, so that if
tenant scoping in `retrieve.py`'s keyword or dense leg ever broke, this
content would have every reason to rank highly for the same queries used
against the real corpus -- rather than being a trivially-dissimilar
document that would never surface regardless of whether isolation
actually works.

To (re)load this content into `retrieval.corpus_chunk`:

```bash
cd services/retrieval
uv run python3 -c "
from pathlib import Path
from embed import load_corpus

load_corpus(
    tenant_id='tenant-synthetic-rival-corp',
    corpus_dir=Path('../../data/corpus-tenant-b'),
)
"
```

Same synthetic-data rules apply as the main corpus (see
[AGENTS.md](../../AGENTS.md) and
[docs/data-classification.md](../../docs/data-classification.md)): this
is fictional, clearly-disclosed content, never real company data.
