# ECR floci registry verification

Date: 2026-08-07

All AWS CLI calls targeted local floci only:

```sh
AWS_ENDPOINT_URL=http://localhost:4566
AWS_REGION=us-east-1
AWS_ACCESS_KEY_ID=test
AWS_SECRET_ACCESS_KEY=test
```

## Repository setup

Created two ECR repositories in floci:

- `expenseflow/core-case-service`
- `expenseflow/gl-coding-engine`

Both repositories read back with `imageTagMutability` set to `IMMUTABLE`.

## Lifecycle policy

Applied `ecr/lifecycle-policy.json` to both repositories.

Rule 1 expires untagged images beyond the newest 2. It keeps the two newest
untagged images and does not touch tagged images.

Rule 2 expires tagged images with the `m7d3-` prefix beyond the newest 10. It
keeps the ten newest `m7d3-` fixed-version tags and does not touch other tag
families.

## Image pushes

Pushed the existing m7d1 Compose images under fixed tag `m7d3-20260807`:

- `expenseflow-core-case:smoke`
- `expenseflow-gl-coding:smoke`

floci returned path-style repository URIs with port `5000`, but the backing
registry sidecar was published on host port `5100`. Docker pushes succeeded
through `localhost:5100`:

```text
localhost:5100/000000000000/us-east-1/expenseflow/core-case-service:m7d3-20260807
digest: sha256:75184d5d8ec7165c2789458e81c95985e12907391a56625799b1a86483cf437f

localhost:5100/000000000000/us-east-1/expenseflow/gl-coding-engine:m7d3-20260807
digest: sha256:08c580c47b1af2ba9ec93459bc10c303723e51791ef1d7193bef457ebfa56a99
```

The local registry catalog shows both pushed tags:

```text
000000000000/us-east-1/expenseflow/core-case-service:m7d3-20260807
000000000000/us-east-1/expenseflow/gl-coding-engine:m7d3-20260807
```

## Duplicate push result

Duplicate pushes were not rejected by floci 1.5.11, even with repository
immutability set to `IMMUTABLE`:

```text
core duplicate exit=0
compute duplicate exit=0
```

This means the local floci registry stored the fixed tags, but the duplicate
push rejection guarantee was not enforced by this emulator run. The current
floci ECR documentation describes tag mutability and lifecycle policy as
round-trip metadata in the emulator rather than push-time/lifecycle enforcement.
