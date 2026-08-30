.PHONY: dev build test lint db-migrate db-seed docker-up docker-down clean

dev:
	pnpm run dev

build:
	pnpm run build

test:
	pnpm run test

lint:
	pnpm run lint
	pnpm run typecheck

db-migrate:
	pnpm --filter database run migrate

db-seed:
	pnpm --filter database run seed

docker-up:
	docker-compose up -d postgres redis minio temporal

docker-down:
	docker-compose down

clean:
	rm -rf node_modules
	rm -rf apps/*/node_modules
	rm -rf packages/*/node_modules
	rm -rf apps/*/dist
	rm -rf packages/*/dist
