# Synthetic Expense-Policy Corpus — Specification

This document is the completed specification for the retrieval deliverable's
evaluation corpus (`data/corpus/*.md`). It is filled in with concrete
decisions before any policy document is generated, per
[AGENTS.md](../../AGENTS.md) and
[docs/data-classification.md](../../docs/data-classification.md): every
document in this corpus is entirely fictional/synthetic and must never be
mistaken for a real company's actual policy.

This corpus exists to give `services/retrieval` (chunker, embedding loader,
retriever, reranker — not yet implemented; see
[prompt-journal/0012-cited-scored-retriever.md](../../prompt-journal/0012-cited-scored-retriever.md))
realistic-but-synthetic material with the retrieval-hard properties real
expense policy corpora have: near-duplicate sections that differ in one
material detail, and superseded/replacement rule pairs. It is not connected
to ExpenseFlow's own `Expense Report` domain model — it is standalone
document content for the retrieval service to index.

## Fictional issuer

**Northwind Prairie Holdings, Inc.** ("Northwind Prairie"), a wholly
fictional company. Every generated document must state, in its own
front matter and in a human-readable disclosure line in the body, that:

- Northwind Prairie Holdings, Inc. is a **fictional company that does not
  exist**, and
- the document is **synthetic/generated training material**, not a real
  corporate policy.

No real company, brand, ticker, address, EIN, phone number, or URL may
appear anywhere in the corpus. Any URL-shaped or contact-shaped strings used
for flavor must be obviously fake (e.g. `intranet.northwindprairie.example`,
using the reserved `.example` TLD per RFC 2606).

## Tenant metadata format

Every document's YAML front matter includes a fixed block identifying it as
synthetic tenant content, consistent with `docs/data-classification.md`'s
rule that tenant data is CUI-sensitive and any tenant identifier used in
prompts/fixtures/docs must be synthetic:

```yaml
---
title: <Document Title>
doc_id: NWP-POL-<NNN>
tenant_id: tenant-synthetic-northwind-prairie
tenant_name: "Northwind Prairie Holdings, Inc. (fictional)"
issuer: "Northwind Prairie Holdings, Inc."
synthetic: true
status: draft-synthetic
effective_date: <YYYY-MM-DD>
version: <n>.<n>
---
```

- `tenant_id` is a single fixed constant across all documents in this
  corpus (one fictional tenant, matching a real retrieval corpus that is
  scoped to one company). It is prefixed `tenant-synthetic-` so it can
  never be confused with a real tenant identifier issued elsewhere in this
  repository (compare ExpenseFlow's own tenant-scoped records, which are
  real per-customer identifiers per `docs/data-classification.md`).
- `synthetic: true` and `status: draft-synthetic` are redundant with the
  body disclosure by design — front matter is often stripped before display,
  so the human-readable disclosure in the body is the backstop.
- `doc_id` uses the same `NWP-POL-NNN` convention described below.

## Section-identifier pattern

Every section and subsection carries a stable, human-and-machine-readable
identifier in the heading itself, using this fixed pattern:

```
NWP-POL-<doc-number>-<section-number>[.<subsection-number>]
```

- `NWP` = Northwind Prairie (clearly synthetic company-scoped prefix, not
  resembling any real standards body or company ticker).
- `POL` = Policy.
- `<doc-number>` = zero-padded 3-digit document number (`001`–`012`),
  fixed per document for its lifetime.
- `<section-number>` = zero-padded 2-digit top-level section number within
  that document (`01`, `02`, ...).
- `.<subsection-number>` = zero-padded 2-digit subsection number, appended
  only for subsections (`NWP-POL-003-02.01`).

Example: `NWP-POL-004-03.02` is document 4, section 3, subsection 2.

Identifiers are rendered as an inline code span immediately after the
heading text, e.g. `### 3.2 Standard Meal Caps \`NWP-POL-004-03.02\``, so
they are trivially extractable by a chunker via regex
(`NWP-POL-\d{3}-\d{2}(\.\d{2})?`) without parsing heading text semantically.

