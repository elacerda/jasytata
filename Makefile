.PHONY: setup dev backend frontend test test-backend test-frontend lint typecheck build run clean

UV_CACHE_DIR ?= $(CURDIR)/.uv-cache
export UV_CACHE_DIR

setup:
	uv sync --project backend --all-groups
	cd frontend && npm install

dev:
	cd frontend && npm run dev

backend:
	uv run --project backend uvicorn app.main:app --app-dir backend --reload --port 8000

frontend:
	cd frontend && npm run dev

test: test-backend test-frontend

test-backend:
	uv run --project backend pytest

test-frontend:
	cd frontend && npm test

lint:
	uv run --project backend ruff check backend/app backend/tests
	cd frontend && npm run lint

typecheck:
	cd frontend && npm run typecheck

build:
	cd frontend && npm run build

run: build
	cd frontend && npm run preview

clean:
	rm -rf backend/.venv backend/.pytest_cache frontend/node_modules frontend/dist
