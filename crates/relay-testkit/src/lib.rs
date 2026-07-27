#![forbid(unsafe_code)]

use std::{
    collections::BTreeMap,
    sync::{
        Arc,
        atomic::{AtomicI64, AtomicU64, Ordering},
    },
};

use async_trait::async_trait;
use relay_application::{
    AckResult, AppendBatch, AppendBatchResult, AppendItemResult, AppendOutcome, BusError, Clock,
    CursorRepository, IdGenerator, MessageKey, MessagePage, MessageRepository, ReplicationBatch,
    ReplicationError, ReplicationReceipt, RepositoryError, SnapshotRepository,
    StandbyReplicationPort, WakeupBus, WakeupSubscription,
};
use relay_domain::{
    DeliveryState, DeviceId, EncryptedSnapshot, MessageId, ServerSequence, StoredEnvelope,
};
use tokio::sync::{Mutex, mpsc};

#[derive(Debug, Default)]
struct MemoryState {
    messages: BTreeMap<DeviceId, Vec<StoredEnvelope>>,
    dedup: BTreeMap<(DeviceId, MessageId), ([u8; 32], DeviceId, ServerSequence)>,
    cursors: BTreeMap<DeviceId, ServerSequence>,
    snapshots: BTreeMap<(DeviceId, String), EncryptedSnapshot>,
}

#[derive(Clone, Debug, Default)]
pub struct MemoryRelayStore {
    state: Arc<Mutex<MemoryState>>,
}

#[async_trait]
impl MessageRepository for MemoryRelayStore {
    async fn append_batch(&self, batch: AppendBatch) -> Result<AppendBatchResult, RepositoryError> {
        let mut state = self.state.lock().await;
        let mut results = Vec::with_capacity(batch.items.len());
        for item in batch.items {
            let message_key = MessageKey {
                sender_device_id: item.envelope.sender_device_id.clone(),
                message_id: item.envelope.message_id.clone(),
            };
            let dedup_key = (
                item.envelope.sender_device_id.clone(),
                item.envelope.message_id.clone(),
            );
            if let Some((hash, _, sequence)) = state.dedup.get(&dedup_key) {
                let deliverable = state
                    .messages
                    .get(&item.envelope.recipient_device_id)
                    .and_then(|messages| {
                        messages
                            .iter()
                            .find(|message| message.server_sequence == *sequence)
                    })
                    .is_some_and(|message| message.delivery_state == DeliveryState::Deliverable);
                results.push(AppendItemResult {
                    key: message_key,
                    outcome: if *hash == item.payload_hash {
                        AppendOutcome::Duplicate {
                            server_sequence: *sequence,
                            deliverable,
                        }
                    } else {
                        AppendOutcome::Conflict
                    },
                });
                continue;
            }
            let recipient = item.envelope.recipient_device_id.clone();
            let next = match state
                .messages
                .get(&recipient)
                .and_then(|messages| messages.last())
            {
                Some(message) => message
                    .server_sequence
                    .next()
                    .map_err(|_| RepositoryError::Corrupt)?,
                None => ServerSequence::new(1),
            };
            state
                .dedup
                .insert(dedup_key, (item.payload_hash, recipient.clone(), next));
            state
                .messages
                .entry(recipient)
                .or_default()
                .push(StoredEnvelope {
                    server_sequence: next,
                    envelope: item.envelope.clone(),
                    payload_hash: item.payload_hash,
                    delivery_state: DeliveryState::PendingReplication,
                    home_region: item.home_region,
                    route_epoch: item.route_epoch,
                });
            results.push(AppendItemResult {
                key: message_key,
                outcome: AppendOutcome::Inserted {
                    server_sequence: next,
                },
            });
        }
        Ok(AppendBatchResult { results })
    }

    async fn load_pending(
        &self,
        message_keys: &[MessageKey],
    ) -> Result<Vec<StoredEnvelope>, RepositoryError> {
        let state = self.state.lock().await;
        Ok(state
            .messages
            .values()
            .flatten()
            .filter(|message| {
                message.delivery_state == DeliveryState::PendingReplication
                    && message_keys.iter().any(|key| {
                        key.sender_device_id == message.envelope.sender_device_id
                            && key.message_id == message.envelope.message_id
                    })
            })
            .cloned()
            .collect())
    }

    async fn mark_deliverable(&self, message_keys: &[MessageKey]) -> Result<(), RepositoryError> {
        let mut state = self.state.lock().await;
        for message in state.messages.values_mut().flatten() {
            if message_keys.iter().any(|key| {
                key.sender_device_id == message.envelope.sender_device_id
                    && key.message_id == message.envelope.message_id
            }) {
                message.delivery_state = DeliveryState::Deliverable;
            }
        }
        Ok(())
    }

    async fn read_after(
        &self,
        recipient: &DeviceId,
        after: ServerSequence,
        limit: usize,
    ) -> Result<MessagePage, RepositoryError> {
        let state = self.state.lock().await;
        let messages = state
            .messages
            .get(recipient)
            .into_iter()
            .flatten()
            .filter(|message| {
                message.delivery_state == DeliveryState::Deliverable
                    && message.server_sequence > after
            })
            .take(limit)
            .cloned()
            .collect();
        Ok(MessagePage {
            messages,
            retention_gap: false,
            earliest_available: None,
        })
    }

