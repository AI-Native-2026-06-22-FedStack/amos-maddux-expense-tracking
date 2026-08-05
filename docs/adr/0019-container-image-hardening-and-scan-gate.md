# ADR-0019: Container Image Hardening and Scan Gate

## Status

Accepted.

## Context

ExpenseFlow ships two runtime images: the TypeScript/Express Core Case
Service (`apps/api`) and the Python/FastAPI GL-coding engine
(`services/compute`). Both need to pass a federal image gate before they can
be deployed:

- Every base image and dependency must be pinned to an exact, reproducible
  version. A floating tag (`node:24-trixie-slim`) or an unversioned package
  install (`apt-get install -y curl`) can resolve to a different artifact on
  every rebuild, which is non-reproducible and fails the gate outright.
- No build secret may land in an image layer. If a build step ever needs
  registry credentials, the credential has to be usable for exactly that one
  `RUN` and absent from the final filesystem, including intermediate layers
  that `docker history`/`docker save` can still expose even if a later step
  deletes the file.
- Both images must scan clean of HIGH/CRITICAL vulnerabilities with
  `trivy image --severity HIGH,CRITICAL --exit-code 1`, or every unfixed
  finding must be a recorded, justified exception rather than a silently
  ignored one.

[ADR-0002](0002-sprint-2-polyglot-service-split.md) established the
TypeScript/Express and Python/FastAPI service split this ADR builds images
for.

## Decision

### Multi-stage build, distroless runtime, non-root

Both Dockerfiles ([apps/api/Dockerfile](../../apps/api/Dockerfile),
[services/compute/Dockerfile](../../services/compute/Dockerfile)) use a
build stage on a full glibc/Debian base to install dependencies and compile
the app, then copy only the production artifact into a `gcr.io/distroless`
runtime stage running as the image's built-in `nonroot` user. The build
toolchain (npm/pip/uv, compilers, dev dependencies, source `.ts`/test files)
never crosses into the runtime stage — there is no shell, package manager,
or interpreter beyond what the distroless base ships, so even a container
compromise has nothing to `apt-get install` with.

**Why standard-slim for build, distroless for runtime, not slim end-to-end:**
`node:24-trixie-slim` and `python:3.13-slim` still carry a shell and package
manager, which the build stage needs (`npm ci`, `uv sync`, `tsc`). Shipping
that same base to production would mean shipping the shell, npm/pip, and
whatever residual build tooling that comes with it — a materially larger
attack surface and a materially larger image for zero runtime benefit.
`gcr.io/distroless/nodejs24-debian13` and
`gcr.io/distroless/python3-debian13` are built by the same Bazel pipeline as
Debian trixie, so their glibc, `libc`, and other shared libraries are ABI-
compatible with binaries compiled in the `*-trixie-slim`/`*-slim` build
stage — a native module (e.g. `argon2-cffi-bindings`, `psycopg[binary]`)
built or resolved against glibc in the build stage loads correctly against
the runtime's glibc. An Alpine (musl) runtime was ruled out for exactly this
reason: it would require every native dependency to be musl-compatible or
rebuilt from source, and a mismatch fails at import/require time, not at
build time.

### Pinning

Every `FROM` in both Dockerfiles is pinned by digest, not just tag:

```
node:24-trixie-slim@sha256:0711b541c1c33a8a530ac4f0d391baa9a15b3d804695b1b24a47daa5fb60e74d
gcr.io/distroless/nodejs24-debian13@sha256:2e3b3a96d1d7286c3e4727f9c84b4dc32b6b33e7d7d4425c5a5c8186ad85fa93
python:3.13-slim@sha256:bf503bb2243c5aad0aa951544dd60d165f992646441d35dea90893703fc26251
gcr.io/distroless/python3-debian13@sha256:325c8639176419afb9c3b50b420fbbd65d608f85f1e3f38bc4b8ba80aeac2e8d
ghcr.io/astral-sh/uv:0.9.9@sha256:f6e3549ed287fee0ddde2460a2a74a2d74366f84b04aaa34c1f19fec40da8652
```

A tag can be repointed at a different digest at any time (the `latest`
alias moves by definition, and even a specific tag like `3.13-slim` gets
repushed on top of itself for patch updates); pinning by digest makes the
base image byte-for-byte reproducible across every build, in CI and
locally, until the pin is deliberately bumped.

Neither Dockerfile runs `apt-get`/`apk` — no OS package is installed in
either stage beyond what the base images already ship — so there is no
unversioned package install to pin. Everything else is pinned through the
existing lockfiles: `npm ci` installs exactly what `package-lock.json`
resolves, and `uv sync --locked` refuses to install anything that doesn't
match `uv.lock` bit-for-bit (`--locked` fails the build instead of silently
re-resolving if the lockfile and manifest disagree).

### Secrets never touch a layer

