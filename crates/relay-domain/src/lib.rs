#![forbid(unsafe_code)]

use std::{collections::BTreeSet, error::Error, fmt};

macro_rules! string_id {
    ($name:ident) => {
        #[derive(Clone, Debug, Eq, Hash, Ord, PartialEq, PartialOrd)]
        pub struct $name(String);

        impl $name {
            pub fn parse(value: impl Into<String>) -> Result<Self, DomainError> {
                let value = value.into();
                if value.is_empty() || value.len() > 128 || !value.is_ascii() {
                    return Err(DomainError::InvalidIdentifier(stringify!($name)));
                }
                Ok(Self(value))
            }

            #[must_use]
            pub fn as_str(&self) -> &str {
                &self.0
            }
        }
    };
}

string_id!(AccountId);
string_id!(DeviceId);
string_id!(RouteId);
string_id!(MessageId);
string_id!(SnapshotId);
string_id!(TicketId);
string_id!(ConnectionGeneration);
string_id!(RegionId);
string_id!(KeyId);

#[derive(Clone, Copy, Debug, Default, Eq, Ord, PartialEq, PartialOrd)]
pub struct ServerSequence(u64);

impl ServerSequence {
    pub const ZERO: Self = Self(0);

    #[must_use]
    pub const fn new(value: u64) -> Self {
        Self(value)
    }

    #[must_use]
    pub const fn get(self) -> u64 {
        self.0
    }

    pub fn next(self) -> Result<Self, DomainError> {
        self.0
            .checked_add(1)
            .map(Self)
            .ok_or(DomainError::SequenceExhausted)
    }
}

#[derive(Clone, Copy, Debug, Eq, Ord, PartialEq, PartialOrd)]
pub struct ClientSequence(u64);

impl ClientSequence {
    #[must_use]
    pub const fn new(value: u64) -> Self {
        Self(value)
    }

    #[must_use]
    pub const fn get(self) -> u64 {
        self.0
    }
}

#[derive(Clone, Copy, Debug, Eq, Ord, PartialEq, PartialOrd)]
pub struct RouteEpoch(u64);

impl RouteEpoch {
    #[must_use]
    pub const fn new(value: u64) -> Self {
        Self(value)
    }

    #[must_use]
    pub const fn get(self) -> u64 {
        self.0
    }

