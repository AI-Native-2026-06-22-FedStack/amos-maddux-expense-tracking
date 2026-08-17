#!/bin/sh
set -eu

artifact_dir="${ARTIFACT_DIR:-artifacts/security}"
ignore_file="${TRIVY_RELEASE_IGNORE_FILE:-.trivyignore.release}"
adr_file="${TRIVY_RELEASE_ADR:-docs/adr/0025-container-scanning-policy.md}"
issuer="${COSIGN_CERTIFICATE_OIDC_ISSUER:-https://token.actions.githubusercontent.com}"
identity="${COSIGN_CERTIFICATE_IDENTITY:-https://github.com/AI-Native-2026-06-22-FedStack/amos-maddux-expense-tracking/.github/workflows/release.yml@refs/heads/main}"

check_high_exception_policy() {
  if [ ! -f "${ignore_file}" ]; then
    echo "Missing ${ignore_file}; release scans need an explicit exception file, even when empty."
    exit 1
  fi

  cves="$(sed -n 's/^[[:space:]]*\(CVE-[0-9][0-9][0-9][0-9]-[0-9][0-9]*\).*/\1/p' "${ignore_file}" | sort -u)"
  count="$(printf '%s\n' "${cves}" | sed '/^$/d' | wc -l | tr -d ' ')"

  if [ "${count}" -gt 2 ]; then
    echo "ADR-0025 allows at most two justified HIGH release-image CVEs; ${ignore_file} lists ${count}."
    exit 1
  fi

  for cve in ${cves}; do
    if ! grep -Eq "${cve}.*HIGH|HIGH.*${cve}" "${adr_file}"; then
      echo "${cve} is listed in ${ignore_file}, but no ADR-0025 HIGH justification line was found."
      exit 1
    fi
  done
}

if [ "${1:-}" = "--check-policy-only" ]; then
  check_high_exception_policy
  exit 0
fi

if [ "$#" -ne 1 ]; then
  echo "Usage: $0 <image-ref>"
  echo "       $0 --check-policy-only"
  exit 2
fi

image_ref="$1"
image_slug="$(printf '%s' "${image_ref}" | sed 's/.*\///; s/[^A-Za-z0-9_.-]/-/g')"

mkdir -p "${artifact_dir}"
check_high_exception_policy

trivy image \
  --severity CRITICAL,HIGH \
  --exit-code 1 \
  --ignorefile "${ignore_file}" \
  --scanners vuln \
  --format sarif \
  --output "${artifact_dir}/trivy-image-${image_slug}.sarif" \
  "${image_ref}"

syft "${image_ref}" \
  -o "cyclonedx-json=${artifact_dir}/${image_slug}.cdx.json"

if [ "${COSIGN_VERIFY:-0}" = "1" ]; then
  cosign verify \
    --certificate-oidc-issuer "${issuer}" \
    --certificate-identity "${identity}" \
    --output json \
    "${image_ref}" > "${artifact_dir}/cosign-verify-${image_slug}.json"
fi
