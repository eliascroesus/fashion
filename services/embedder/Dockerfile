# Build from services/embedder: `docker build services/embedder`, or `fly deploy` (see fly.toml).
# The model is baked in, so a waking machine never downloads anything.
FROM python:3.12-slim AS base
ENV PYTHONDONTWRITEBYTECODE=1 PYTHONUNBUFFERED=1

# Libraries only (CPU-only torch on Linux, see pyproject.toml).
FROM base AS deps
COPY --from=ghcr.io/astral-sh/uv:0.13.1 /uv /usr/local/bin/uv
ENV UV_COMPILE_BYTECODE=1 UV_LINK_MODE=copy UV_PYTHON_DOWNLOADS=never
WORKDIR /app
COPY pyproject.toml uv.lock .python-version ./
RUN uv sync --frozen --no-dev --no-install-project

# The pinned model files: their own layer, rebuilt only when the pin changes.
FROM deps AS model
COPY src/embedder/__init__.py src/embedder/settings.py src/embedder/download_model.py src/embedder/
RUN PYTHONPATH=src MODEL_DIR=/models .venv/bin/python -m embedder.download_model \
    && rm -rf /models/.cache

FROM deps AS app
COPY src ./src
RUN uv sync --frozen --no-dev --no-editable

FROM base
RUN useradd --create-home --uid 10001 embedder
# The model first: it changes least, so a code change doesn't re-send its 813 MB layer.
COPY --from=model /models /models
COPY --from=app /app/.venv /app/.venv
ENV PATH=/app/.venv/bin:$PATH MODEL_DIR=/models HF_HUB_OFFLINE=1 TRANSFORMERS_OFFLINE=1
USER embedder
EXPOSE 8080
CMD ["uvicorn", "embedder.app:build", "--factory", "--host", "0.0.0.0", "--port", "8080", "--no-server-header"]
