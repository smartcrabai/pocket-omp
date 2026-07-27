#![forbid(unsafe_code)]

use std::net::SocketAddr;

use anyhow::{Context, Result};
use axum::{Router, routing::get};
use relay_telemetry::{TelemetryConfig, init};
use tokio::net::TcpListener;

#[tokio::main]
async fn main() -> Result<()> {
    let bind = std::env::var("RELAY_BIND").unwrap_or_else(|_| "127.0.0.1:8080".to_owned());
    let address: SocketAddr = bind
        .parse()
        .context("RELAY_BIND must be a socket address")?;
    init(&TelemetryConfig {
        service_name: "pocket-omp-relay".to_owned(),
        filter: std::env::var("RUST_LOG").unwrap_or_else(|_| "info".to_owned()),
    })
    .map_err(|error| anyhow::anyhow!(error.to_string()))?;

    let application = Router::new()
        .route("/healthz", get(|| async { "ok" }))
        .route("/readyz", get(|| async { "ready" }));
    let listener = TcpListener::bind(address)
        .await
        .context("failed to bind relay listener")?;
    tracing::info!(%address, "relay listening");
    axum::serve(listener, application)
        .with_graceful_shutdown(shutdown_signal())
        .await?;
    Ok(())
}

async fn shutdown_signal() {
    let control_c = async {
        if tokio::signal::ctrl_c().await.is_err() {
            tracing::error!("failed to install ctrl-c handler");
        }
    };
    #[cfg(unix)]
    let terminate = async {
        match tokio::signal::unix::signal(tokio::signal::unix::SignalKind::terminate()) {
            Ok(mut signal) => {
                signal.recv().await;
            }
            Err(error) => tracing::error!(%error, "failed to install terminate handler"),
        }
    };
    #[cfg(not(unix))]
    let terminate = std::future::pending::<()>();
    tokio::select! { () = control_c => {}, () = terminate => {} }
}
