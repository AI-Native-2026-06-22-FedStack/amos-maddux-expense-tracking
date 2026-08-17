# ADR-0026: DAST Policy

## Status

Accepted.

## Context

SAST, SCA, IaC scans, container CVE scans, and SBOM generation cannot prove the
runtime HTTP surface is safe. They do not observe whether the deployed app emits
browser-facing security headers, whether the reverse-proxy route reaches the
service, or whether a thrown exception turns into a verbose error page.

ExpenseFlow therefore needs a passive DAST gate against the running app.

## Decision

The release workflow runs OWASP ZAP baseline after deploying the Core Case
Service image to local floci. The scan target is the deployed floci ALB URL:

```text
http://floci/health
```

That URL is resolved from the ZAP container on the `expenseflow-local` Docker
network and reaches the app through the floci ALB listener, not through the
API container's direct host port and not through build-runner `localhost`.

Before ZAP starts, `scripts/run-zap-baseline-floci.sh` curls the exact target
URL and exits non-zero if the route does not answer. This prevents a dead
deployment from producing a misleading zero-alert ZAP report.

The DAST bar is zero Medium-or-above alerts. The baseline is passive, so Medium
findings such as missing Content-Security-Policy, missing anti-clickjacking
headers, or application error disclosure are meaningful release blockers. Lower
findings, such as `X-Content-Type-Options`, are handled as INFO in
`.zap/rules.tsv`, but the app still fixes them where straightforward. A
genuinely informational alert may be marked IGNORE only when the rule line has a
written reason and the JSON report confirms the alert is below Medium risk.

`.zap/rules.tsv` is the only place a ZAP rule disposition is configured:

- `FAIL` for Medium-or-above passive rules that must block the release.
- `INFO` for lower-risk or route-inapplicable findings.
- `IGNORE` only for genuinely informational findings, and only with a written
  reason on the same line. `10049` is currently ignored because ZAP reports it
  as riskcode 0 after ExpenseFlow sets no-store/no-cache headers.

The script also parses `artifacts/security/zap-baseline.json` after the scan and
fails if any alert has `riskcode >= 2`, so a real Medium-or-above alert cannot
be made green by an accidental rule-file downgrade.

ZAP evidence lands in:

```text
artifacts/security/zap-baseline.html
artifacts/security/zap-baseline.json
artifacts/security/zap-target-curl.json
artifacts/security/zap-target-url.txt
```

## Consequences

POSITIVE: A release cannot pass DAST unless the floci ALB route answers before
the scan starts.

POSITIVE: The gate catches runtime-only issues such as missing CSP,
anti-clickjacking headers, content-type sniffing protection, and verbose error
responses.

POSITIVE: Medium-or-above alerts remain blocking even if a rule-file mistake
marks a real finding below FAIL.

NEGATIVE: ZAP runs a Dockerized browser/security toolchain and makes the release
job slower than a static-only pipeline. The extra time is accepted because this
is the first gate that observes the deployed HTTP behavior.
