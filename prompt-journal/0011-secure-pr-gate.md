# 0011 — Secure PR Gate: SAST/SCA/Secret-Scan, OIDC, and Branch Protection

- **_Problem:_** Build a non-bypassable secure-PR gate for the ExpenseFlow
  monorepo: parallel SAST (Semgrep + a custom PII-in-logs rule +
  eslint-plugin-security/no-secrets + Bandit), SCA (OSV-Scanner), and
  full-history secret scanning (Gitleaks), all triaged with SARIF/JSON
  evidence retained under `artifacts/security/`; an OIDC-to-AWS exchange
  with no long-lived keys; and mechanical enforcement via GitHub branch
  protection with the policy recorded in ADR-0024.

- **_Asked:_** Across several turns — author `secure-pr.yml` and prove the
  OIDC exchange; wire SAST/SCA/secrets with a real red-then-green Gitleaks
  regression; make the gate non-bypassable via required checks plus
  ADR-0024; then, separately, verify the whole thing against a grading
  rubric and fix whatever didn't actually hold up.

- **_Produced:_** The workflow files, `.semgrep/no-pii-in-error-logs.yml`
  (custom rule + known-bad/known-good fixture pair), `osv-scanner.toml`,
  `.gitleaksignore`, `docs/security/disposition-log.md` entries,
  `docs/adr/0024-secure-pr-gate-matrix.md`, and
  `scripts/apply-branch-protection.sh`. A commit sequence
  (`36ae649b` → `5d869223` → `3fed608`) planting a hardcoded AWS key in
  `scripts/debug-s3-receipt-upload.mjs`, rotating it, and then fixing a
  second bug the rotation commit itself introduced (see below).

- **_Accepted / Rejected:_**

  ACCEPTED: fixing `iac-scan.yml`'s Trivy severity bug discovered mid-task
  (`limit-severities-for-sarif` was needed for the `severity:
HIGH,CRITICAL` input to actually apply to SARIF output — otherwise it
  was silently ignored and any LOW/MEDIUM finding failed the job). This
  wasn't asked for; it surfaced only because I ran the real workflow
  instead of trusting the YAML looked right, and I proposed fixing it
  rather than leaving a pre-existing bug in place. Verified locally with
  `TRIVY_SEVERITY` set/unset before committing.

  ACCEPTED: dropping the redundant `apps/api`-scoped `npm ci` step from
  three workflow jobs after discovering it silently pruned root-hoisted
  dependencies (verified locally: it deletes `node_modules/vitest` and
  `node_modules/@eslint/js` after a clean root install). This was a
  genuine, previously invisible bug — `Build` had never run in this
  repo's CI history, and `Tests` had failed on every run back to
  `m7d4-implementation`, always at the same `eslint: not found` symptom,
  which meant a second bug (no `uv` setup for the Python cross-service
  test) had never been reached either.

  REJECTED (self-correction): my first attempt at the custom Semgrep rule
  pattern (`logger.error(<... $PARAM ...>)`) passed `semgrep --validate`
  cleanly and I nearly treated that as sufficient proof it worked.
  Actually running it against the known-bad fixture produced zero
  findings — the deep-expression ellipsis syntax doesn't bind a
  single-argument metavariable the way I assumed. I rejected trusting
  `--validate` alone and iterated on the pattern (`..., $PARAM, ...` +
  `metavariable-regex`) until it demonstrably fired exactly once on the
  known-bad line and stayed silent on the known-good one.

  REJECTED (caught in rubric audit): I initially wrote ADR-0024 and the
  PR body claiming required checks "are enforced" by GitHub branch
  protection and that a red check "mechanically cannot be merged." A
  later rubric-driven audit found this was false — `gh api
.../branches/main/protection` returns a live 403 (private repo without
  GitHub Pro/Team), meaning branch protection was never successfully
  applied. I rejected my own earlier overclaim and rewrote every such
  sentence in the ADR and PR body to distinguish "the check itself is
  load-bearing" (verified end to end with the planted-secret regression)
  from "GitHub refuses to merge a red check" (not true yet, documented as
  an open NEGATIVE with the exact blocker).

- **_The rotation commit's own bug:_** `5d869223` (the fix commit) rotated
  the planted AWS key and added its fingerprint to `.gitleaksignore`, but
  explained the finding by quoting the key's literal value in
  `.gitleaksignore`'s own comment and in `docs/security/disposition-log.md`
  prose — which re-triggered the `aws-access-token` rule against that
  commit's own diff. Re-scanning `5d869223` directly (`gitleaks detect
--source . --log-opts="--all"`) still returns exit 1 with 2 findings;
  the repository only reaches a clean scan at the next commit, `3fed608`,
  which rewrote the explanation to describe the value instead of
  repeating it. This was not something I planned going in; it surfaced
  from re-verifying the regression at the exact commit level rather than
  assuming the "fix commit" was automatically the clean end state.

- **_Verification evidence (reproduced locally, not from a GitHub Actions
  run — see Why below):_**

  At `36ae649b` (planted secret): `gitleaks detect --source . --log-opts="--all"`
  → exit 1, 1 finding: `36ae649b38a29bb4946c912cd3d8af835c47947e:scripts/debug-s3-receipt-upload.mjs:aws-access-token:8`.

  At `5d869223` (rotation, before the doc-quoting fix): same command →
  exit 1, 2 findings, both from `5d869223`'s own diff quoting the raw
  value in prose.

  At `3fed608` (doc-quoting fixed): same command → exit 0, "no leaks
  found."

- **_Why (reproduced locally instead of pulled from Actions):_** These
  three commits were made and pushed together in one batch — by the time
  `m8d3-implementation` was first pushed to GitHub, HEAD was already
  several commits past all three, so no GitHub Actions run exists tied to
  any of their exact SHAs individually. Rather than push throwaway
  branches to manufacture Actions runs at those exact commits after the
  fact, I reproduced the same `gitleaks` invocation the `Secret scan` job
  uses (`fetch-depth: 0` equivalent, `--log-opts="--all"`) against real
  git clones checked out at each SHA. The findings, fingerprints, and
  exit codes are genuine and reproducible, not fabricated — but they are
  local reproductions, not screenshots from the Actions tab, and the PR
  description says so explicitly rather than implying otherwise.
