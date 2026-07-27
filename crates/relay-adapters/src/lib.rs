#![forbid(unsafe_code)]

use std::{
    borrow::Cow,
    collections::{BTreeMap, BTreeSet},
    error::Error,
    fmt,
    future::Future,
    pin::Pin,
    sync::Arc,
    time::{SystemTime, UNIX_EPOCH},
};

use async_trait::async_trait;
use jsonwebtoken::{Algorithm, DecodingKey, Validation, decode, decode_header};
use redis::AsyncCommands;
use relay_application::{
    AckResult, AppendBatch, AppendBatchResult, AppendItemResult, AppendOutcome, BusError, Clock,
    CursorRepository, IdGenerator, MessageKey, MessagePage, MessageRepository, ReplicationBatch,
    ReplicationError, ReplicationReceipt, RepositoryError, SnapshotRepository,
    StandbyReplicationPort, TicketError, TicketVerifier, WakeupBus, WakeupSubscription,
};
use relay_domain::{
    AccountId, ClientSequence, DeliveryState, DeviceId, DeviceKind, EncryptedSnapshot, Entitlement,
    EnvelopeDraft, KeyId, MessageId, NotificationHint, Priority, RegionId, RelayPrincipal,
    RouteEpoch, RouteId, ServerSequence, SnapshotId, StoredEnvelope,
};
use serde::Deserialize;
use sha2::{Digest, Sha256};
use sqlx::{PgPool, Postgres, QueryBuilder, Row};
use time::OffsetDateTime;
use tokio::sync::mpsc;
use tokio_stream::StreamExt;

#[derive(Debug, Deserialize)]
struct RelayTicketClaims {
    iss: String,
    aud: String,
    sub: String,
    exp: u64,
    iat: u64,
    jti: String,
    account_id: String,
    device_id: String,
    device_kind: String,
    route_grants: Vec<String>,
    entitlement: String,
    credential_generation: u64,
    home_region: String,
    relay_origin: String,
    route_epoch: u64,
}

#[async_trait]
pub trait TicketStatusPort: Send + Sync {
    async fn is_valid(
        &self,
        ticket_id: &str,
        device_id: &DeviceId,
        credential_generation: u64,
        route_grants: &[RouteId],
        route_epoch: u64,
    ) -> Result<bool, TicketError>;
}

#[derive(Clone)]
pub struct Ed25519TicketVerifier {
    keys: BTreeMap<String, DecodingKey>,
    validation: Validation,
    status: Arc<dyn TicketStatusPort>,
}

impl fmt::Debug for Ed25519TicketVerifier {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter
            .debug_struct("Ed25519TicketVerifier")
            .field("key_count", &self.keys.len())
            .finish_non_exhaustive()
    }
}

impl Ed25519TicketVerifier {
    pub fn new(
        public_keys_pem: BTreeMap<String, String>,
        issuer: &str,
        status: Arc<dyn TicketStatusPort>,
    ) -> Result<Self, jsonwebtoken::errors::Error> {
        let keys = public_keys_pem
            .into_iter()
            .map(|(key_id, pem)| DecodingKey::from_ed_pem(pem.as_bytes()).map(|key| (key_id, key)))
            .collect::<Result<_, _>>()?;
        let mut validation = Validation::new(Algorithm::EdDSA);
        validation.set_issuer(&[issuer]);
        validation.set_audience(&["pocket-omp-relay"]);
        validation.set_required_spec_claims(&["exp", "iat", "iss", "aud", "sub", "jti"]);
        validation.leeway = 30;
        Ok(Self {
            keys,
            validation,
            status,
        })
    }
}

#[async_trait]
impl TicketVerifier for Ed25519TicketVerifier {
    async fn verify(&self, ticket: &str) -> Result<RelayPrincipal, TicketError> {
        let header = decode_header(ticket).map_err(|_| TicketError::Invalid)?;
        let key_id = header.kid.ok_or(TicketError::Invalid)?;
        let key = self.keys.get(&key_id).ok_or(TicketError::Invalid)?;
        let token = decode::<RelayTicketClaims>(ticket, key, &self.validation)
            .map_err(|_| TicketError::Invalid)?;
        let claims = token.claims;
        if claims.entitlement != "relay_pro"
            || claims.sub != claims.device_id
            || claims.aud != "pocket-omp-relay"
            || claims.iss.is_empty()
            || claims.iat >= claims.exp
        {
            return Err(TicketError::Invalid);
        }
        let account_id = AccountId::parse(claims.account_id).map_err(|_| TicketError::Invalid)?;
        let device_id = DeviceId::parse(claims.device_id).map_err(|_| TicketError::Invalid)?;
        let device_kind = match claims.device_kind.as_str() {
            "HOST" => DeviceKind::Host,
            "MOBILE" => DeviceKind::Mobile,
            _ => return Err(TicketError::Invalid),
        };
        let route_grants = claims
            .route_grants
            .into_iter()
            .map(RouteId::parse)
            .collect::<Result<BTreeSet<_>, _>>()
            .map_err(|_| TicketError::Invalid)?;
        if route_grants.is_empty() {
            return Err(TicketError::Invalid);
        }
        if !self
            .status
            .is_valid(
                &claims.jti,
                &device_id,
                claims.credential_generation,
                &route_grants.iter().cloned().collect::<Vec<_>>(),
                claims.route_epoch,
            )
            .await?
        {
            return Err(TicketError::Revoked);
        }
        let expires_at_ms =
            i64::try_from(claims.exp.checked_mul(1_000).ok_or(TicketError::Invalid)?)
                .map_err(|_| TicketError::Invalid)?;
        let relay_origin = claims
            .relay_origin
            .parse::<http::Uri>()
            .map_err(|_| TicketError::Invalid)?;
        if relay_origin.scheme_str() != Some("https") {
            return Err(TicketError::Invalid);
        }
        Ok(RelayPrincipal {
            account_id,
            device_id,
            device_kind,
            route_grants,
            entitlement: Entitlement::RelayPro,
            credential_generation: claims.credential_generation,
            home_region: RegionId::parse(claims.home_region).map_err(|_| TicketError::Invalid)?,
            route_epoch: RouteEpoch::new(claims.route_epoch),
            expires_at_ms,
        })
    }
}