    async fn highest_issued(
        &self,
        recipient: &DeviceId,
    ) -> Result<ServerSequence, RepositoryError> {
        let state = self.state.lock().await;
        Ok(state
            .messages
            .get(recipient)
            .and_then(|messages| messages.last())
            .map_or(ServerSequence::ZERO, |message| message.server_sequence))
    }
}

#[async_trait]
impl CursorRepository for MemoryRelayStore {
    async fn acknowledge(
        &self,
        recipient: &DeviceId,
        sequence: ServerSequence,
    ) -> Result<AckResult, RepositoryError> {
        let mut state = self.state.lock().await;
        let current = state
            .cursors
            .entry(recipient.clone())
            .or_insert(ServerSequence::ZERO);
        if sequence < *current {
            return Err(RepositoryError::Conflict);
        }
        *current = sequence;
        Ok(AckResult { accepted: sequence })
    }

    async fn current(&self, recipient: &DeviceId) -> Result<ServerSequence, RepositoryError> {
        Ok(self
            .state
            .lock()
            .await
            .cursors
            .get(recipient)
            .copied()
            .unwrap_or(ServerSequence::ZERO))
    }
}

#[async_trait]
impl SnapshotRepository for MemoryRelayStore {
    async fn put(&self, snapshot: EncryptedSnapshot) -> Result<(), RepositoryError> {
        let key = (
            snapshot.recipient_device_id.clone(),
            snapshot.snapshot_id.as_str().to_owned(),
        );
        self.state.lock().await.snapshots.insert(key, snapshot);
        Ok(())
    }

    async fn get(
        &self,
        recipient: &DeviceId,
        snapshot_id: Option<&str>,
    ) -> Result<Option<EncryptedSnapshot>, RepositoryError> {
        let state = self.state.lock().await;
        if let Some(snapshot_id) = snapshot_id {
            return Ok(state
                .snapshots
                .get(&(recipient.clone(), snapshot_id.to_owned()))
                .cloned());
        }
        Ok(state
            .snapshots
            .iter()
            .filter(|((device, _), _)| device == recipient)
            .map(|(_, snapshot)| snapshot)
            .max_by_key(|snapshot| snapshot.created_at_ms)
            .cloned())
    }
}

#[derive(Clone, Debug, Default)]
pub struct MemoryWakeupBus {
    signals: Arc<Mutex<BTreeMap<DeviceId, Vec<mpsc::Sender<()>>>>>,
}

impl MemoryWakeupBus {
    pub async fn recipient_count(&self) -> usize {
        self.signals.lock().await.len()
    }
}

#[async_trait]
impl WakeupBus for MemoryWakeupBus {
    async fn notify_recipient(&self, recipient: &DeviceId) -> Result<(), BusError> {
        if let Some(subscribers) = self.signals.lock().await.get_mut(recipient) {
            subscribers.retain(|sender| !sender.is_closed());
            for sender in subscribers {
                let _ = sender.try_send(());
            }
        }
        Ok(())
    }

    async fn subscribe(&self, recipient: &DeviceId) -> Result<WakeupSubscription, BusError> {
        let (sender, receiver) = mpsc::channel(1);
        self.signals
            .lock()
            .await
            .entry(recipient.clone())
            .or_default()
            .push(sender);
        Ok(WakeupSubscription::from_receiver(receiver))
    }
}

#[derive(Clone, Debug, Default)]
pub struct MemoryStandby {
    batches: Arc<Mutex<Vec<ReplicationBatch>>>,
    fail: Arc<Mutex<bool>>,
}

impl MemoryStandby {
    pub async fn set_failure(&self, fail: bool) {
        *self.fail.lock().await = fail;
    }
    pub async fn batch_count(&self) -> usize {
        self.batches.lock().await.len()
    }
}

#[async_trait]
impl StandbyReplicationPort for MemoryStandby {
    async fn replicate_batch(
        &self,
        batch: ReplicationBatch,
    ) -> Result<ReplicationReceipt, ReplicationError> {
        if *self.fail.lock().await {
            return Err(ReplicationError::Unavailable);
        }
        let durable_through = batch
            .envelopes
            .iter()
            .map(|message| message.server_sequence)
            .max()
            .unwrap_or(ServerSequence::ZERO);
        self.batches.lock().await.push(batch);
        Ok(ReplicationReceipt { durable_through })
    }
}

#[derive(Debug)]
pub struct TestClock(AtomicI64);
impl TestClock {
    #[must_use]
    pub const fn new(now_ms: i64) -> Self {
        Self(AtomicI64::new(now_ms))
    }
    pub fn set(&self, now_ms: i64) {
        self.0.store(now_ms, Ordering::SeqCst);
    }
}
impl Clock for TestClock {
    fn now_ms(&self) -> i64 {
        self.0.load(Ordering::SeqCst)
    }
}

#[derive(Debug, Default)]
pub struct SequentialIds(AtomicU64);
impl IdGenerator for SequentialIds {
    fn new_id(&self) -> String {
        format!("test-id-{}", self.0.fetch_add(1, Ordering::SeqCst))
    }
}