    pub fn advance(self) -> Result<Self, DomainError> {
        self.0
            .checked_add(1)
            .map(Self)
            .ok_or(DomainError::SequenceExhausted)
    }
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum DeviceKind {
    Host,
    Mobile,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum Entitlement {
    RelayPro,
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct RelayPrincipal {
    pub account_id: AccountId,
    pub device_id: DeviceId,
    pub device_kind: DeviceKind,
    pub route_grants: BTreeSet<RouteId>,
    pub entitlement: Entitlement,
    pub credential_generation: u64,
    pub home_region: RegionId,
    pub route_epoch: RouteEpoch,
    pub expires_at_ms: i64,
}

#[derive(Clone, Copy, Debug, Default, Eq, PartialEq)]
pub enum Priority {
    #[default]
    Normal,
    High,
}

#[derive(Clone, Copy, Debug, Default, Eq, PartialEq)]
pub enum NotificationHint {
    #[default]
    None,
    Wake,
    AttentionRequired,
    RunFinished,
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct EnvelopeDraft {
    pub message_id: MessageId,
    pub route_id: RouteId,
    pub sender_device_id: DeviceId,
    pub recipient_device_id: DeviceId,
    pub client_sequence: ClientSequence,
    pub created_at_ms: i64,
    pub expires_at_ms: i64,
    pub key_id: KeyId,
    pub nonce: Vec<u8>,
    pub ciphertext: Vec<u8>,
    pub priority: Priority,
    pub notification_hint: NotificationHint,
}

impl EnvelopeDraft {
    #[must_use]
    pub fn ciphertext_size(&self) -> usize {
        self.ciphertext.len()
    }
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub struct EnvelopeLimits {
    pub max_envelopes: usize,
    pub max_envelope_bytes: usize,
    pub max_batch_bytes: usize,
    pub min_ttl_ms: i64,
    pub max_ttl_ms: i64,
}

impl Default for EnvelopeLimits {
    fn default() -> Self {
        Self {
            max_envelopes: 64,
            max_envelope_bytes: 256 * 1024,
            max_batch_bytes: 2 * 1024 * 1024,
            min_ttl_ms: 5 * 60 * 1000,
            max_ttl_ms: 7 * 24 * 60 * 60 * 1000,
        }
    }
}

#[derive(Clone, Debug)]
pub struct EnvelopeLimitPolicy {
    limits: EnvelopeLimits,
}

impl EnvelopeLimitPolicy {
    #[must_use]
    pub const fn new(limits: EnvelopeLimits) -> Self {
        Self { limits }
    }

    pub fn validate_batch(
        &self,
        envelopes: &[EnvelopeDraft],
        now_ms: i64,
    ) -> Result<(), DomainError> {
        if envelopes.is_empty() || envelopes.len() > self.limits.max_envelopes {
            return Err(DomainError::BatchSize);
        }
        let mut total = 0usize;
        for envelope in envelopes {
            if envelope.sender_device_id == envelope.recipient_device_id {
                return Err(DomainError::InvalidRoute);
            }
            if envelope.nonce.len() != 24 {
                return Err(DomainError::InvalidNonce);
            }
            let size = envelope.ciphertext_size();
            if size == 0 || size > self.limits.max_envelope_bytes {
                return Err(DomainError::EnvelopeSize);
            }
            total = total.checked_add(size).ok_or(DomainError::BatchSize)?;
            if total > self.limits.max_batch_bytes {
                return Err(DomainError::BatchSize);
            }
            let ttl = envelope
                .expires_at_ms
                .checked_sub(envelope.created_at_ms)
                .ok_or(DomainError::InvalidExpiry)?;
            if envelope.created_at_ms > now_ms + 60_000
                || envelope.expires_at_ms <= now_ms
                || ttl < self.limits.min_ttl_ms
                || ttl > self.limits.max_ttl_ms
            {
                return Err(DomainError::InvalidExpiry);
            }
        }
        Ok(())
    }
}

#[derive(Clone, Debug, Default)]
pub struct RoutingPolicy;

impl RoutingPolicy {
    pub fn validate(
        principal: &RelayPrincipal,
        envelope: &EnvelopeDraft,
        region: &RegionId,
        epoch: RouteEpoch,
    ) -> Result<(), DomainError> {
        if principal.device_id != envelope.sender_device_id {
            return Err(DomainError::SenderMismatch);
        }
        if !principal.route_grants.contains(&envelope.route_id) {
            return Err(DomainError::RouteNotGranted);
        }
        if &principal.home_region != region {
            return Err(DomainError::WrongRegion);
        }
        if principal.route_epoch != epoch {
            return Err(DomainError::StaleRouteEpoch);
        }
        Ok(())
    }
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum DeliveryState {
    PendingReplication,
    Deliverable,
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct StoredEnvelope {
    pub server_sequence: ServerSequence,
    pub envelope: EnvelopeDraft,
    pub payload_hash: [u8; 32],
    pub delivery_state: DeliveryState,
    pub home_region: RegionId,
    pub route_epoch: RouteEpoch,
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct EncryptedSnapshot {
    pub snapshot_id: SnapshotId,
    pub recipient_device_id: DeviceId,
    pub route_id: RouteId,
    pub covers_through_sequence: ServerSequence,
    pub created_at_ms: i64,
    pub expires_at_ms: i64,
    pub key_id: KeyId,
    pub nonce: Vec<u8>,
    pub ciphertext: Vec<u8>,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum DomainError {
    InvalidIdentifier(&'static str),
    SequenceExhausted,
    BatchSize,
    EnvelopeSize,
    InvalidNonce,
    InvalidExpiry,
    InvalidRoute,
    SenderMismatch,
    RouteNotGranted,
    WrongRegion,
    StaleRouteEpoch,
    AckRegression,
    AckBeyondIssued,
    IdempotencyConflict,
    EntitlementRequired,
}

impl fmt::Display for DomainError {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        write!(formatter, "{self:?}")
    }
}

impl Error for DomainError {}