#[derive(Clone, Debug)]
pub struct RedisTicketStatus {
    client: redis::Client,
}

impl RedisTicketStatus {
    pub async fn connect(redis_url: &str) -> Result<Self, redis::RedisError> {
        let client = redis::Client::open(redis_url)?;
        let mut connection = client.get_multiplexed_async_connection().await?;
        let _: String = redis::cmd("PING").query_async(&mut connection).await?;
        Ok(Self { client })
    }
}

#[async_trait]
impl TicketStatusPort for RedisTicketStatus {
    async fn is_valid(
        &self,
        ticket_id: &str,
        device_id: &DeviceId,
        credential_generation: u64,
        route_grants: &[RouteId],
        route_epoch: u64,
    ) -> Result<bool, TicketError> {
        let mut connection = self
            .client
            .get_multiplexed_async_connection()
            .await
            .map_err(|_| TicketError::Unavailable)?;
        let revoked: bool = connection
            .sismember("relay:revoked_tickets", ticket_id)
            .await
            .map_err(|_| TicketError::Unavailable)?;
        if revoked {
            return Ok(false);
        }
        let current_generation: Option<u64> = connection
            .get(format!(
                "relay:credential_generation:{}",
                device_id.as_str()
            ))
            .await
            .map_err(|_| TicketError::Unavailable)?;
        if current_generation != Some(credential_generation) {
            return Ok(false);
        }
        for route in route_grants {
            let current_epoch: Option<u64> = connection
                .get(format!("relay:route_epoch:{}", route.as_str()))
                .await
                .map_err(|_| TicketError::Unavailable)?;
            if current_epoch != Some(route_epoch) {
                return Ok(false);
            }
        }
        Ok(true)
    }
}

#[derive(Clone, Copy, Debug, Default)]
pub struct SystemClock;

impl Clock for SystemClock {
    fn now_ms(&self) -> i64 {
        let duration = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap_or_default();
        i64::try_from(duration.as_millis()).unwrap_or(i64::MAX)
    }
}

#[derive(Clone, Copy, Debug, Default)]
pub struct UuidV7IdGenerator;

impl IdGenerator for UuidV7IdGenerator {
    fn new_id(&self) -> String {
        uuid::Uuid::now_v7().to_string()
    }
}

#[derive(Clone, Debug)]
pub struct RedisWakeupBus {
    client: redis::Client,
}

impl RedisWakeupBus {
    pub async fn connect(redis_url: &str) -> Result<Self, redis::RedisError> {
        let client = redis::Client::open(redis_url)?;
        let mut connection = client.get_multiplexed_async_connection().await?;
        let _: String = redis::cmd("PING").query_async(&mut connection).await?;
        Ok(Self { client })
    }
}

#[async_trait]
impl WakeupBus for RedisWakeupBus {
    async fn notify_recipient(&self, recipient: &DeviceId) -> Result<(), BusError> {
        let mut connection = self
            .client
            .get_multiplexed_async_connection()
            .await
            .map_err(|_| BusError::Unavailable)?;
        let channel = format!("relay:wakeup:{}", recipient.as_str());
        let _: usize = connection
            .publish(channel, recipient.as_str())
            .await
            .map_err(|_| BusError::Unavailable)?;
        Ok(())
    }

    async fn subscribe(&self, recipient: &DeviceId) -> Result<WakeupSubscription, BusError> {
        let mut subscription = self
            .client
            .get_async_pubsub()
            .await
            .map_err(|_| BusError::Unavailable)?;
        let channel = format!("relay:wakeup:{}", recipient.as_str());
        subscription
            .subscribe(channel)
            .await
            .map_err(|_| BusError::Unavailable)?;
        let mut messages = subscription.into_on_message();
        let (sender, receiver) = mpsc::channel(1);
        tokio::spawn(async move {
            while messages.next().await.is_some() {
                if sender.try_send(()).is_err() && sender.is_closed() {
                    return;
                }
            }
        });
        Ok(WakeupSubscription::from_receiver(receiver))
    }
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum PromotionError {
    Unavailable,
    Conflict,
    UnsafePendingMessages,
}

#[derive(Debug)]
struct EmbeddedRelayMigrations;

impl sqlx::migrate::MigrationSource<'static> for EmbeddedRelayMigrations {
    fn resolve(
        self,
    ) -> Pin<
        Box<
            dyn Future<
                    Output = Result<
                        Vec<sqlx::migrate::Migration>,
                        Box<dyn Error + Send + Sync + 'static>,
                    >,
                > + Send
                + 'static,
        >,
    > {
        Box::pin(async {
            Ok(vec![
                sqlx::migrate::Migration::new(
                    1,
                    Cow::Borrowed("relay"),
                    sqlx::migrate::MigrationType::Simple,
                    Cow::Borrowed(include_str!("../../../db/relay/0001_relay.sql")),
                    false,
                ),
                sqlx::migrate::Migration::new(
                    2,
                    Cow::Borrowed("replication receipt"),
                    sqlx::migrate::MigrationType::Simple,
                    Cow::Borrowed(include_str!(
                        "../../../db/relay/0002_replication_receipt.sql"
                    )),
                    false,
                ),
            ])
        })
    }
}

#[derive(Clone, Debug)]
pub struct PostgresRelayStore {
    pool: PgPool,
}

impl PostgresRelayStore {
    pub async fn connect(database_url: &str) -> Result<Self, sqlx::Error> {
        let pool = sqlx::postgres::PgPoolOptions::new()
            .max_connections(32)
            .connect(database_url)
            .await?;
        Ok(Self { pool })
    }

    pub async fn migrate(&self) -> Result<(), sqlx::migrate::MigrateError> {
        sqlx::migrate::Migrator::new(EmbeddedRelayMigrations)
            .await?
            .run(&self.pool)
            .await
    }

    #[must_use]
    pub fn pool(&self) -> &PgPool {
        &self.pool
    }

