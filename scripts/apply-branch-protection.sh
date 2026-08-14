#!/usr/bin/env sh
# Applies the required-status-checks branch protection ADR-0024 documents for
# `main`. Requires `gh` authenticated with a token that has `repo` scope and
# admin rights on the repository.
#
# GitHub gates required-status-checks branch protection (and rulesets) on
# private repositories behind GitHub Pro/Team. Run this once the repository
# is public or the org/repo has that plan; until then it fails with:
#   "Upgrade to GitHub Pro or make this repository public to enable this feature."
set -eu

REPO="${REPO:-AI-Native-2026-06-22-FedStack/amos-maddux-expense-tracking}"
BRANCH="${BRANCH:-main}"

# Exact GitHub status-check context names. Matrix jobs report one context per
# leg (e.g. "SAST (node)", not "SAST"). Verify these against a real PR's
# `gh pr checks <number>` output before changing this list — a mismatched
# name silently never becomes required (GitHub does not warn on typos here).
REQUIRED_CONTEXTS='[
  "Build",
  "Tests",
  "SAST (node)",
  "SAST (python)",
  "SCA (OSV-Scanner)",
  "Secret scan",
  "Checkov and Trivy config"
]'

gh api \
  --method PUT \
  -H "Accept: application/vnd.github+json" \
  "repos/${REPO}/branches/${BRANCH}/protection" \
  --input - <<EOF
{
  "required_status_checks": {
    "strict": true,
    "contexts": [],
    "checks": $(echo "$REQUIRED_CONTEXTS" | python3 -c "import json,sys; print(json.dumps([{'context': c} for c in json.load(sys.stdin)]))")
  },
  "enforce_admins": true,
  "required_pull_request_reviews": {
    "required_approving_review_count": 1,
    "dismiss_stale_reviews": true
  },
  "restrictions": null,
  "required_linear_history": false,
  "allow_force_pushes": false,
  "allow_deletions": false
}
EOF

echo "Applied. Verify with:"
echo "  gh api repos/${REPO}/branches/${BRANCH}/protection | python3 -m json.tool"
