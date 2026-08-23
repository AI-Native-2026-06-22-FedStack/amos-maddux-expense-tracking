# 0016 — Named Retrieval Queries + Adversarial Tenant Isolation

- **_Problem:_** Add focused, reproducible tests for the deliverable's two
  named retrieval queries (one exact section identifier, one colloquial
  paraphrase using none of the policy's own wording) with a defined
  answer chunk chosen in advance, top-5-with-full-provenance recorded for
  both, plus an automated tenant-isolation regression where tenant B has
  content that would genuinely rank highly if isolation broke -- not
  reranking-assisted, must prove hybrid retrieval itself.

- **_Chosen queries:_** Exact identifier: `NWP-POL-003-02` (Nightly
  Lodging Caps by City Tier). Colloquial paraphrase: "how much am I
  allowed to spend on a hotel room each night when I'm traveling for
  work" (avoids "nightly cap"/"city tier"/"lodging" -- verified by a test
  that asserts those phrases exist in the source doc but not in the
  query). Both defined in advance to answer `NWP-POL-003-02`.

- **_Produced:_** `data/corpus-tenant-b/001-lodging-policy.md` (a second
  fictional company, "Rival Corp Holdings, Inc.",
  `tenant-synthetic-rival-corp`, real content loaded via `embed.py` --
  not mocked), `data/corpus-tenant-b/README.md`,
  `services/retrieval/tests/test_retrieve_named_queries.py` (9 tests: 2
  exact-id, 3 colloquial, 4 tenant-isolation -- including one that proves
  the adversarial fixture is genuinely adversarial by showing it DOES
  rank first when queried under its own tenant).

- **_Chose the "real second corpus document" design_** (user's explicit
  choice via AskUserQuestion) over inserting a fake row directly in the
  test: more realistic end-to-end proof, but required three follow-on
  decisions, each also confirmed with the user before implementing:

  1. Where does tenant B's document live? `data/corpus/`'s spec and
     acceptance checker (`corpus_check.py`) assert exactly ONE fixed
     tenant_id -- weakening that checker to accommodate new content was
     explicitly against its own stated rule. Chose a new sibling
     directory, `data/corpus-tenant-b/`, kept entirely outside the
     Deliverable 1/2 corpus and its checker.

  2. **Real bug found:** `chunker.py`'s `SECTION_HEADING_PATTERN` and its
     oversized-section subsection pattern were both hardcoded to the
     literal `NWP-POL-` prefix -- tenant B's correctly-distinct `RVL-POL-`
     prefix (a different fictional company should not borrow Northwind
     Prairie's own ID namespace) produced zero recognized chunks.
     Generalized both patterns to `[A-Z]+-POL-\d{3}-\d{2}(\.\d{2})?`,
     keeping the `-POL-` + numeric shape as the real structural
     invariant. Verified the existing 73-test suite was unaffected before
     and after (same pass count, real corpus's `NWP-POL-*` chunk_ids
     unchanged) -- this is a chunker generalization, not a behavior
     change for existing content.

  3. **Second real bug found:** `chunk_document()`'s `source` field was
     hardcoded to `f"data/corpus/{path.name}"` regardless of which
     directory the file actually came from -- would have silently
     mislabeled every tenant-B chunk's provenance as living in
     `data/corpus/` when it actually lives in `data/corpus-tenant-b/`.
     Fixed with `_source_path()`, deriving the repo-relative path from
     the file's real location. Verified the real corpus's `source` values
     are unchanged (all 73 pre-existing tests still pass) and tenant-B's
     chunks now correctly report `data/corpus-tenant-b/001-lodging-policy.md`.

  Also added `embed.load_corpus()`'s missing `corpus_dir` parameter (it
  only accepted `tenant_id`, with no way to point at a non-default
  directory) -- needed to actually load tenant B without duplicating
  `load_corpus()`'s logic in a one-off script.

- **_Verification beyond the automated tests:_** ran `retrieve.py`'s CLI
  directly for all three scenarios before writing the automated
  versions, to confirm real behavior first: exact-id query against tenant
  A (rank 1, `dense_rank=None` since the literal-id short-circuit alone
  carried it), colloquial query against tenant A (rank 1 via genuine
  keyword+dense fusion, no literal id present), the SAME exact-id query
  against tenant B directly (confirmed `RVL-POL-001-02` ranks highly --
  proving the adversarial fixture is real, not toothless), and the
  colloquial query against tenant A with tenant B's content loaded
  (confirmed zero rival chunks leaked).
