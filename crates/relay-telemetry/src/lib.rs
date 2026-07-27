#![forbid(unsafe_code)]

use tracing_subscriber::{EnvFilter, layer::SubscriberExt, util::SubscriberInitExt};

#[derive(Clone, Debug)]
pub struct TelemetryConfig {
    pub service_name: String,
    pub filter: String,
}

pub fn init(config: &TelemetryConfig) -> Result<(), Box<dyn std::error::Error + Send + Sync>> {
    let filter = EnvFilter::try_new(&config.filter)?;
    tracing_subscriber::registry()
        .with(filter)
        .with(tracing_subscriber::fmt::layer().json().flatten_event(true))
        .try_init()?;
    tracing::info!(service.name = %config.service_name, "telemetry initialized");
    Ok(())
}