    pub async fn promote_recipient(
        &self,
        recipient: &DeviceId,
        expected_epoch: RouteEpoch,
        new_home_region: &RegionId,
        new_standby_region: &RegionId,
    ) -> Result<RouteEpoch, PromotionError> {
        let next_epoch = expected_epoch
            .get()
            .checked_add(1)
            .ok_or(PromotionError::Conflict)?;
        let expected_epoch =
            i64::try_from(expected_epoch.get()).map_err(|_| PromotionError::Conflict)?;
        let mut transaction = self
            .pool
            .begin()
            .await
            .map_err(|_| PromotionError::Unavailable)?;
        let state = sqlx::query("SELECT route_epoch FROM relay.recipient_state WHERE recipient_device_id = $1 FOR UPDATE")
            .bind(recipient.as_str()).fetch_optional(&mut *transaction).await.map_err(|_| PromotionError::Unavailable)?
            .ok_or(PromotionError::Conflict)?;
        if state
            .try_get::<i64, _>("route_epoch")
            .map_err(|_| PromotionError::Unavailable)?
            != expected_epoch
        {
            return Err(PromotionError::Conflict);
        }
        let pending = sqlx::query("SELECT count(*) AS pending FROM relay.message WHERE recipient_device_id = $1 AND delivery_state = 0")
            .bind(recipient.as_str()).fetch_one(&mut *transaction).await.map_err(|_| PromotionError::Unavailable)?
            .try_get::<i64, _>("pending").map_err(|_| PromotionError::Unavailable)?;
        if pending != 0 {
            return Err(PromotionError::UnsafePendingMessages);
        }
        let updated = sqlx::query("UPDATE relay.recipient_state SET home_region = $2, standby_region = $3, route_epoch = $4, lease_generation = NULL, lease_expires_at = NULL, updated_at = now() WHERE recipient_device_id = $1 AND route_epoch = $5")
            .bind(recipient.as_str()).bind(new_home_region.as_str()).bind(new_standby_region.as_str())
            .bind(i64::try_from(next_epoch).map_err(|_| PromotionError::Conflict)?).bind(expected_epoch)
            .execute(&mut *transaction).await.map_err(|_| PromotionError::Unavailable)?;
        if updated.rows_affected() != 1 {
            return Err(PromotionError::Conflict);
        }
        transaction
            .commit()
            .await
            .map_err(|_| PromotionError::Unavailable)?;
        Ok(RouteEpoch::new(next_epoch))
    }
}

#[derive(Clone, Debug)]
pub struct PostgresStandbyReplicator {
    store: PostgresRelayStore,
    target_region: RegionId,
}

impl PostgresStandbyReplicator {
    #[must_use]
    pub fn new(store: PostgresRelayStore, target_region: RegionId) -> Self {
        Self {
            store,
            target_region,
        }
    }
}