**Uniqueness rule:** because `<doc-number>` is embedded in every section ID,
and each document owns its own document number for its lifetime, no two
sections anywhere in the corpus can collide — uniqueness is structural, not
just a convention to remember. The acceptance checker
(`services/retrieval/tests/test_corpus_acceptance.py`) verifies this by
parsing every document and asserting no ID string repeats corpus-wide.

## Policy areas / documents (10–12 total)

All 12 are generated (the maximum of the requested 10–12 range, to give the
near-duplicate and superseded/replacement requirements room to sit inside
naturally-distinct policy areas rather than being forced into a cramped set).

| doc_id | File | Policy area |
|---|---|---|
| NWP-POL-001 | `001-travel-and-mileage-policy.md` | Ground travel, personal-vehicle mileage reimbursement |
| NWP-POL-002 | `002-air-and-rail-travel-policy.md` | Booked air/rail travel, class of service, advance booking |
| NWP-POL-003 | `003-lodging-policy.md` | Hotel/lodging nightly caps by city tier |
| NWP-POL-004 | `004-meals-and-entertainment-policy.md` | Meal per-diem caps, client entertainment |
| NWP-POL-005 | `005-client-entertainment-policy.md` | Client-facing entertainment/gifts (near-dup partner of 004) |
| NWP-POL-006 | `006-receipt-and-documentation-policy.md` | Receipt thresholds, required documentation |
| NWP-POL-007 | `007-approval-and-authorization-policy.md` | Approval chains, spend-threshold escalation |
| NWP-POL-008 | `008-corporate-card-policy.md` | Corporate card issuance, misuse, reconciliation |
| NWP-POL-009 | `009-remote-work-stipend-policy.md` | Home-office/remote stipends |
| NWP-POL-010 | `010-relocation-policy.md` | Relocation/moving expense reimbursement |
| NWP-POL-011 | `011-international-travel-policy.md` | Foreign per diem, currency, visa/vaccination costs |
| NWP-POL-012 | `012-expense-report-submission-and-audit-policy.md` | Submission deadlines, audit sampling, superseded/replacement home |

Each document has a distinct title, a front-matter block, a numbered
section structure (minimum 3 top-level sections, most with subsections),
and closes with a "Document History" section recording version/effective
date changes — so documents are meaningfully distinct in both topic and
internal structure, not 12 copies of the same template with nouns swapped.

## Table-bearing sections (real numeric thresholds)

At least one section per document carries a Markdown table with concrete
numeric values, consistent with a real expense-policy corpus. Minimum set:

| Section ID | Table contents |
|---|---|
| `NWP-POL-001-02` | Personal-vehicle mileage rate by vehicle class (USD/mile) |
| `NWP-POL-002-02` | Class-of-service thresholds by flight duration/booking lead time |
| `NWP-POL-003-02` | Nightly lodging cap by city tier (Tier 1/2/3 USD/night) |
| `NWP-POL-004-03` | Standard meal caps by meal type (breakfast/lunch/dinner, USD) — **near-dup pair A, original** |
| `NWP-POL-005-02` | Client entertainment per-person caps by event type — **near-dup pair A, counterpart** |
| `NWP-POL-006-01` | Receipt-required threshold by expense category (USD) — **near-dup pair B, original** |
| `NWP-POL-006-04` | Receipt-required threshold, corporate card transactions — **near-dup pair B, counterpart** |
| `NWP-POL-007-01` | Approval-level threshold table by role and dollar amount — **near-dup pair C, original** |
| `NWP-POL-007-03` | Approval-level threshold table, international/relocation spend — **near-dup pair C, counterpart** |
| `NWP-POL-009-02` | Remote-work stipend caps by category (equipment/internet/utilities) |
| `NWP-POL-010-02` | Relocation reimbursement caps by move distance tier |
| `NWP-POL-011-02` | International per-diem by region tier (USD/day) |
| `NWP-POL-012-03` | Audit sampling rate by report-value tier |

