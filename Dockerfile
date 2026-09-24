FROM node:20-alpine AS frontend-build

WORKDIR /frontend

COPY frontend/package.json frontend/package-lock.json ./
RUN npm ci

COPY frontend/ ./
RUN npm run build

FROM python:3.12-slim AS python-dependencies

COPY --from=ghcr.io/astral-sh/uv:0.12.1 /uv /uvx /bin/

WORKDIR /build
COPY backend/pyproject.toml backend/uv.lock ./backend/

ENV UV_PROJECT_ENVIRONMENT=/opt/venv \
    UV_COMPILE_BYTECODE=1 \
    UV_LINK_MODE=copy

RUN uv sync --project backend --locked --no-dev --no-install-project

FROM python:3.12-slim AS runtime

WORKDIR /app

ENV PATH="/opt/venv/bin:${PATH}" \
    PYTHONDONTWRITEBYTECODE=1 \
    PYTHONUNBUFFERED=1

COPY --from=python-dependencies /opt/venv /opt/venv
COPY --chown=10001:10001 backend/app ./backend/app
COPY --chown=10001:10001 backend/profiles ./backend/profiles
COPY --from=frontend-build --chown=10001:10001 /frontend/dist ./frontend/dist
COPY --chown=10001:10001 reference/tiles_nc.csv ./reference/tiles_nc.csv

USER 10001:10001

EXPOSE 8000

CMD ["uvicorn", "app.main:app", "--app-dir", "backend", "--host", "0.0.0.0", "--port", "8000"]