#[async_trait]
impl StandbyReplicationPort for PostgresStandbyReplicator {
    #[expect(
        clippy::too_many_lines,
        reason = "replication keeps receipt dedupe, payload verification, and durable transaction ordering explicit"
    )]
    async fn replicate_batch(
        &self,
        batch: ReplicationBatch,
    ) -> Result<ReplicationReceipt, ReplicationError> {
        if batch.target_region != self.target_region
            || batch
                .envelopes
                .iter()
                .any(|message| message.route_epoch != batch.route_epoch)
        {
            return Err(ReplicationError::Rejected);
        }
        let durable_through = batch
            .envelopes
            .iter()
            .map(|message| message.server_sequence)
            .max()
            .unwrap_or(ServerSequence::ZERO);
        let payload_hash = replication_batch_hash(&batch);
        let mut transaction = self
            .store
            .pool
            .begin()
            .await
            .map_err(|_| ReplicationError::Unavailable)?;
        sqlx::query("SELECT pg_advisory_xact_lock(hashtextextended($1, 0))")
            .bind(format!("replication:{}", batch.batch_id))
            .execute(&mut *transaction)
            .await
            .map_err(|_| ReplicationError::Unavailable)?;
        if let Some(existing) = sqlx::query("SELECT source_region, target_region, route_epoch, durable_through_sequence, payload_hash FROM relay.replication_batch WHERE batch_id = $1")
            .bind(&batch.batch_id).fetch_optional(&mut *transaction).await.map_err(|_| ReplicationError::Unavailable)? {
            let existing_hash: Vec<u8> = existing.try_get("payload_hash").map_err(|_| ReplicationError::Unavailable)?;
            let matches = existing.try_get::<String, _>("source_region").map_err(|_| ReplicationError::Unavailable)? == batch.source_region.as_str()
                && existing.try_get::<String, _>("target_region").map_err(|_| ReplicationError::Unavailable)? == batch.target_region.as_str()
                && existing.try_get::<i64, _>("route_epoch").map_err(|_| ReplicationError::Unavailable)? == i64::try_from(batch.route_epoch.get()).map_err(|_| ReplicationError::Rejected)?
                && existing.try_get::<i64, _>("durable_through_sequence").map_err(|_| ReplicationError::Unavailable)? == i64::try_from(durable_through.get()).map_err(|_| ReplicationError::Rejected)?
                && existing_hash.as_slice() == payload_hash;
            return if matches { Ok(ReplicationReceipt { durable_through }) } else { Err(ReplicationError::Rejected) };
        }

        for message in &batch.envelopes {
            let route_epoch =
                i64::try_from(batch.route_epoch.get()).map_err(|_| ReplicationError::Rejected)?;
            let next_sequence = i64::try_from(
                message
                    .server_sequence
                    .get()
                    .checked_add(1)
                    .ok_or(ReplicationError::Rejected)?,
            )
            .map_err(|_| ReplicationError::Rejected)?;
            let recipient_state = sqlx::query(
                "INSERT INTO relay.recipient_state (recipient_device_id, home_region, standby_region, route_epoch, next_sequence, acked_sequence) VALUES ($1,$2,$3,$4,$5,0) ON CONFLICT (recipient_device_id) DO UPDATE SET home_region = EXCLUDED.home_region, standby_region = EXCLUDED.standby_region, route_epoch = EXCLUDED.route_epoch, next_sequence = GREATEST(relay.recipient_state.next_sequence, EXCLUDED.next_sequence), updated_at = now() WHERE relay.recipient_state.route_epoch <= EXCLUDED.route_epoch",
            )
            .bind(message.envelope.recipient_device_id.as_str()).bind(batch.source_region.as_str())
            .bind(batch.target_region.as_str()).bind(route_epoch).bind(next_sequence)
            .execute(&mut *transaction).await.map_err(|_| ReplicationError::Unavailable)?;
            if recipient_state.rows_affected() != 1 {
                return Err(ReplicationError::Rejected);
            }

            let existing_message = sqlx::query("SELECT sender_device_id, message_id, ciphertext FROM relay.message WHERE recipient_device_id = $1 AND server_sequence = $2 LIMIT 1")
                .bind(message.envelope.recipient_device_id.as_str())
                .bind(i64::try_from(message.server_sequence.get()).map_err(|_| ReplicationError::Rejected)?)
                .fetch_optional(&mut *transaction).await.map_err(|_| ReplicationError::Unavailable)?;
            if let Some(existing) = existing_message {
                let matches = existing
                    .try_get::<String, _>("sender_device_id")
                    .map_err(|_| ReplicationError::Unavailable)?
                    == message.envelope.sender_device_id.as_str()
                    && existing
                        .try_get::<String, _>("message_id")
                        .map_err(|_| ReplicationError::Unavailable)?
                        == message.envelope.message_id.as_str()
                    && existing
                        .try_get::<Vec<u8>, _>("ciphertext")
                        .map_err(|_| ReplicationError::Unavailable)?
                        == message.envelope.ciphertext;
                if !matches {
                    return Err(ReplicationError::Rejected);
                }
            } else {
                sqlx::query(
                    "INSERT INTO relay.message (expires_at, recipient_device_id, server_sequence, sender_device_id, message_id, route_id, client_sequence, created_at, key_id, nonce, ciphertext, ciphertext_size, priority, notification_hint, delivery_state, home_region, route_epoch) VALUES ($1,$2,$3,$4,$5,$6,$7::numeric,$8,$9,$10,$11,$12,$13,$14,1,$15,$16)",
                )
                .bind(timestamp_from_ms(message.envelope.expires_at_ms).map_err(|_| ReplicationError::Rejected)?)
                .bind(message.envelope.recipient_device_id.as_str())
                .bind(i64::try_from(message.server_sequence.get()).map_err(|_| ReplicationError::Rejected)?)
                .bind(message.envelope.sender_device_id.as_str()).bind(message.envelope.message_id.as_str())
                .bind(message.envelope.route_id.as_str()).bind(message.envelope.client_sequence.get().to_string())
                .bind(timestamp_from_ms(message.envelope.created_at_ms).map_err(|_| ReplicationError::Rejected)?)
                .bind(message.envelope.key_id.as_str()).bind(&message.envelope.nonce).bind(&message.envelope.ciphertext)
                .bind(i32::try_from(message.envelope.ciphertext.len()).map_err(|_| ReplicationError::Rejected)?)
                .bind(priority_to_i16(message.envelope.priority)).bind(notification_hint_to_i16(message.envelope.notification_hint))
                .bind(batch.source_region.as_str()).bind(route_epoch)
                .execute(&mut *transaction).await.map_err(|_| ReplicationError::Unavailable)?;
            }
            let dedup = sqlx::query(
                "INSERT INTO relay.message_dedup (sender_device_id, message_id, payload_hash, recipient_device_id, server_sequence, expires_at, replication_status) VALUES ($1,$2,$3,$4,$5,$6,1) ON CONFLICT (sender_device_id, message_id) DO NOTHING",
            )
            .bind(message.envelope.sender_device_id.as_str()).bind(message.envelope.message_id.as_str())
            .bind(message.payload_hash.as_slice()).bind(message.envelope.recipient_device_id.as_str())
            .bind(i64::try_from(message.server_sequence.get()).map_err(|_| ReplicationError::Rejected)?)
            .bind(timestamp_from_ms(message.envelope.expires_at_ms).map_err(|_| ReplicationError::Rejected)?)
            .execute(&mut *transaction).await.map_err(|_| ReplicationError::Unavailable)?;
            if dedup.rows_affected() == 0 {
                let existing = sqlx::query("SELECT payload_hash, recipient_device_id, server_sequence FROM relay.message_dedup WHERE sender_device_id = $1 AND message_id = $2")
                    .bind(message.envelope.sender_device_id.as_str()).bind(message.envelope.message_id.as_str())
                    .fetch_one(&mut *transaction).await.map_err(|_| ReplicationError::Unavailable)?;
                let matches = existing
                    .try_get::<Vec<u8>, _>("payload_hash")
                    .map_err(|_| ReplicationError::Unavailable)?
                    .as_slice()
                    == message.payload_hash
                    && existing
                        .try_get::<String, _>("recipient_device_id")
                        .map_err(|_| ReplicationError::Unavailable)?
                        == message.envelope.recipient_device_id.as_str()
                    && existing
                        .try_get::<i64, _>("server_sequence")
                        .map_err(|_| ReplicationError::Unavailable)?
                        == i64::try_from(message.server_sequence.get())
                            .map_err(|_| ReplicationError::Rejected)?;
                if !matches {
                    return Err(ReplicationError::Rejected);
                }
            }
        }
        sqlx::query("INSERT INTO relay.replication_batch (batch_id, source_region, target_region, route_epoch, durable_through_sequence, payload_hash) VALUES ($1,$2,$3,$4,$5,$6)")
            .bind(&batch.batch_id).bind(batch.source_region.as_str()).bind(batch.target_region.as_str())
            .bind(i64::try_from(batch.route_epoch.get()).map_err(|_| ReplicationError::Rejected)?)
            .bind(i64::try_from(durable_through.get()).map_err(|_| ReplicationError::Rejected)?).bind(payload_hash.as_slice())
            .execute(&mut *transaction).await.map_err(|_| ReplicationError::Unavailable)?;
        transaction
            .commit()
            .await
            .map_err(|_| ReplicationError::Unavailable)?;
        Ok(ReplicationReceipt { durable_through })
    }
}