Neither build currently needs a credential — both `npm ci` and `uv sync`
pull from public registries. But the gate requires the *mechanism* to exist
correctly for the day a private registry token is needed, so both
Dockerfiles wire an optional BuildKit secret mount on every install step:

```dockerfile
# syntax=docker/dockerfile:1.7
...
RUN --mount=type=secret,id=npm_token,required=false \
    NPM_TOKEN="$(cat /run/secrets/npm_token 2>/dev/null || true)" \
    npm ci --workspace @expenseflow/api --include-workspace-root
```

```dockerfile
RUN --mount=type=secret,id=uv_index_token,required=false \
    UV_INDEX_PRIVATE_PASSWORD="$(cat /run/secrets/uv_index_token 2>/dev/null || true)" \
    uv sync --locked --no-dev --no-install-project
```

`--mount=type=secret` tmpfs-mounts the file at `/run/secrets/<id>` only for
the duration of that one `RUN` instruction; it is never `COPY`'d, never
written into the image's writable layer, and is gone before the layer is
committed. `required=false` lets the same Dockerfile build with zero
credentials configured (the common case today) or with a real token passed
via `docker build --secret id=npm_token,src=<file>` (the day a private
registry is added), without a code change either way. The `# syntax=`
directive at the top of both files is what makes `--mount=type=secret`
available in the first place — omitting it silently downgrades the parser
and the mount flag is rejected.

This was verified directly, not just read: a build was run with
`--secret id=npm_token,src=<synthetic-token-file>`, and the resulting
image was `docker export`'d and `docker save`'d (which captures every
layer, not just the final filesystem) and grepped for the token value —
absent from both. `docker history --no-trunc` was also checked and shows
no secret material in any `RUN` command string.

No `.env` file is copied into either image at any stage; both Dockerfiles
only `COPY` explicit, named files and directories.

### Trivy as a hard gate

Both images are scanned with:

```sh
trivy image --severity HIGH,CRITICAL --exit-code 1 <image>
```

`--exit-code 1` is what makes this a gate rather than a report: without it,
trivy prints CRITICAL findings and still exits 0, so a CI step that only
checks the exit code would pass regardless of what was found. The compute
service also carries a per-directory `.trivyignore` exception file (below);
the API image needs none.

The exception file is named exactly `.trivyignore` (not `.trivyignore.yaml`)
because that is the only filename `trivy image` auto-discovers — its
`--ignorefile` flag defaults to the literal string `.trivyignore`, and a
`.trivyignore.yaml` sitting in the same directory is silently not read
unless `--ignorefile` is passed explicitly. This was caught by re-running
the gate command exactly as specified
(`trivy image --severity HIGH,CRITICAL --exit-code 1 <image>`, no extra
flags) from `services/compute/`: an earlier `.trivyignore.yaml` draft
looked like it passed because it had only been tested with `--ignorefile`
passed explicitly, and re-verifying with the bare command showed it still
exiting 1. Trivy's structured YAML exception format additionally requires
the `.yaml` extension to be parsed as YAML at all — a `.trivyignore` file
with YAML content inside is read as the plain per-line format and matches
nothing — so the exception file uses the plain `.trivyignore` format
(one CVE ID per line, `#` comments) instead, with the full CVE-by-CVE
justification kept here in the ADR rather than inline in the ignore file.

