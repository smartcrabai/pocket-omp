# syntax=docker/dockerfile:1.7
FROM rust:1.97.1-alpine3.23 AS builder
RUN apk add --no-cache musl-dev perl make
WORKDIR /workspace
COPY Cargo.toml Cargo.lock rust-toolchain.toml ./
COPY crates ./crates
COPY services/relay-server ./services/relay-server
COPY proto ./proto
COPY db ./db
RUN --mount=type=cache,target=/usr/local/cargo/registry,sharing=locked \
    --mount=type=cache,target=/workspace/target,sharing=locked \
    cargo build --locked --release --bin relay-server && \
    cp target/release/relay-server /tmp/relay-server

FROM alpine:3.23
RUN apk add --no-cache ca-certificates && \
    addgroup -S -g 10001 pocket && adduser -S -D -H -u 10001 -G pocket pocket
COPY --from=builder --chown=10001:10001 /tmp/relay-server /usr/local/bin/relay-server
USER 10001:10001
EXPOSE 8080
ENTRYPOINT ["/usr/local/bin/relay-server"]