#[async_trait]
impl MessageRepository for PostgresRelayStore {
    #[expect(
        clippy::too_many_lines,
        reason = "append batch keeps advisory locking, dedupe, sequence allocation, and persistence in one transaction"
    )]
    async fn append_batch(&self, batch: AppendBatch) -> Result<AppendBatchResult, RepositoryError> {
        let mut transaction = self.pool.begin().await.map_err(repository_error)?;
        let mut results = Vec::with_capacity(batch.items.len());
        for item in batch.items {
            let message_key = MessageKey {
                sender_device_id: item.envelope.sender_device_id.clone(),
                message_id: item.envelope.message_id.clone(),
            };
            let advisory_key = format!(
                "{}:{}:{}",
                message_key.sender_device_id.as_str().len(),
                message_key.sender_device_id.as_str(),
                message_key.message_id.as_str()
            );
            sqlx::query("SELECT pg_advisory_xact_lock(hashtextextended($1, 0))")
                .bind(advisory_key)
                .execute(&mut *transaction)
                .await
                .map_err(repository_error)?;

            let existing = sqlx::query(
                "SELECT payload_hash, server_sequence, replication_status FROM relay.message_dedup WHERE sender_device_id = $1 AND message_id = $2",
            )
            .bind(message_key.sender_device_id.as_str())
            .bind(message_key.message_id.as_str())
            .fetch_optional(&mut *transaction)
            .await
            .map_err(repository_error)?;
            if let Some(existing) = existing {
                let payload_hash: Vec<u8> =
                    existing.try_get("payload_hash").map_err(repository_error)?;
                let sequence = sequence_from_i64(
                    existing
                        .try_get("server_sequence")
                        .map_err(repository_error)?,
                )?;
                let replication_status: i16 = existing
                    .try_get("replication_status")
                    .map_err(repository_error)?;
                results.push(AppendItemResult {
                    key: message_key,
                    outcome: if payload_hash.as_slice() == item.payload_hash {
                        AppendOutcome::Duplicate {
                            server_sequence: sequence,
                            deliverable: replication_status == 1,
                        }
                    } else {
                        AppendOutcome::Conflict
                    },
                });
                continue;
            }

            let route_epoch = i64_from_u64(item.route_epoch.get())?;
            sqlx::query(
                "INSERT INTO relay.recipient_state (recipient_device_id, home_region, standby_region, route_epoch, next_sequence, acked_sequence) VALUES ($1, $2, $3, $4, 1, 0) ON CONFLICT (recipient_device_id) DO NOTHING",
            )
            .bind(item.envelope.recipient_device_id.as_str())
            .bind(item.home_region.as_str())
            .bind(item.standby_region.as_str())
            .bind(route_epoch)
            .execute(&mut *transaction)
            .await
            .map_err(repository_error)?;
            let sequence_row = sqlx::query(
                "UPDATE relay.recipient_state SET next_sequence = next_sequence + 1, updated_at = now() WHERE recipient_device_id = $1 AND home_region = $2 AND standby_region = $3 AND route_epoch = $4 RETURNING next_sequence - 1 AS allocated_sequence",
            )
            .bind(item.envelope.recipient_device_id.as_str())
            .bind(item.home_region.as_str())
            .bind(item.standby_region.as_str())
            .bind(route_epoch)
            .fetch_optional(&mut *transaction)
            .await
            .map_err(repository_error)?
            .ok_or(RepositoryError::Conflict)?;
            let server_sequence = sequence_from_i64(
                sequence_row
                    .try_get("allocated_sequence")
                    .map_err(repository_error)?,
            )?;
            let expires_at = timestamp_from_ms(item.envelope.expires_at_ms)?;
            let created_at = timestamp_from_ms(item.envelope.created_at_ms)?;
            sqlx::query(
                "INSERT INTO relay.message (expires_at, recipient_device_id, server_sequence, sender_device_id, message_id, route_id, client_sequence, created_at, key_id, nonce, ciphertext, ciphertext_size, priority, notification_hint, delivery_state, home_region, route_epoch) VALUES ($1, $2, $3, $4, $5, $6, $7::numeric, $8, $9, $10, $11, $12, $13, $14, 0, $15, $16)",
            )
            .bind(expires_at)
            .bind(item.envelope.recipient_device_id.as_str())
            .bind(i64_from_u64(server_sequence.get())?)
            .bind(item.envelope.sender_device_id.as_str())
            .bind(item.envelope.message_id.as_str())
            .bind(item.envelope.route_id.as_str())
            .bind(item.envelope.client_sequence.get().to_string())
            .bind(created_at)
            .bind(item.envelope.key_id.as_str())
            .bind(&item.envelope.nonce)
            .bind(&item.envelope.ciphertext)
            .bind(i32::try_from(item.envelope.ciphertext.len()).map_err(|_| RepositoryError::Corrupt)?)
            .bind(priority_to_i16(item.envelope.priority))
            .bind(notification_hint_to_i16(item.envelope.notification_hint))
            .bind(item.home_region.as_str())
            .bind(route_epoch)
            .execute(&mut *transaction)
            .await
            .map_err(repository_error)?;
            sqlx::query(
                "INSERT INTO relay.message_dedup (sender_device_id, message_id, payload_hash, recipient_device_id, server_sequence, expires_at, replication_status) VALUES ($1, $2, $3, $4, $5, $6, 0)",
            )
            .bind(item.envelope.sender_device_id.as_str())
            .bind(item.envelope.message_id.as_str())
            .bind(item.payload_hash.as_slice())
            .bind(item.envelope.recipient_device_id.as_str())
            .bind(i64_from_u64(server_sequence.get())?)
            .bind(expires_at)
            .execute(&mut *transaction)
            .await
            .map_err(repository_error)?;
            sqlx::query(
                "INSERT INTO relay.replication_outbox (id, home_region, standby_region, recipient_device_id, server_sequence, payload_hash) VALUES ($1, $2, $3, $4, $5, $6)",
            )
            .bind(uuid::Uuid::now_v7())
            .bind(item.home_region.as_str())
            .bind(item.standby_region.as_str())
            .bind(item.envelope.recipient_device_id.as_str())
            .bind(i64_from_u64(server_sequence.get())?)
            .bind(item.payload_hash.as_slice())
            .execute(&mut *transaction)
            .await
            .map_err(repository_error)?;
            results.push(AppendItemResult {
                key: message_key,
                outcome: AppendOutcome::Inserted { server_sequence },
            });
        }
        transaction.commit().await.map_err(repository_error)?;
        Ok(AppendBatchResult { results })
    }

    async fn load_pending(
        &self,
        message_keys: &[MessageKey],
    ) -> Result<Vec<StoredEnvelope>, RepositoryError> {
        if message_keys.is_empty() {
            return Ok(Vec::new());
        }
        let senders: Vec<_> = message_keys
            .iter()
            .map(|key| key.sender_device_id.as_str().to_owned())
            .collect();
        let message_ids: Vec<_> = message_keys
            .iter()
            .map(|key| key.message_id.as_str().to_owned())
            .collect();
        let rows = sqlx::query(
            "SELECT m.*, m.client_sequence::text AS client_sequence_text, d.payload_hash FROM relay.message AS m JOIN relay.message_dedup AS d ON d.sender_device_id = m.sender_device_id AND d.message_id = m.message_id AND d.recipient_device_id = m.recipient_device_id AND d.server_sequence = m.server_sequence WHERE m.delivery_state = 0 AND (m.sender_device_id, m.message_id) IN (SELECT * FROM unnest($1::text[], $2::text[])) ORDER BY m.recipient_device_id, m.server_sequence",
        )
        .bind(senders)
        .bind(message_ids)
        .fetch_all(&self.pool)
        .await
        .map_err(repository_error)?;
        rows.into_iter()
            .map(|row| stored_envelope_from_row(&row))
            .collect()
    }

    async fn mark_deliverable(&self, message_keys: &[MessageKey]) -> Result<(), RepositoryError> {
        if message_keys.is_empty() {
            return Ok(());
        }
        let mut transaction = self.pool.begin().await.map_err(repository_error)?;
        for key in message_keys {
            let updated = sqlx::query(
                "UPDATE relay.message AS m SET delivery_state = 1 FROM relay.message_dedup AS d WHERE d.sender_device_id = $1 AND d.message_id = $2 AND m.sender_device_id = d.sender_device_id AND m.message_id = d.message_id AND m.recipient_device_id = d.recipient_device_id AND m.server_sequence = d.server_sequence",
            )
            .bind(key.sender_device_id.as_str())
            .bind(key.message_id.as_str())
            .execute(&mut *transaction)
            .await
            .map_err(repository_error)?;
            if updated.rows_affected() != 1 {
                return Err(RepositoryError::Conflict);
            }
            sqlx::query(
                "UPDATE relay.message_dedup SET replication_status = 1 WHERE sender_device_id = $1 AND message_id = $2",
            )
            .bind(key.sender_device_id.as_str())
            .bind(key.message_id.as_str())
            .execute(&mut *transaction)
            .await
            .map_err(repository_error)?;
            sqlx::query(
                "UPDATE relay.replication_outbox SET replicated_at = now() WHERE recipient_device_id = (SELECT recipient_device_id FROM relay.message_dedup WHERE sender_device_id = $1 AND message_id = $2) AND server_sequence = (SELECT server_sequence FROM relay.message_dedup WHERE sender_device_id = $1 AND message_id = $2)",
            )
            .bind(key.sender_device_id.as_str())
            .bind(key.message_id.as_str())
            .execute(&mut *transaction)
            .await
            .map_err(repository_error)?;
        }
        transaction.commit().await.map_err(repository_error)
    }

    async fn read_after(
        &self,
        recipient: &DeviceId,
        after: ServerSequence,
        limit: usize,
    ) -> Result<MessagePage, RepositoryError> {
        let mut query = message_select_builder();
        query
            .push(" WHERE m.recipient_device_id = ")
            .push_bind(recipient.as_str().to_owned())
            .push(" AND m.delivery_state = 1 AND m.server_sequence > ")
            .push_bind(i64_from_u64(after.get())?)
            .push(" ORDER BY m.server_sequence LIMIT ")
            .push_bind(i64::try_from(limit).map_err(|_| RepositoryError::Corrupt)?);
        let rows = query
            .build()
            .fetch_all(&self.pool)
            .await
            .map_err(repository_error)?;
        let messages = rows
            .iter()
            .map(stored_envelope_from_row)
            .collect::<Result<Vec<_>, _>>()?;
        let earliest = sqlx::query("SELECT min(server_sequence) AS earliest FROM relay.message WHERE recipient_device_id = $1 AND delivery_state = 1")
            .bind(recipient.as_str()).fetch_one(&self.pool).await.map_err(repository_error)?;
        let earliest_available = earliest
            .try_get::<Option<i64>, _>("earliest")
            .map_err(repository_error)?
            .map(sequence_from_i64)
            .transpose()?;
        let retention_gap = earliest_available.is_some_and(|sequence| {
            after != ServerSequence::ZERO && sequence.get() > after.get().saturating_add(1)
        });
        Ok(MessagePage {
            messages,
            retention_gap,
            earliest_available,
        })
    }

    async fn highest_issued(
        &self,
        recipient: &DeviceId,
    ) -> Result<ServerSequence, RepositoryError> {
        let row = sqlx::query("SELECT next_sequence - 1 AS highest FROM relay.recipient_state WHERE recipient_device_id = $1")
            .bind(recipient.as_str()).fetch_optional(&self.pool).await.map_err(repository_error)?;
        row.map_or(Ok(ServerSequence::ZERO), |row| {
            sequence_from_i64(row.try_get("highest").map_err(repository_error)?)
        })
    }
}