**Fixable findings were fixed, not excepted.** The first scan of the API
image surfaced `CVE-2026-16221`/`CVE-2026-18446` (HIGH) in `fast-uri@3.1.3`,
pulled in transitively via `ajv` (an `eslint`-adjacent `devOptional`
dependency that npm workspace hoisting still resolves into the production
`node_modules` tree). Both CVEs are fixed in `fast-uri@3.1.5`, which
satisfies `ajv@8.20.0`'s existing `^3.0.1` requirement, so `npm update
fast-uri` bumped the lockfile with no dependency-tree or code change. The
first scan of the compute image surfaced `CVE-2026-69247` (HIGH) in
`cryptography==49.0.0`, pulled in transitively via `pyjwt[crypto]`. It is
fixed in `50.0.0`; rather than adding `cryptography` as a fake direct
dependency, `[tool.uv].override-dependencies = ["cryptography>=50.0.0"]`
was added to `services/compute/pyproject.toml` to force the transitive
resolution, and `uv lock` picked up the fix. Both images rescan clean of
those findings.

**Documented exception — compute image, unfixed OS packages.** After the
fixable findings above were resolved, the compute image still carries 15
HIGH findings entirely inside `gcr.io/distroless/python3-debian13`'s OS
packages (`libncursesw6`, `libtinfo6`, `libpython3.13-minimal`,
`libpython3.13-stdlib`, `python3.13-minimal`, `python3.13-venv`,
`libuuid1`), none of which have a published fix yet
(`trivy`'s `Fixed Version` column is empty for all 15 — confirmed, not
assumed). These cannot be patched by the app team: distroless has no shell
or package manager to `apt-get upgrade` against, and there is no newer
`gcr.io/distroless/python3-debian13` digest yet that carries the fix. Each
was checked against what `services/compute/app` actually imports and does
at runtime (grepped for `tarfile`, `xml`, `html.parser`, `curses`, `uuid`)
and none of the vulnerable code paths are reachable:

| CVE | Package | Why it does not apply |
| --- | --- | --- |
| CVE-2025-69720 | libncursesw6, libtinfo6 | ncurses terminal-UI buffer overflow; the service is a headless uvicorn process, no curses import anywhere in `app/` |
| CVE-2026-11940 | libpython3.13-\* | `tarfile.extractall()` filter bypass; `app/` never imports `tarfile` |
| CVE-2026-15308 | libpython3.13-\* | stdlib `html.parser` CPU DoS; `app/` never imports `html.parser`, serves JSON only |
| CVE-2026-7210 | libpython3.13-\* | expat XML parser DoS; `app/` never imports `xml`/expat, accepts no XML input |
| CVE-2026-53615 | libuuid1 | integer overflow in libblkid's partition-table parser; `app/` only uses Python's pure-Python `uuid.UUID()` string parsing, which does not call into libblkid |

Each CVE is recorded by ID in
[services/compute/.trivyignore](../../services/compute/.trivyignore), with
the full applicability reasoning and accepter kept in the table above and
this ADR (the plain-text ignore-file format has no field for either). This
was demonstrated as an actual gate, not asserted: with `.trivyignore`
temporarily moved out of the directory, `trivy image --severity
HIGH,CRITICAL --exit-code 1 expenseflow-compute:verify` — the exact command
from the gate spec, no extra flags — exits **1** (the 15 findings fail the
build); with the file restored, the identical command exits **0**, because
trivy auto-discovers `.trivyignore` in the scan working directory without
needing `--ignorefile` passed. Silently downgrading severity, deleting the
scanner step, or shipping the findings unrecorded were all rejected as
options — the gate has to fail loudly until someone signs off on record,
not disappear quietly.

### Layer-by-layer justification

**`apps/api` final image — 306MB, `gcr.io/distroless/nodejs24-debian13`:**

| Layer | Size | Why it belongs in production |
| --- | --- | --- |
| distroless base (glibc, Node 24 runtime, CA certs, `/etc/passwd` with `nonroot`, tzdata) | ~155MB | The minimum needed to execute compiled JavaScript as a non-root OS user with working TLS trust; no shell, package manager, or extra OS tooling |
| `WORKDIR /app` | 8.19kB | Metadata only |
| `ENV NODE_ENV=production` | 0B | Metadata only; enables framework production code paths (Express, etc.) |
| `COPY node_modules` (production-deps stage) | 83.4MB | Runtime dependencies resolved by `npm ci --omit=dev` from the locked manifest — no dev dependencies, no npm cache |
| `COPY dist/apps/api/src` (build stage) | 397kB | The compiled JS the service actually runs; no `.ts` source, no test files |
| `COPY apps/api/package.json` | 12.3kB | Read by Node's ESM loader for `"type": "module"` resolution; not the workspace root manifest |
| `COPY apps/api/healthcheck.js` | 12.3kB | The `HEALTHCHECK` probe script, invoked in exec form by the Node interpreter |
| `COPY packages/shared-schemas` | 53.2kB | The GL-coding contract schema the API validates against at runtime |
| `COPY config` → `dist/config` | 20.5kB | `sensitive-log-fields.json`, read by the compiled log-redaction module at the exact relative path `tsc`'s output layout expects |
| `USER nonroot` | 0B | Drops root; the process cannot write outside its own working directory or bind privileged ports |
| `EXPOSE 3000` | 0B | Documentation of the listening port |
| `HEALTHCHECK` | 0B | Exec-form readiness probe with a 30s start-period |
| `CMD ["dist/apps/api/src/server.js"]` | 0B | Exec form; the compiled entrypoint is PID 1 and receives `SIGTERM` directly |

Nothing from the `build` stage's `npm ci` (full, with dev dependencies),
`tsc` compiler, or workspace source tree for `apps/web`/`services/tivs-acl`
is present — only the four explicit `COPY --from=build`/`COPY
--from=production-deps` lines above cross the stage boundary.

**`services/compute` final image — 157MB, `gcr.io/distroless/python3-debian13`:**

| Layer | Size | Why it belongs in production |
| --- | --- | --- |
| distroless base (glibc, Python 3.13 interpreter, CA certs, `/etc/passwd` with `nonroot`, tzdata) | ~57MB | The minimum needed to execute Python 3.13 bytecode as a non-root OS user; no shell, no pip |
| `WORKDIR /app` | 8.19kB | Metadata only |
| `ENV PATH=/opt/venv/bin:...` `PYTHONPATH=/opt/venv/lib/python3.13/site-packages` | 0B | Points the runtime's own interpreter at the copied virtual environment's installed packages |
| `COPY /opt/venv` | 52.2MB | The venv `uv sync --locked --no-dev --no-install-project` produced — FastAPI, uvicorn, pyjwt, pwdlib, httpx, jsonschema, psycopg-binary, structlog, and their resolved dependencies; no `uv`, no pip cache, no dev-group packages (mypy, pytest, ruff, pact-python) |
| `COPY services/compute/app` | 131kB | The application code that is actually imported and run |
| `COPY config` | 16.4kB | `sensitive-log-fields.json`, read by `app/log_redaction.py` |
| `COPY packages/shared-schemas` | 53.2kB | The GL-coding contract schema `app/shared_schema.py` validates against |
| `USER nonroot` | 0B | Drops root |
| `EXPOSE 8000` | 0B | Documentation of the listening port |
| `ENTRYPOINT ["/usr/bin/python3.13"]` | 0B | The runtime image's own interpreter — deliberately not the build stage's venv-relative `python3` symlink, which points at a path (`/usr/local/bin/python3`) that does not exist in the distroless filesystem |
| `HEALTHCHECK` | 0B | Exec-form readiness probe with a 30s start-period |
| `CMD ["-m", "uvicorn", ...]` | 0B | Exec form; `python3.13 -m uvicorn` is PID 1, so uvicorn's own `SIGTERM` handling runs in that process directly, no wrapper shell |

Nothing from the build stage's `uv` binary, `uv` build cache, or dev
dependency group is present — only the three explicit `COPY --from=build`
lines above cross the stage boundary.

## Alternatives Considered

- **Alpine/musl runtime base for smaller images:** Rejected. `argon2-cffi-
  bindings`, `cryptography`, `psycopg[binary]`, and `pydantic-core` all ship
  manylinux (glibc) wheels; loading them against a musl libc either fails
  outright or requires rebuilding from source with a full musl toolchain in
  the final image, which reintroduces the compiler surface the multi-stage
  split exists to remove.
- **Tag pinning only (`node:24-trixie-slim`, no digest):** Rejected. A tag
  can move to a different image at any time; only a digest guarantees the
  exact same bytes build today and a year from now.
- **`.env` copied into the build context and deleted in a later `RUN`:**
  Rejected. Each `RUN`/`COPY` commits a new layer; deleting a file in a
  later layer does not remove it from the layers underneath, which
  `docker history`/`docker save`/`docker export` can still read.
- **Silencing or downgrading the 15 unfixed distroless OS-package
  findings:** Rejected in favor of a per-finding documented exception.
  Suppressing the scanner or lowering `--severity` would also hide any
  *future* HIGH/CRITICAL finding in the same package, not just today's
  unreachable ones.
- **Adding `cryptography` as a direct dependency to force a version bump:**
  Rejected in favor of `[tool.uv].override-dependencies`. `cryptography` is
  only needed because `pyjwt[crypto]` pulls it in; pinning it as a direct
  dependency would misrepresent the actual dependency graph and require
  remembering to remove it if `pyjwt` ever drops the transitive need.

## Consequences

POSITIVE: Both images are reproducible byte-for-byte from the same
Dockerfile and lockfiles — no floating tag can silently change what ships.

POSITIVE: A credential-requiring registry can be adopted for either build
without a Dockerfile rewrite; the secret-mount plumbing already exists and
was verified to leave no trace in any layer.

POSITIVE: `trivy image --severity HIGH,CRITICAL --exit-code 1` exits 0 on
both images today, with every currently-known unfixed finding traceable to
a specific CVE, an explicit "why it does not apply" statement, and a named
accepter — not a blanket suppression.

POSITIVE: The runtime stages carry no compiler, package manager, or shell;
`docker history` on both final images shows only base-image layers plus the
explicit `COPY` lines listed above.

NEGATIVE: Digest pins go stale — a base image security patch will not be
picked up until someone deliberately re-pulls and re-pins the digest. This
trades automatic patching for reproducibility and needs a recurring "rebump
the pins" habit, not a one-time fix.

NEGATIVE: The five accepted CVEs in the compute image's distroless base
need to be revisited whenever the base image is rebumped — a future
`gcr.io/distroless/python3-debian13` digest may fix them (removing the
exception) or introduce new ones (requiring a new one), so `.trivyignore`
is not "set and forget."

NEGATIVE: `override-dependencies` in `services/compute/pyproject.toml`
pins `cryptography` above what `pyjwt[crypto]` itself requires; if `pyjwt`
later bumps its own floor past `50.0.0`, the override becomes redundant and
should be removed rather than left as dead configuration.
