#![forbid(unsafe_code)]

use std::{
    collections::{BTreeMap, BTreeSet},
    error::Error,
    fmt,
    sync::Arc,
    time::Duration,
};

use async_trait::async_trait;
use relay_domain::{
    DeviceId, EncryptedSnapshot, EnvelopeDraft, EnvelopeLimitPolicy, MessageId, RegionId,
    RelayPrincipal, RouteEpoch, RoutingPolicy, ServerSequence, StoredEnvelope,
};
use sha2::{Digest, Sha256};
use tokio::sync::mpsc;

#[derive(Clone, Debug)]
pub struct PublishEnvelopesCommand {
    pub principal: RelayPrincipal,
    pub envelopes: Vec<EnvelopeDraft>,
    pub piggyback_ack: Option<ServerSequence>,
    pub target_region: RegionId,
    pub standby_region: RegionId,
    pub route_epoch: RouteEpoch,
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub enum PublishOutcome {
    Accepted {
        server_sequence: ServerSequence,
        duplicate: bool,
    },
    Rejected {
        code: &'static str,
    },
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct PublishItemResult {
    pub message_id: MessageId,
    pub outcome: PublishOutcome,
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct PublishBatchResult {
    pub results: Vec<PublishItemResult>,
    pub accepted_ack: ServerSequence,
}

#[derive(Clone, Debug)]
pub struct AppendItem {
    pub envelope: EnvelopeDraft,
    pub payload_hash: [u8; 32],
    pub home_region: RegionId,
    pub standby_region: RegionId,
    pub route_epoch: RouteEpoch,
}

#[derive(Clone, Debug)]
pub struct AppendBatch {
    pub items: Vec<AppendItem>,
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub enum AppendOutcome {
    Inserted {
        server_sequence: ServerSequence,
    },
    Duplicate {
        server_sequence: ServerSequence,
        deliverable: bool,
    },
    Conflict,
    QuotaExceeded,
}

#[derive(Clone, Debug, Eq, Ord, PartialEq, PartialOrd)]
pub struct MessageKey {
    pub sender_device_id: DeviceId,
    pub message_id: MessageId,
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct AppendItemResult {
    pub key: MessageKey,
    pub outcome: AppendOutcome,
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct AppendBatchResult {
    pub results: Vec<AppendItemResult>,
}

#[derive(Clone, Debug)]
pub struct ReplicationBatch {
    pub batch_id: String,
    pub source_region: RegionId,
    pub target_region: RegionId,
    pub route_epoch: RouteEpoch,
    pub envelopes: Vec<StoredEnvelope>,
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct ReplicationReceipt {
    pub durable_through: ServerSequence,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub struct AckResult {
    pub accepted: ServerSequence,
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct MessagePage {
    pub messages: Vec<StoredEnvelope>,
    pub retention_gap: bool,
    pub earliest_available: Option<ServerSequence>,
}
#[derive(Clone, Copy, Debug)]
pub struct SubscriptionOptions {
    pub max_in_flight: usize,
    pub idle_poll_interval: Duration,
    pub send_timeout: Duration,
}

impl Default for SubscriptionOptions {
    fn default() -> Self {
        Self {
            max_in_flight: 64,
            idle_poll_interval: Duration::from_secs(1),
            send_timeout: Duration::from_secs(5),
        }
    }
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub enum SubscriptionItem {
    Envelope(Box<StoredEnvelope>),
    ResetRequired { earliest_available: ServerSequence },
}

#[derive(Debug)]
pub struct MessageSubscription {
    receiver: mpsc::Receiver<Result<SubscriptionItem, ApplicationError>>,
}

impl MessageSubscription {
    pub async fn recv(&mut self) -> Option<Result<SubscriptionItem, ApplicationError>> {
        self.receiver.recv().await
    }
}

#[derive(Debug)]
pub struct WakeupSubscription {
    receiver: mpsc::Receiver<()>,
}

impl WakeupSubscription {
    #[must_use]
    pub fn from_receiver(receiver: mpsc::Receiver<()>) -> Self {
        Self { receiver }
    }

    pub async fn recv(&mut self) -> Option<()> {
        self.receiver.recv().await
    }
}

#[async_trait]
pub trait MessageRepository: Send + Sync {
    async fn append_batch(&self, batch: AppendBatch) -> Result<AppendBatchResult, RepositoryError>;
    async fn load_pending(
        &self,
        message_keys: &[MessageKey],
    ) -> Result<Vec<StoredEnvelope>, RepositoryError>;
    async fn mark_deliverable(&self, message_keys: &[MessageKey]) -> Result<(), RepositoryError>;
    async fn read_after(
        &self,
        recipient: &DeviceId,
        after: ServerSequence,
        limit: usize,
    ) -> Result<MessagePage, RepositoryError>;
    async fn highest_issued(&self, recipient: &DeviceId)
    -> Result<ServerSequence, RepositoryError>;
}

#[async_trait]
pub trait CursorRepository: Send + Sync {
    async fn acknowledge(
        &self,
        recipient: &DeviceId,
        sequence: ServerSequence,
    ) -> Result<AckResult, RepositoryError>;
    async fn current(&self, recipient: &DeviceId) -> Result<ServerSequence, RepositoryError>;
}

#[async_trait]
pub trait SnapshotRepository: Send + Sync {
    async fn put(&self, snapshot: EncryptedSnapshot) -> Result<(), RepositoryError>;
    async fn get(
        &self,
        recipient: &DeviceId,
        snapshot_id: Option<&str>,
    ) -> Result<Option<EncryptedSnapshot>, RepositoryError>;
}

#[async_trait]
pub trait WakeupBus: Send + Sync {
    async fn notify_recipient(&self, recipient: &DeviceId) -> Result<(), BusError>;
    async fn subscribe(&self, recipient: &DeviceId) -> Result<WakeupSubscription, BusError>;
}
#[async_trait]
pub trait TicketVerifier: Send + Sync {
    async fn verify(&self, ticket: &str) -> Result<RelayPrincipal, TicketError>;
}

#[async_trait]
pub trait StandbyReplicationPort: Send + Sync {
    async fn replicate_batch(
        &self,
        batch: ReplicationBatch,
    ) -> Result<ReplicationReceipt, ReplicationError>;
}

pub trait Clock: Send + Sync {
    fn now_ms(&self) -> i64;
}

pub trait IdGenerator: Send + Sync {
    fn new_id(&self) -> String;
}

#[derive(Clone)]
pub struct RelayDependencies {
    pub messages: Arc<dyn MessageRepository>,
    pub cursors: Arc<dyn CursorRepository>,
    pub snapshots: Arc<dyn SnapshotRepository>,
    pub wakeups: Arc<dyn WakeupBus>,
    pub standby: Arc<dyn StandbyReplicationPort>,
    pub clock: Arc<dyn Clock>,
    pub ids: Arc<dyn IdGenerator>,
}

impl fmt::Debug for RelayDependencies {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter
            .debug_struct("RelayDependencies")
            .finish_non_exhaustive()
    }
}

#[derive(Clone)]
pub struct RelayApplication {
    messages: Arc<dyn MessageRepository>,
    cursors: Arc<dyn CursorRepository>,
    snapshots: Arc<dyn SnapshotRepository>,
    wakeups: Arc<dyn WakeupBus>,
    standby: Arc<dyn StandbyReplicationPort>,
    clock: Arc<dyn Clock>,
    ids: Arc<dyn IdGenerator>,
    envelope_policy: EnvelopeLimitPolicy,
}

impl fmt::Debug for RelayApplication {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter
            .debug_struct("RelayApplication")
            .finish_non_exhaustive()
    }
}

impl RelayApplication {
    #[must_use]
    pub fn new(dependencies: RelayDependencies, envelope_policy: EnvelopeLimitPolicy) -> Self {
        Self {
            messages: dependencies.messages,
            cursors: dependencies.cursors,
            snapshots: dependencies.snapshots,
            wakeups: dependencies.wakeups,
            standby: dependencies.standby,
            clock: dependencies.clock,
            ids: dependencies.ids,
            envelope_policy,
        }
    }

    #[expect(
        clippy::too_many_lines,
        reason = "publish keeps validation, durable replication, deliverability, and ACK ordering visible in one transaction orchestration"
    )]
    pub async fn publish(
        &self,
        command: PublishEnvelopesCommand,
    ) -> Result<PublishBatchResult, ApplicationError> {
        self.envelope_policy
            .validate_batch(&command.envelopes, self.clock.now_ms())?;
        for envelope in &command.envelopes {
            RoutingPolicy::validate(
                &command.principal,
                envelope,
                &command.target_region,
                command.route_epoch,
            )?;
        }

        let recipients_by_message: BTreeMap<_, _> = command
            .envelopes
            .iter()
            .map(|envelope| {
                (
                    envelope.message_id.clone(),
                    envelope.recipient_device_id.clone(),
                )
            })
            .collect();
        let append = AppendBatch {
            items: command
                .envelopes
                .into_iter()
                .map(|envelope| {
                    let payload_hash = envelope_hash(&envelope);
                    AppendItem {
                        envelope,
                        payload_hash,
                        home_region: command.target_region.clone(),
                        standby_region: command.standby_region.clone(),
                        route_epoch: command.route_epoch,
                    }
                })
                .collect(),
        };
        let appended = self.messages.append_batch(append).await?;
        let pending_keys: Vec<_> = appended
            .results
            .iter()
            .filter_map(|item| match item.outcome {
                AppendOutcome::Inserted { .. }
                | AppendOutcome::Duplicate {
                    deliverable: false, ..
                } => Some(item.key.clone()),
                AppendOutcome::Duplicate {
                    deliverable: true, ..
                }
                | AppendOutcome::Conflict
                | AppendOutcome::QuotaExceeded => None,
            })
            .collect();

        if !pending_keys.is_empty() {
            let pending = self.messages.load_pending(&pending_keys).await?;
            if !pending.is_empty() {
                let expected_durable_through = pending
                    .iter()
                    .map(|message| message.server_sequence)
                    .max()
                    .unwrap_or(ServerSequence::ZERO);
                let receipt = self
                    .standby
                    .replicate_batch(ReplicationBatch {
                        batch_id: self.ids.new_id(),
                        source_region: command.target_region.clone(),
                        target_region: command.standby_region.clone(),
                        route_epoch: command.route_epoch,
                        envelopes: pending,
                    })
                    .await?;
                if receipt.durable_through < expected_durable_through {
                    return Err(ApplicationError::Replication(ReplicationError::Rejected));
                }
                self.messages.mark_deliverable(&pending_keys).await?;
            }
        }

        let mut results = Vec::with_capacity(appended.results.len());
        for item in appended.results {
            let outcome = match item.outcome {
                AppendOutcome::Inserted { server_sequence } => PublishOutcome::Accepted {
                    server_sequence,
                    duplicate: false,
                },
                AppendOutcome::Duplicate {
                    server_sequence, ..
                } => PublishOutcome::Accepted {
                    server_sequence,
                    duplicate: true,
                },
                AppendOutcome::Conflict => PublishOutcome::Rejected {
                    code: "IDEMPOTENCY_CONFLICT",
                },
                AppendOutcome::QuotaExceeded => PublishOutcome::Rejected {
                    code: "QUEUE_QUOTA_EXCEEDED",
                },
            };
            results.push(PublishItemResult {
                message_id: item.key.message_id,
                outcome,
            });
        }

        let recipients: BTreeSet<_> = results
            .iter()
            .filter_map(|item| match item.outcome {
                PublishOutcome::Accepted { .. } => {
                    recipients_by_message.get(&item.message_id).cloned()
                }
                PublishOutcome::Rejected { .. } => None,
            })
            .collect();
        for recipient in recipients {
            let _ = self.wakeups.notify_recipient(&recipient).await;
        }

        let accepted_ack = if let Some(sequence) = command.piggyback_ack {
            self.acknowledge(&command.principal.device_id, sequence)
                .await?
                .accepted
        } else {
            self.cursors.current(&command.principal.device_id).await?
        };
        Ok(PublishBatchResult {
            results,
            accepted_ack,
        })
    }

    pub async fn acknowledge(
        &self,
        recipient: &DeviceId,
        sequence: ServerSequence,
    ) -> Result<AckResult, ApplicationError> {
        let highest = self.messages.highest_issued(recipient).await?;
        if sequence > highest {
            return Err(ApplicationError::AckBeyondIssued);
        }
        let current = self.cursors.current(recipient).await?;
        if sequence < current {
            return Err(ApplicationError::AckRegression);
        }
        let result = self.cursors.acknowledge(recipient, sequence).await?;
        let _ = self.wakeups.notify_recipient(recipient).await;
        Ok(result)
    }

    pub async fn read_after(
        &self,
        recipient: &DeviceId,
        after: ServerSequence,
        limit: usize,
    ) -> Result<MessagePage, ApplicationError> {
        if limit == 0 || limit > 128 {
            return Err(ApplicationError::InvalidReadLimit);
        }
        self.messages
            .read_after(recipient, after, limit)
            .await
            .map_err(Into::into)
    }

    pub async fn put_snapshot(&self, snapshot: EncryptedSnapshot) -> Result<(), ApplicationError> {
        if snapshot.nonce.len() != 24
            || snapshot.ciphertext.is_empty()
            || snapshot.ciphertext.len() > 32 * 1024 * 1024
        {
            return Err(ApplicationError::InvalidSnapshot);
        }
        self.snapshots.put(snapshot).await.map_err(Into::into)
    }

    pub async fn subscribe(
        &self,
        recipient: DeviceId,
        after: ServerSequence,
        options: SubscriptionOptions,
    ) -> Result<MessageSubscription, ApplicationError> {
        if options.max_in_flight == 0
            || options.max_in_flight > 128
            || options.idle_poll_interval.is_zero()
            || options.send_timeout.is_zero()
        {
            return Err(ApplicationError::InvalidReadLimit);
        }
        let mut wakeups = self
            .wakeups
            .subscribe(&recipient)
            .await
            .map_err(|_| ApplicationError::Repository(RepositoryError::Unavailable))?;
        let application = self.clone();
        let (sender, receiver) = mpsc::channel(1);
        tokio::spawn(async move {
            let mut delivered_through = after;
            loop {
                let accepted_ack = match application.cursors.current(&recipient).await {
                    Ok(sequence) => sequence,
                    Err(error) => {
                        let _ = sender.try_send(Err(error.into()));
                        return;
                    }
                };
                let window_end = accepted_ack
                    .get()
                    .saturating_add(options.max_in_flight as u64);
                if delivered_through.get() < window_end {
                    let remaining = window_end.saturating_sub(delivered_through.get());
                    let limit = usize::try_from(remaining.min(128)).unwrap_or(128);
                    match application
                        .messages
                        .read_after(&recipient, delivered_through, limit)
                        .await
                    {
                        Ok(page) => {
                            if page.retention_gap {
                                if let Some(earliest_available) = page.earliest_available
                                    && tokio::time::timeout(
                                        options.send_timeout,
                                        sender.send(Ok(SubscriptionItem::ResetRequired {
                                            earliest_available,
                                        })),
                                    )
                                    .await
                                    .is_err()
                                {
                                    return;
                                }
                                return;
                            }
                            if !page.messages.is_empty() {
                                for message in page.messages {
                                    delivered_through = message.server_sequence;
                                    if tokio::time::timeout(
                                        options.send_timeout,
                                        sender.send(Ok(SubscriptionItem::Envelope(Box::new(
                                            message,
                                        )))),
                                    )
                                    .await
                                    .is_err()
                                    {
                                        return;
                                    }
                                }
                                continue;
                            }
                        }
                        Err(error) => {
                            let _ = sender.try_send(Err(error.into()));
                            return;
                        }
                    }
                }
                tokio::select! {
                    () = tokio::time::sleep(options.idle_poll_interval) => {}
                    signal = wakeups.recv() => {
                        if signal.is_none() {
                            return;
                        }
                    }
                }
            }
        });
        Ok(MessageSubscription { receiver })
    }

    pub async fn get_snapshot(
        &self,
        recipient: &DeviceId,
        snapshot_id: Option<&str>,
    ) -> Result<Option<EncryptedSnapshot>, ApplicationError> {
        self.snapshots
            .get(recipient, snapshot_id)
            .await
            .map_err(Into::into)
    }
}

fn envelope_hash(envelope: &EnvelopeDraft) -> [u8; 32] {
    let mut hasher = Sha256::new();
    for value in [
        envelope.message_id.as_str(),
        envelope.route_id.as_str(),
        envelope.sender_device_id.as_str(),
        envelope.recipient_device_id.as_str(),
        envelope.key_id.as_str(),
    ] {
        hasher.update((value.len() as u64).to_be_bytes());
        hasher.update(value.as_bytes());
    }
    hasher.update(envelope.client_sequence.get().to_be_bytes());
    hasher.update(envelope.created_at_ms.to_be_bytes());
    hasher.update(envelope.expires_at_ms.to_be_bytes());
    hasher.update((envelope.nonce.len() as u64).to_be_bytes());
    hasher.update(&envelope.nonce);
    hasher.update((envelope.ciphertext.len() as u64).to_be_bytes());
    hasher.update(&envelope.ciphertext);
    hasher.finalize().into()
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum RepositoryError {
    Unavailable,
    Conflict,
    Corrupt,
}
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum BusError {
    Unavailable,
}
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum ReplicationError {
    Unavailable,
    Rejected,
}

#[derive(Debug)]
pub enum ApplicationError {
    Domain(relay_domain::DomainError),
    Repository(RepositoryError),
    Replication(ReplicationError),
    AckRegression,
    AckBeyondIssued,
    InvalidReadLimit,
    InvalidSnapshot,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum TicketError {
    Invalid,
    Expired,
    Revoked,
    Unavailable,
}

impl fmt::Display for ApplicationError {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        write!(formatter, "{self:?}")
    }
}
impl Error for ApplicationError {}
impl From<relay_domain::DomainError> for ApplicationError {
    fn from(value: relay_domain::DomainError) -> Self {
        Self::Domain(value)
    }
}
impl From<RepositoryError> for ApplicationError {
    fn from(value: RepositoryError) -> Self {
        Self::Repository(value)
    }
}
impl From<ReplicationError> for ApplicationError {
    fn from(value: ReplicationError) -> Self {
        Self::Replication(value)
    }
}