#[async_trait]
impl CursorRepository for PostgresRelayStore {
    async fn acknowledge(
        &self,
        recipient: &DeviceId,
        sequence: ServerSequence,
    ) -> Result<AckResult, RepositoryError> {
        let mut transaction = self.pool.begin().await.map_err(repository_error)?;
        let row = sqlx::query("SELECT acked_sequence, next_sequence - 1 AS highest FROM relay.recipient_state WHERE recipient_device_id = $1 FOR UPDATE")
            .bind(recipient.as_str()).fetch_optional(&mut *transaction).await.map_err(repository_error)?.ok_or(RepositoryError::Conflict)?;
        let current = sequence_from_i64(row.try_get("acked_sequence").map_err(repository_error)?)?;
        let highest = sequence_from_i64(row.try_get("highest").map_err(repository_error)?)?;
        if sequence < current || sequence > highest {
            return Err(RepositoryError::Conflict);
        }
        sqlx::query("UPDATE relay.recipient_state SET acked_sequence = $2, updated_at = now() WHERE recipient_device_id = $1")
            .bind(recipient.as_str()).bind(i64_from_u64(sequence.get())?).execute(&mut *transaction).await.map_err(repository_error)?;
        transaction.commit().await.map_err(repository_error)?;
        Ok(AckResult { accepted: sequence })
    }

