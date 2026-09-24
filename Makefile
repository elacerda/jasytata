.PHONY: setup dev preview test lint typecheck build check clean

setup:
	cd frontend && npm ci

dev:
	cd frontend && npm run dev

preview: build
	cd frontend && npm run preview

test:
	cd frontend && npm test

lint:
	cd frontend && npm run lint

typecheck:
	cd frontend && npm run typecheck

build:
	cd frontend && npm run build

check: test lint typecheck build

clean:
	rm -rf frontend/node_modules frontend/dist frontend/*.tsbuildinfo
