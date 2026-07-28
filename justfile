set shell := ["bash", "-euo", "pipefail", "-c"]

gen:
    bun run gen

format:
    bun run format

format-check:
    bun run format:check

lint:
    bun run lint
    buf lint
    bun run architecture
    bun run typecheck
    bun run deploy:check

check-generated:
    bun run gen
    git diff --exit-code -- packages/proto

test:
    bun run test:ts
    bun run test:workers

check: format-check lint check-generated test