    async fn current(&self, recipient: &DeviceId) -> Result<ServerSequence, RepositoryError> {
        let row = sqlx::query(
            "SELECT acked_sequence FROM relay.recipient_state WHERE recipient_device_id = $1",
        )
        .bind(recipient.as_str())
        .fetch_optional(&self.pool)
        .await
        .map_err(repository_error)?;
        row.map_or(Ok(ServerSequence::ZERO), |row| {
            sequence_from_i64(row.try_get("acked_sequence").map_err(repository_error)?)
        })
    }
}

#[async_trait]
impl SnapshotRepository for PostgresRelayStore {
    async fn put(&self, snapshot: EncryptedSnapshot) -> Result<(), RepositoryError> {
        let inserted = sqlx::query(
            "INSERT INTO relay.snapshot (recipient_device_id, snapshot_id, route_id, created_at, expires_at, covers_through_sequence, key_id, nonce, ciphertext, ciphertext_size) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) ON CONFLICT (recipient_device_id, snapshot_id) DO NOTHING",
        )
        .bind(snapshot.recipient_device_id.as_str()).bind(snapshot.snapshot_id.as_str()).bind(snapshot.route_id.as_str())
        .bind(timestamp_from_ms(snapshot.created_at_ms)?).bind(timestamp_from_ms(snapshot.expires_at_ms)?)
        .bind(i64_from_u64(snapshot.covers_through_sequence.get())?).bind(snapshot.key_id.as_str())
        .bind(&snapshot.nonce).bind(&snapshot.ciphertext)
        .bind(i32::try_from(snapshot.ciphertext.len()).map_err(|_| RepositoryError::Corrupt)?)
        .execute(&self.pool).await.map_err(repository_error)?;
        if inserted.rows_affected() == 1 {
            return Ok(());
        }
        let existing = sqlx::query("SELECT route_id, covers_through_sequence, key_id, nonce, ciphertext FROM relay.snapshot WHERE recipient_device_id = $1 AND snapshot_id = $2")
            .bind(snapshot.recipient_device_id.as_str()).bind(snapshot.snapshot_id.as_str()).fetch_one(&self.pool).await.map_err(repository_error)?;
        let same = existing
            .try_get::<String, _>("route_id")
            .map_err(repository_error)?
            == snapshot.route_id.as_str()
            && sequence_from_i64(
                existing
                    .try_get("covers_through_sequence")
                    .map_err(repository_error)?,
            )? == snapshot.covers_through_sequence
            && existing
                .try_get::<String, _>("key_id")
                .map_err(repository_error)?
                == snapshot.key_id.as_str()
            && existing
                .try_get::<Vec<u8>, _>("nonce")
                .map_err(repository_error)?
                == snapshot.nonce
            && existing
                .try_get::<Vec<u8>, _>("ciphertext")
                .map_err(repository_error)?
                == snapshot.ciphertext;
        if same {
            Ok(())
        } else {
            Err(RepositoryError::Conflict)
        }
    }

    async fn get(
        &self,
        recipient: &DeviceId,
        snapshot_id: Option<&str>,
    ) -> Result<Option<EncryptedSnapshot>, RepositoryError> {
        let row = if let Some(snapshot_id) = snapshot_id {
            sqlx::query(
                "SELECT * FROM relay.snapshot WHERE recipient_device_id = $1 AND snapshot_id = $2",
            )
            .bind(recipient.as_str())
            .bind(snapshot_id)
            .fetch_optional(&self.pool)
            .await
            .map_err(repository_error)?
        } else {
            sqlx::query("SELECT * FROM relay.snapshot WHERE recipient_device_id = $1 AND expires_at > now() ORDER BY created_at DESC LIMIT 1")
                .bind(recipient.as_str()).fetch_optional(&self.pool).await.map_err(repository_error)?
        };
        row.as_ref().map(snapshot_from_row).transpose()
    }
}

fn message_select_builder() -> QueryBuilder<'static, Postgres> {
    QueryBuilder::new(
        "SELECT m.*, m.client_sequence::text AS client_sequence_text, d.payload_hash FROM relay.message AS m JOIN relay.message_dedup AS d ON d.sender_device_id = m.sender_device_id AND d.message_id = m.message_id AND d.recipient_device_id = m.recipient_device_id AND d.server_sequence = m.server_sequence",
    )
}