## Near-duplicate section pairs (2–3 required; 3 generated)

Each pair is near-identical in structure, phrasing, and table shape, but
differs in **exactly one** materially important detail — the property a
retriever/reranker must be able to distinguish, not just find "a meal cap
section."

1. **Pair A — meal caps vs. client entertainment caps**
   `NWP-POL-004-03` (Standard Meal Caps) vs. `NWP-POL-005-02` (Client
   Entertainment Per-Person Caps).
   Both are USD-per-person dollar-cap tables with nearly identical
   surrounding language ("caps apply per person, per event, inclusive of
   tax and gratuity"). **The one material difference: category** — 004-03
   governs an employee's own meals while traveling solo (no client
   present); 005-02 governs meals/entertainment when a client or
   prospect is present, and carries materially higher per-person caps
   plus a client-name/business-purpose documentation requirement that
   004-03 does not have.

2. **Pair B — receipt threshold, general vs. corporate card**
   `NWP-POL-006-01` (Receipt Required Threshold — General) vs.
   `NWP-POL-006-04` (Receipt Required Threshold — Corporate Card
   Transactions). Both tables list "receipt required above $X per expense
   category" with identical category rows and near-identical prose.
   **The one material difference: the threshold amount itself** — the
   general (out-of-pocket/reimbursement) threshold is lower ($25) than the
   corporate-card threshold ($75), because corporate-card transactions are
   already captured in the statement feed and only need a receipt above a
   higher amount.

3. **Pair C — approval threshold, standard vs. international/relocation**
   `NWP-POL-007-01` (Standard Approval Thresholds) vs. `NWP-POL-007-03`
   (Approval Thresholds — International Travel and Relocation Spend).
   Both are role-vs-dollar-amount escalation tables with the same three
   roles (`Employee`, `Department Manager`, `Finance Admin`) and the same
   table shape. **The one material difference: the approval level
   required at the top tier** — standard spend above $5,000 requires only
   `Finance Admin` sign-off; international/relocation spend above the
   equivalent tier requires both `Department Manager` AND `Finance Admin`
   (dual sign-off), reflecting the higher risk/cost of that category.

## Superseded / replacement rule

- **Superseded rule:** `NWP-POL-012-02` ("Expense Report Submission
  Deadline — Legacy"), effective **2019-01-01**, superseded
  **2024-06-01**. States a 60-day submission deadline from the date of
  expense.
- **Replacement rule:** `NWP-POL-012-02` is retired and replaced by
  `NWP-POL-012-05` ("Expense Report Submission Deadline — Current"),
  effective **2024-06-01**. States a 30-day submission deadline from the
  date of expense, and explicitly states in its own text that it
  supersedes `NWP-POL-012-02` effective 2024-06-01.

Both sections live in the same document (`012`) so a retriever/reranker
must distinguish "current" from "superseded" using in-text effective-date
and status language, not merely document identity. The superseded section
is marked `**Status: SUPERSEDED — see NWP-POL-012-05**` at its top, and the
replacement section states `**Status: CURRENT — replaces NWP-POL-012-02
effective 2024-06-01**`.

## Acceptance checker

`services/retrieval/tests/test_corpus_acceptance.py` (implemented alongside
this spec; the retriever/chunker/embedder/reranker themselves remain
unimplemented) mechanically verifies every requirement above against the
committed files in `data/corpus/`: document count in [10, 12], required
front-matter fields including `synthetic: true`, a synthetic-disclosure
line in the body, section-ID uniqueness and pattern conformance, presence
of the specified table-bearing sections, presence and one-detail-diff
structure of the three near-duplicate pairs, and the superseded/replacement
pair's status markers and effective dates. This checker must not be
weakened to accommodate generated content that fails it — content is fixed
to satisfy the checker, not the reverse.
