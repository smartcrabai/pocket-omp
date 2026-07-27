set shell := ["bash", "-euo", "pipefail", "-c"]

gen:
    bun run gen

format:
    cargo fmt --all
    bun run format

format-check:
    cargo fmt --all -- --check
    bun run format:check

lint:
    cargo clippy --workspace --all-targets --all-features -- -D warnings
    bun run lint
    buf lint
    bun run architecture
    bun run typecheck

check-generated:
    bun run gen
    git diff --exit-code -- packages/proto

test:
    cargo test --workspace
    bun run test:ts

check: format-check lint check-generated test