fn stored_envelope_from_row(
    row: &sqlx::postgres::PgRow,
) -> Result<StoredEnvelope, RepositoryError> {
    let created_at: OffsetDateTime = row.try_get("created_at").map_err(repository_error)?;
    let expires_at: OffsetDateTime = row.try_get("expires_at").map_err(repository_error)?;
    let client_sequence: String = row
        .try_get("client_sequence_text")
        .map_err(repository_error)?;
    let delivery_state: i16 = row.try_get("delivery_state").map_err(repository_error)?;
    let payload_hash: Vec<u8> = row.try_get("payload_hash").map_err(repository_error)?;
    let payload_hash: [u8; 32] = payload_hash
        .try_into()
        .map_err(|_| RepositoryError::Corrupt)?;
    Ok(StoredEnvelope {
        server_sequence: sequence_from_i64(
            row.try_get("server_sequence").map_err(repository_error)?,
        )?,
        envelope: EnvelopeDraft {
            message_id: MessageId::parse(
                row.try_get::<String, _>("message_id")
                    .map_err(repository_error)?,
            )
            .map_err(|_| RepositoryError::Corrupt)?,
            route_id: RouteId::parse(
                row.try_get::<String, _>("route_id")
                    .map_err(repository_error)?,
            )
            .map_err(|_| RepositoryError::Corrupt)?,
            sender_device_id: DeviceId::parse(
                row.try_get::<String, _>("sender_device_id")
                    .map_err(repository_error)?,
            )
            .map_err(|_| RepositoryError::Corrupt)?,
            recipient_device_id: DeviceId::parse(
                row.try_get::<String, _>("recipient_device_id")
                    .map_err(repository_error)?,
            )
            .map_err(|_| RepositoryError::Corrupt)?,
            client_sequence: ClientSequence::new(
                client_sequence
                    .parse()
                    .map_err(|_| RepositoryError::Corrupt)?,
            ),
            created_at_ms: milliseconds(created_at)?,
            expires_at_ms: milliseconds(expires_at)?,
            key_id: KeyId::parse(
                row.try_get::<String, _>("key_id")
                    .map_err(repository_error)?,
            )
            .map_err(|_| RepositoryError::Corrupt)?,
            nonce: row.try_get("nonce").map_err(repository_error)?,
            ciphertext: row.try_get("ciphertext").map_err(repository_error)?,
            priority: priority_from_i16(row.try_get("priority").map_err(repository_error)?)?,
            notification_hint: notification_hint_from_i16(
                row.try_get("notification_hint").map_err(repository_error)?,
            )?,
        },
        payload_hash,
        delivery_state: match delivery_state {
            0 => DeliveryState::PendingReplication,
            1 => DeliveryState::Deliverable,
            _ => return Err(RepositoryError::Corrupt),
        },
        home_region: RegionId::parse(
            row.try_get::<String, _>("home_region")
                .map_err(repository_error)?,
        )
        .map_err(|_| RepositoryError::Corrupt)?,
        route_epoch: RouteEpoch::new(u64_from_i64(
            row.try_get("route_epoch").map_err(repository_error)?,
        )?),
    })
}

fn snapshot_from_row(row: &sqlx::postgres::PgRow) -> Result<EncryptedSnapshot, RepositoryError> {
    Ok(EncryptedSnapshot {
        recipient_device_id: DeviceId::parse(
            row.try_get::<String, _>("recipient_device_id")
                .map_err(repository_error)?,
        )
        .map_err(|_| RepositoryError::Corrupt)?,
        snapshot_id: SnapshotId::parse(
            row.try_get::<String, _>("snapshot_id")
                .map_err(repository_error)?,
        )
        .map_err(|_| RepositoryError::Corrupt)?,
        route_id: RouteId::parse(
            row.try_get::<String, _>("route_id")
                .map_err(repository_error)?,
        )
        .map_err(|_| RepositoryError::Corrupt)?,
        created_at_ms: milliseconds(row.try_get("created_at").map_err(repository_error)?)?,
        expires_at_ms: milliseconds(row.try_get("expires_at").map_err(repository_error)?)?,
        covers_through_sequence: sequence_from_i64(
            row.try_get("covers_through_sequence")
                .map_err(repository_error)?,
        )?,
        key_id: KeyId::parse(
            row.try_get::<String, _>("key_id")
                .map_err(repository_error)?,
        )
        .map_err(|_| RepositoryError::Corrupt)?,
        nonce: row.try_get("nonce").map_err(repository_error)?,
        ciphertext: row.try_get("ciphertext").map_err(repository_error)?,
    })
}

fn replication_batch_hash(batch: &ReplicationBatch) -> [u8; 32] {
    let mut hasher = Sha256::new();
    for value in [batch.source_region.as_str(), batch.target_region.as_str()] {
        hasher.update(value.len().to_be_bytes());
        hasher.update(value.as_bytes());
    }
    hasher.update(batch.route_epoch.get().to_be_bytes());
    for message in &batch.envelopes {
        hasher.update(
            message
                .envelope
                .recipient_device_id
                .as_str()
                .len()
                .to_be_bytes(),
        );
        hasher.update(message.envelope.recipient_device_id.as_str().as_bytes());
        hasher.update(message.server_sequence.get().to_be_bytes());
        hasher.update(message.payload_hash);
    }
    hasher.finalize().into()
}

fn repository_error(_error: sqlx::Error) -> RepositoryError {
    RepositoryError::Unavailable
}
fn i64_from_u64(value: u64) -> Result<i64, RepositoryError> {
    i64::try_from(value).map_err(|_| RepositoryError::Corrupt)
}
fn u64_from_i64(value: i64) -> Result<u64, RepositoryError> {
    u64::try_from(value).map_err(|_| RepositoryError::Corrupt)
}
fn sequence_from_i64(value: i64) -> Result<ServerSequence, RepositoryError> {
    Ok(ServerSequence::new(u64_from_i64(value)?))
}
fn timestamp_from_ms(value: i64) -> Result<OffsetDateTime, RepositoryError> {
    OffsetDateTime::from_unix_timestamp_nanos(i128::from(value) * 1_000_000)
        .map_err(|_| RepositoryError::Corrupt)
}
fn milliseconds(value: OffsetDateTime) -> Result<i64, RepositoryError> {
    i64::try_from(value.unix_timestamp_nanos() / 1_000_000).map_err(|_| RepositoryError::Corrupt)
}
fn priority_to_i16(value: Priority) -> i16 {
    match value {
        Priority::Normal => 1,
        Priority::High => 2,
    }
}
fn priority_from_i16(value: i16) -> Result<Priority, RepositoryError> {
    match value {
        0 | 1 => Ok(Priority::Normal),
        2 => Ok(Priority::High),
        _ => Err(RepositoryError::Corrupt),
    }
}
fn notification_hint_to_i16(value: NotificationHint) -> i16 {
    match value {
        NotificationHint::None => 1,
        NotificationHint::Wake => 2,
        NotificationHint::AttentionRequired => 3,
        NotificationHint::RunFinished => 4,
    }
}
fn notification_hint_from_i16(value: i16) -> Result<NotificationHint, RepositoryError> {
    match value {
        0 | 1 => Ok(NotificationHint::None),
        2 => Ok(NotificationHint::Wake),
        3 => Ok(NotificationHint::AttentionRequired),
        4 => Ok(NotificationHint::RunFinished),
        _ => Err(RepositoryError::Corrupt),
    }
}
