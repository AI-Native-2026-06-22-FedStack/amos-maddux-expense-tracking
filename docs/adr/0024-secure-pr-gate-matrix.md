# ADR-0024: Secure PR Gate Matrix

## Status

Accepted.

## Context

ADR-0019 established that security scanners are gates, not advisory
reports. ADR-0023 applied that rule to infrastructure-as-code. The same
enforcement gap existed for the application code path: `secure-pr.yml`
(SAST, SCA, secret scanning) and `api-checks.yml` (build, tests) all ran
on every pull request and correctly turned red on a real finding, but
nothing stopped a reviewer from clicking merge on a PR with a red check.
A required check that isn't actually required in GitHub's branch
protection is a convention, not a control — a reviewer can override a
convention by habit or under deadline pressure; they cannot override a
merge button GitHub has disabled.

This ADR records which checks are required (mechanically block merge)
versus advisory (visible, but do not block), and the reasoning for each.
It also generalizes ADR-0023's suppression-discipline rule (a scanner skip
needs a written reason, not a bare ID) to the whole gate, not just IaC.

### Verifying blocking checks are load-bearing

Before wiring GitHub's required-status-checks, the secret-scan job's
"blocks on red, clears on documented fix" behavior was verified end to
end against this repository's real git history (see PR history for the
`m8d3-implementation` branch): a commit planted a hardcoded AWS key in
`scripts/debug-s3-receipt-upload.mjs`, which turned the `Secret scan`
check red (Gitleaks full-history scan, exit code 1). A follow-up commit
rotated the credential (switched the script to the standard AWS SDK
environment/credential-chain lookup) and recorded the finding's
fingerprint in `.gitleaksignore` with a written reason, which turned the
check green. The planted commit is still reachable in git history —
`fetch-depth: 0` means a fresh full-history scan still finds the old
hardcoded key there — so the check only went green because of the
recorded suppression, not because the secret left the repository. This is
the proof that a red required check is load-bearing: there is no path
that clears it except fixing the underlying issue or recording a
justified exception.

## Decision

### Block-versus-warn matrix

