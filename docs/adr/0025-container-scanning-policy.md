# ADR-0025: Container Scanning Policy

## Status

Accepted.

## Context

The M7 image gate needs to prove three release facts for the ExpenseFlow Core
Case Service image:

- the built image has no unaccepted CRITICAL or HIGH vulnerabilities;
- the release carries an exact component-and-version list for the image that
  shipped;
- the signed image digest verifies back to the GitHub Actions release pipeline,
  not to a developer laptop or a stored signing key.

ADR-0019 established hardened Dockerfiles and Trivy image scanning. This ADR
sets the release policy for the image published by
`.github/workflows/release.yml`.

## Decision

The release image reference is:

```text
ghcr.io/ai-native-2026-06-22-fedstack/amos-maddux-expense-tracking/core-case-service:m7-<git-sha>
```

The workflow builds `apps/api/Dockerfile` locally, scans that tag, and pushes
the image only after the Trivy gate passes. The signed and verified subject is
the pushed digest form:

```text
ghcr.io/ai-native-2026-06-22-fedstack/amos-maddux-expense-tracking/core-case-service@sha256:<digest>
```

### Trivy Gate

The release gate runs Trivy over the built image with this severity bar:

```sh
trivy image --severity CRITICAL,HIGH --exit-code 1 --ignorefile .trivyignore.release <image>
```

Policy:

- CRITICAL findings are never accepted. A CRITICAL must be fixed before the
  image can ship.
- HIGH findings must be fixed by bumping to a real advisory-listed fixed
  version whenever one exists.
- At most two HIGH findings may be temporarily accepted at one time, and only
  when the advisory has no fixed version. Each accepted HIGH must have one
  line in this ADR naming the CVE, package, affected version, why the vulnerable
  path is not reachable or why the risk is otherwise bounded, and the recheck
  trigger.
- The release `.trivyignore.release` file exists only to implement those
  written HIGH exceptions. It must not contain CRITICAL CVEs.

Current accepted HIGH exceptions:

- `CVE-2026-14456` is a HIGH finding (package `libssl3t64`, version
  `3.5.6-1~deb13u2`, base image `gcr.io/distroless/nodejs24-debian13`): no
  fixed Debian trixie package exists yet (the pinned digest matches the
  current `:latest` distroless tag, so there is no newer base image to bump
  to either). The flaw is an unbounded memory allocation when OpenSSL acts
  as a QUIC server accepting inbound QUIC Initial packets from unrecognized
  connection IDs. The Core Case Service never runs OpenSSL as a QUIC server:
  it is a plain Express HTTP/1.1 API with no QUIC or HTTP/3 code anywhere in
  `apps/api/src/`, so the vulnerable code path is present in the linked
  library but never exercised. Recheck trigger: drop this exception the next
  time `apps/api/Dockerfile`'s `gcr.io/distroless/nodejs24-debian13` digest
  is bumped and Trivy no longer reports the CVE against the new digest.

The Trivy SARIF report lands in:

```text
artifacts/security/trivy-image-core-case-service.sarif
```

### SBOM

The workflow generates a Syft CycloneDX JSON SBOM from the same built image tag
that passed the Trivy gate:

```sh
syft <image> -o cyclonedx-json=artifacts/security/core-case-service.cdx.json
```

That SBOM is the component-and-version inventory for the release image and is
uploaded from the workflow evidence sink.

### Keyless Signing And Verification

Signing happens only in `.github/workflows/release.yml`. The release job grants:

```yaml
permissions:
  contents: read
  packages: write
  id-token: write
```

`cosign sign` uses GitHub Actions OIDC keyless signing, records the signature
in Rekor, and does not read or write a long-lived signing key. The workflow then
verifies the digest with both certificate values pinned:

```sh
cosign verify \
  --certificate-oidc-issuer https://token.actions.githubusercontent.com \
  --certificate-identity https://github.com/AI-Native-2026-06-22-FedStack/amos-maddux-expense-tracking/.github/workflows/release.yml@refs/heads/main \
  <image-digest>
```

The verification JSON lands in:

```text
artifacts/security/cosign-verify-core-case-service.json
```

No `cosign.key`, `cosign.pub`, `cosign.password`, or similarly named stored
cosign key material is allowed in the repository; the release workflow checks
for those names on every run.

## Consequences

POSITIVE: Trivy uses `--exit-code 1`, so an open CRITICAL or unjustified HIGH
turns the release job red instead of producing a non-blocking report.

POSITIVE: The SBOM, Trivy SARIF, signed image digest, and cosign verification
output all land under `artifacts/security/` and are uploaded as release
evidence.

POSITIVE: The signature verifies only when Rekor has an entry for the digest
from this repository's `release.yml` on `refs/heads/main`.

NEGATIVE: A release image with a justified HIGH still requires discipline:
the ADR line and `.trivyignore.release` entry must stay paired, and the
exception must be revisited when a fixed version appears.
