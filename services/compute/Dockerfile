# syntax=docker/dockerfile:1.7

FROM python:3.13-slim@sha256:bf503bb2243c5aad0aa951544dd60d165f992646441d35dea90893703fc26251 AS build

WORKDIR /workspace/services/compute
ENV UV_PROJECT_ENVIRONMENT=/opt/venv \
    UV_PYTHON_DOWNLOADS=never \
    UV_LINK_MODE=copy

COPY --from=ghcr.io/astral-sh/uv:0.9.9@sha256:f6e3549ed287fee0ddde2460a2a74a2d74366f84b04aaa34c1f19fec40da8652 /uv /usr/local/bin/uv

COPY services/compute/pyproject.toml services/compute/uv.lock ./

# If a private package index token is needed, BuildKit mounts it only for this
# RUN and it is read into an env var; it is never written to a layer.
# `docker build --secret id=uv_index_token,src=<file>`.
RUN --mount=type=secret,id=uv_index_token,required=false \
    UV_INDEX_PRIVATE_PASSWORD="$(cat /run/secrets/uv_index_token 2>/dev/null || true)" \
    uv sync --locked --no-dev --no-install-project

COPY services/compute/app ./app
COPY config /workspace/config
COPY packages/shared-schemas /workspace/packages/shared-schemas

FROM gcr.io/distroless/python3-debian13@sha256:325c8639176419afb9c3b50b420fbbd65d608f85f1e3f38bc4b8ba80aeac2e8d AS runtime

WORKDIR /app
ENV PATH=/opt/venv/bin:$PATH \
    PYTHONPATH=/opt/venv/lib/python3.13/site-packages

COPY --from=build /opt/venv /opt/venv
COPY --from=build /workspace/services/compute/app ./services/compute/app
COPY --from=build /workspace/config ./config
COPY --from=build /workspace/packages/shared-schemas ./packages/shared-schemas

USER nonroot
EXPOSE 8000
ENTRYPOINT ["/usr/bin/python3.13"]

HEALTHCHECK --start-period=30s --interval=10s --timeout=3s --retries=3 \
  CMD ["/usr/bin/python3.13", "-c", "import urllib.request,sys; sys.exit(0) if urllib.request.urlopen('http://127.0.0.1:8000/health', timeout=2).status == 200 else sys.exit(1)"]

CMD ["-m", "uvicorn", "app.main:app", "--host", "0.0.0.0", "--port", "8000", "--timeout-graceful-shutdown", "9", "--app-dir", "/app/services/compute"]
