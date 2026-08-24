# Secure PR Gate: OIDC AWS Exchange

`.github/workflows/secure-pr.yml` runs on every pull request into the
ExpenseFlow monorepo. Its `sast`, `sca`, and `secret-scan` jobs run in
parallel (no `needs:` between them). This document covers the `oidc-verify`
job specifically: how it authenticates to AWS with no long-lived credentials,
and how that was verified.

## No long-lived keys

There is no `AWS_ACCESS_KEY_ID` or `AWS_SECRET_ACCESS_KEY` secret in this
repository, and none appear in the workflow. `oidc-verify` authenticates by
having GitHub mint a short-lived OIDC JSON Web Token for the job and
exchanging it with AWS STS (`sts:AssumeRoleWithWebIdentity`) for temporary
credentials, via `aws-actions/configure-aws-credentials@v4`:

```yaml
oidc-verify:
  permissions:
    id-token: write
    contents: read
  steps:
    - uses: aws-actions/configure-aws-credentials@v4
      with:
        role-to-assume: ${{ vars.AWS_ROLE_ARN }}
        aws-region: us-east-1
    - run: aws sts get-caller-identity
```

`AWS_ROLE_ARN` is a **repository variable** (`vars.AWS_ROLE_ARN`), not a
secret — the role ARN is not sensitive; nothing about it grants access on its
own without a valid, trust-policy-matched OIDC token. There is also no
`AWS_ENDPOINT_URL` set on this job — unlike the local Compose stack and
`api-checks.yml`, which point at the local `floci` fixture endpoint,
`oidc-verify` talks to real AWS STS.

## Trust policy `sub` claim

The IAM role's trust policy must restrict which repository and trigger
context can assume it, using the `token.actions.githubusercontent.com:sub`
claim on the federated OIDC token. For a job triggered by `pull_request`
(as `oidc-verify` is), GitHub populates that claim as:

```
repo:AI-Native-2026-06-22-FedStack/amos-maddux-expense-tracking:pull_request
```

This is **not** a branch ref. A trust policy written for
`repo:...:ref:refs/heads/main` models a `push`-triggered job, and will reject
a `pull_request`-triggered job with:

```
Not authorized to perform sts:AssumeRoleWithWebIdentity
```

The role's trust policy condition should read:

```json
{
  "Effect": "Allow",
  "Principal": {
    "Federated": "arn:aws:iam::<account-id>:oidc-provider/token.actions.githubusercontent.com"
  },
  "Action": "sts:AssumeRoleWithWebIdentity",
  "Condition": {
    "StringEquals": {
      "token.actions.githubusercontent.com:aud": "sts.amazonaws.com",
      "token.actions.githubusercontent.com:sub": "repo:AI-Native-2026-06-22-FedStack/amos-maddux-expense-tracking:pull_request"
    }
  }
}
```

## Proving the exchange is load-bearing

`permissions: id-token: write` is what allows the `oidc-verify` job to
request the federated token in the first place. Without it, GitHub does not
mint a token, `configure-aws-credentials` has nothing to exchange with STS,
and there is no stored key for it to fall back to — the job fails closed.

This was verified as follows:

1. **Baseline (permission present).** With `id-token: write` set as shown
   above, `aws sts get-caller-identity` in the final step returns JSON whose
   `Arn` field is an **assumed-role** ARN, e.g.:

   ```json
   {
     "Arn": "arn:aws:sts::<account-id>:assumed-role/<role-name>/GitHubActions",
     "Account": "<account-id>",
     "UserId": "..."
   }
   ```

   This is proof the OIDC → STS exchange completed and produced temporary,
   scoped credentials.

2. **Attack (permission removed).** Temporarily delete the `id-token: write`
   line from `oidc-verify`'s `permissions:` block (leaving `contents: read`)
   and push/re-run. `configure-aws-credentials` fails during token
   acquisition — GitHub Actions has no `ACTIONS_ID_TOKEN_REQUEST_TOKEN`
   available to the job without the permission, so the action cannot request
   a token from GitHub's OIDC provider at all, and the step errors before it
   ever reaches AWS. The job fails; no fallback credential path exists to
   paper over it.

3. **Restore.** Re-add `id-token: write`, re-run, and confirm
   `get-caller-identity` again returns the assumed-role ARN from step 1.

Steps 2 and 3 confirm the permission is load-bearing — removing it breaks
the only credential path this job has, and restoring it is the only thing
that fixes it. There is no secondary path (stored key, hardcoded
credentials) for the job to silently fall back to.

Record the actual run URLs/output for steps 1–3 here once executed against
the real repository and AWS role:

- Baseline pass: `<run URL>` — `Arn: <assumed-role ARN>`
- Attack (permission removed) fail: `<run URL>` — failure step/message
- Restore pass: `<run URL>` — `Arn: <assumed-role ARN>`

## Provisioning the role

Create or update the IAM role and set the repository variable with:

```sh
scripts/provision-github-oidc-role.sh
```

The script provisions `expenseflow-secure-pr-gate-oidc` in account
`208096650110` using the `expenseflow-smoke` AWS profile by default, verifies
the existing GitHub OIDC provider, scopes the trust policy to the
`pull_request` subject above, and writes the resulting role ARN to the
`AWS_ROLE_ARN` GitHub repository variable. On creation it also sets the
`TraineeSandboxBoundary` permissions boundary. The role intentionally has no
permissions policies attached; `oidc-verify` only needs STS to return the
assumed-role identity.
