#![forbid(unsafe_code)]

use anyhow::{Context, Result};
use relay_adapters::PostgresRelayStore;

#[tokio::main]
async fn main() -> Result<()> {
    let database_url =
        std::env::var("RELAY_DATABASE_URL").context("RELAY_DATABASE_URL is required")?;
    let store = PostgresRelayStore::connect(&database_url)
        .await
        .context("failed to connect relay database")?;
    store.migrate().await.context("relay migration failed")?;
    Ok(())
}