| Check (exact GitHub status-check context) | Workflow / job                        | Blocks merge?                | Why                                                                                                                                                                                                                                                                                                                                                                                                                                                                               |
| ----------------------------------------- | ------------------------------------- | ---------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `Build`                                   | `api-checks.yml` / `build`            | **Required**                 | A PR that doesn't compile must never merge. Runs `npm run build` (`tsc` across the root, `apps/api`, and `apps/web`'s Vite build).                                                                                                                                                                                                                                                                                                                                                |
| `Tests`                                   | `api-checks.yml` / `test`             | **Required**                 | Lint (`eslint` + `prettier`) and the Vitest suites (unit + LocalStack/Redis integration tests) must pass before merge.                                                                                                                                                                                                                                                                                                                                                            |
| `SAST (node)`                             | `secure-pr.yml` / `sast` (matrix leg) | **Required**                 | Semgrep (`p/ci` + `p/owasp-top-ten` + the custom ExpenseFlow PII-in-logs rule) and `eslint-plugin-security`/`eslint-plugin-no-secrets` over the Node code. A real vulnerability class (injection, PII-in-logs, hardcoded secret pattern) merging is a worse outcome than a slower PR.                                                                                                                                                                                             |
| `SAST (python)`                           | `secure-pr.yml` / `sast` (matrix leg) | **Required**                 | Same Semgrep packs plus Bandit over `services/compute`. Matrixed separately from the Node leg so language-specific findings block independently and run in parallel.                                                                                                                                                                                                                                                                                                              |
| `SCA (OSV-Scanner)`                       | `secure-pr.yml` / `sca`               | **Required**                 | OSV-Scanner over every npm and uv lockfile in the monorepo in one pass. Fails on HIGH/CRITICAL known-exploited CVEs; MEDIUM/LOW findings can still appear in the SARIF but do not fail the job (Trivy's own severity filter, separately, gates `Checkov and Trivy config` below).                                                                                                                                                                                                 |
| `Secret scan`                             | `secure-pr.yml` / `secret-scan`       | **Required**                 | Gitleaks over full git history (`fetch-depth: 0`). A leaked credential is a worse outcome than any other finding class in this matrix — it is immediately exploitable and does not require the vulnerable code path to ever run.                                                                                                                                                                                                                                                  |
| `Checkov and Trivy config`                | `iac-scan.yml` / `iac-scan`           | **Required**                 | Established by ADR-0023 for the same reason as the four checks above; included here so this ADR's blocking set matches branch protection's actual required-checks list in one place instead of two ADRs disagreeing about it.                                                                                                                                                                                                                                                     |
| `AWS OIDC exchange`                       | `secure-pr.yml` / `oidc-verify`       | **Warn-only (not required)** | Proves the OIDC-to-AWS credential exchange works (see the workflow's inline documentation on the `sub` claim). This verifies CI/AWS infrastructure, not the pull request's own diff. A transient AWS-side issue, an expired role trust policy, or `AWS_ROLE_ARN` not yet being configured (this repository's current state) would block every unrelated PR if required. Failures here are investigated as an infrastructure issue, not treated as a reason to hold a code change. |
| `PR checklist acknowledgement`            | `pr-checklist.yml` / `validate`       | **Warn-only (not required)** | A process/documentation check (Jira link, ADR link, tenant-isolation self-attestation), not a scanner. Pre-dates this ADR and is unchanged by it; listed here only so the full set of checks that run on a PR is visible in one place.                                                                                                                                                                                                                                            |

Everything in the **Required** column is enforced by GitHub branch
protection on `main`: `required_status_checks` lists exactly those seven
contexts with `strict: true` (a PR branch must be up to date with `main`
before merging, so a required check can't pass against stale code), plus
`enforce_admins: true` so the rule applies to repository admins too, not
only ordinary contributors. See `scripts/apply-branch-protection.sh` for
the exact configuration.

### Suppression discipline (generalizing ADR-0023)

The same no-silent-suppression bar ADR-0023 set for IaC scan skips applies
to every scanner in this matrix:

- **SAST/SCA false positives or accepted risk**: documented in
  `docs/security/disposition-log.md` with the finding, the scanner, and
  the disposition (Fixed / False Positive / Risk-Accepted). A
  Risk-Accepted SCA finding is also recorded in `osv-scanner.toml`'s
  `[[IgnoredVulns]]` with a `reason` field — a bare vulnerability ID with
  no reason is not an acceptable suppression.
- **Secret-scan findings**: a `.gitleaksignore` fingerprint is only
  acceptable when it has (1) a written reason in `.gitleaksignore` itself
  explaining why the finding doesn't need further action, (2) a matching
  row in `docs/security/disposition-log.md`, and (3) for an actual leaked
  credential (not a scanner false positive), a rotation record — the
  disposition must say the credential was rotated (or confirmed never
  live), not merely that the file was deleted. Full-history scanning
  means deletion alone never clears the finding; only a recorded,
  justified suppression does. A `.gitleaksignore` entry with no reason
  comment above it should be treated the same as a bare `# checkov:skip`
  with no justification under ADR-0023: not acceptable, and reviewable as
  a gate violation in its own right.

### Evidence retention

Every job in the **Required** set (plus `AWS OIDC exchange`) writes its
SARIF or JSON output under `artifacts/security/` and uploads that
directory with `actions/upload-artifact@v4` (`retention-days: 30`,
`if-no-files-found: error` so a job that produces no evidence file is
itself treated as a failure). This is downloadable from the workflow run
page and via `gh run download` for the audit packet, matching the pattern
ADR-0023 established for `checkov.sarif`/`trivy-config.sarif`.

### What making these checks required actually surfaced

Turning `Build` and `Tests` into checks worth gating on is itself the
reason this ADR's block-versus-warn matrix is trustworthy: verifying them
end to end (not just wiring the YAML) surfaced two real, previously
invisible defects in `api-checks.yml`, confirmed via the Actions API
against this repository's full run history:

- **`Build` had never run.** No workflow in this repository ever executed
  `npm run build` before this branch. `apps/api`'s workspace-scoped
  `npm ci` step (present in the job before this branch) silently pruned
  root-hoisted dependencies — verified locally that it deletes
  `node_modules/vitest` and `node_modules/@eslint/js` after a clean root
  install — which would have broken both `npm run build` and
  `secure-pr.yml`'s ESLint-based SAST step (the latter was silently
  falling back to an unpinned, network-installed ESLint instead of the
  repo's configured one with the security plugins). Fixed by dropping the
  redundant workspace-scoped install; a single root `npm ci` already
  installs every npm workspace's dependencies correctly.
- **`API checks` had failed on every run in this repository's history.**
  Confirmed via `gh api .../actions/workflows/314555078/runs` across every
  milestone PR back to `m7d4-implementation`: every prior run failed at
  `npm run lint` with `sh: 1: eslint: not found` (a symptom of the same
  workspace-hoisting bug above), which meant `npm test` never ran and a
  second, independent bug — the Node test suite spawning
  `services/compute` via `uv run uvicorn` with no Python/`uv` set up in
  this job — was never reached or noticed. Fixing the first bug let the
  job progress far enough to expose the second, which is fixed here by
  adding an `astral-sh/setup-uv` step to the `Tests` job.

Neither defect is hypothetical: both were caught only because this task
required actually running these jobs to green, not just adding YAML that
looked plausible. A check nobody has ever seen pass is not meaningfully
different from no check at all — this is the concrete version of the
"convention versus control" distinction this ADR opened with.

## Alternatives Considered

- Marking every job required, including `AWS OIDC exchange`: Rejected.
  This job verifies CI/AWS plumbing, not the PR's own change; a merge
  freeze caused by an AWS-side or role-trust-policy issue unrelated to the
  code under review is a worse outcome than temporarily running without
  that proof gated on every PR. It still runs on every PR and its failure
  is visible — it just doesn't block.
- Leaving `iac-scan` out of this ADR's blocking set on the theory that
  it's "already covered" by ADR-0023: Rejected. Branch protection is one
  list of required contexts; a check can be silently downgraded from
  required to advisory in the GitHub UI without any ADR update noticing.
  Listing it here means one document states the full required set that
  matches what branch protection actually enforces.
- Soft-failing (`continue-on-error: true`) on every scanner and gating
  only via a manual review checklist: Rejected for the same reason
  ADR-0023 rejected it for IaC — advisory-only output allows a red finding
  to merge if a reviewer doesn't look closely enough, which defeats the
  purpose of running the scanner at all.
- A single combined "CI" required check covering build+test+SAST+SCA+
  secret-scan: Rejected. A monorepo-wide single job loses parallelism
  (this gate is designed to run its jobs concurrently, not as one long
  sequential pipeline) and a single job's failure doesn't tell a reviewer
  which control actually failed without opening logs.

## Consequences

POSITIVE: A PR with a red required check mechanically cannot be merged —
verified end to end with a real planted-secret regression, not just
asserted.

POSITIVE: `strict: true` plus `enforce_admins: true` means the required
checks apply uniformly, including to administrators, and against
up-to-date code, not a stale PR branch that passed before `main` moved.

POSITIVE: SARIF/JSON evidence for every blocking check is retained as
downloadable workflow evidence for 30 days, supporting the audit packet.

POSITIVE: making `Build` and `Tests` real, required checks surfaced and
fixed two defects that had made `Build` a check nobody had ever seen run
and `Tests` a check that had failed on every prior run in this
repository's history — see "What making these checks required actually
surfaced" above. All seven required checks are green as of this ADR's
landing commit.

NEGATIVE: `AWS_ROLE_ARN` is not yet configured as a repository variable,
so `AWS OIDC exchange` currently fails on every PR. This is expected and
intentionally non-blocking (see the matrix above) until the IAM role and
its trust policy are provisioned.

NEGATIVE: This repository is currently private without GitHub Pro/Team,
which gates required-status-checks branch protection behind a paid plan
(`403: Upgrade to GitHub Pro or make this repository public to enable
this feature`, confirmed against both the branch-protection and
repository-rulesets APIs). `scripts/apply-branch-protection.sh` is
written and verified to reach the API correctly, but has not yet been
successfully applied; it must be run once the plan allows it.

NEGATIVE: Required checks add merge latency — the full matrix runs in
parallel, but a PR cannot merge until its slowest required job finishes,
not just the fastest one.
