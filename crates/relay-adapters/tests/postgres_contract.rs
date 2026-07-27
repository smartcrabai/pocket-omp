use std::{collections::BTreeSet, sync::Arc};

use relay_adapters::PostgresRelayStore;
use relay_application::{
    CursorRepository, MessageRepository, PublishEnvelopesCommand, PublishOutcome, RelayApplication,
    RelayDependencies, SnapshotRepository,
};
use relay_domain::{
    AccountId, ClientSequence, DeviceId, DeviceKind, Entitlement, EnvelopeDraft,
    EnvelopeLimitPolicy, EnvelopeLimits, KeyId, MessageId, NotificationHint, Priority, RegionId,
    RelayPrincipal, RouteEpoch, RouteId, ServerSequence,
};
use relay_testkit::{MemoryStandby, MemoryWakeupBus, SequentialIds, TestClock};
use testcontainers_modules::{postgres, testcontainers::runners::AsyncRunner};

#[tokio::test]
async fn postgres_store_preserves_publish_dedupe_order_and_ack_contract()
-> Result<(), Box<dyn std::error::Error>> {
    let container = postgres::Postgres::default().start().await?;
    let host = container.get_host().await?;
    let port = container.get_host_port_ipv4(5432).await?;
    let database_url = format!("postgres://postgres:postgres@{host}:{port}/postgres");
    let store = PostgresRelayStore::connect(&database_url).await?;
    store.migrate().await?;

    let now_ms = 1_800_000_000_000_i64;
    let wakeups = Arc::new(MemoryWakeupBus::default());
    let standby = Arc::new(MemoryStandby::default());
    let application = RelayApplication::new(
        RelayDependencies {
            messages: Arc::new(store.clone()) as Arc<dyn MessageRepository>,
            cursors: Arc::new(store.clone()) as Arc<dyn CursorRepository>,
            snapshots: Arc::new(store.clone()) as Arc<dyn SnapshotRepository>,
            wakeups,
            standby: standby.clone(),
            clock: Arc::new(TestClock::new(now_ms)),
            ids: Arc::new(SequentialIds::default()),
        },
        EnvelopeLimitPolicy::new(EnvelopeLimits::default()),
    );

    let sender = DeviceId::parse("sender-1")?;
    let recipient = DeviceId::parse("recipient-1")?;
    let route = RouteId::parse("route-1")?;
    let home = RegionId::parse("home-1")?;
    let standby_region = RegionId::parse("standby-1")?;
    let principal = RelayPrincipal {
        account_id: AccountId::parse("account-1")?,
        device_id: sender.clone(),
        device_kind: DeviceKind::Host,
        route_grants: BTreeSet::from([route.clone()]),
        entitlement: Entitlement::RelayPro,
        credential_generation: 1,
        home_region: home.clone(),
        route_epoch: RouteEpoch::new(1),
        expires_at_ms: now_ms + 600_000,
    };
    let envelope = EnvelopeDraft {
        message_id: MessageId::parse("message-1")?,
        route_id: route,
        sender_device_id: sender,
        recipient_device_id: recipient.clone(),
        client_sequence: ClientSequence::new(1),
        created_at_ms: now_ms,
        expires_at_ms: now_ms + 600_000,
        key_id: KeyId::parse("key-1")?,
        nonce: vec![7; 24],
        ciphertext: vec![9; 64],
        priority: Priority::High,
        notification_hint: NotificationHint::Wake,
    };

    let first = application
        .publish(PublishEnvelopesCommand {
            principal: principal.clone(),
            envelopes: vec![envelope.clone()],
            piggyback_ack: None,
            target_region: home.clone(),
            standby_region: standby_region.clone(),
            route_epoch: RouteEpoch::new(1),
        })
        .await?;
    assert_eq!(first.results.len(), 1);
    assert!(
        matches!(first.results[0].outcome, PublishOutcome::Accepted { server_sequence, duplicate: false } if server_sequence == ServerSequence::new(1))
    );
    assert_eq!(standby.batch_count().await, 1);

    let duplicate = application
        .publish(PublishEnvelopesCommand {
            principal,
            envelopes: vec![envelope],
            piggyback_ack: None,
            target_region: home,
            standby_region,
            route_epoch: RouteEpoch::new(1),
        })
        .await?;
    assert!(
        matches!(duplicate.results[0].outcome, PublishOutcome::Accepted { server_sequence, duplicate: true } if server_sequence == ServerSequence::new(1))
    );
    assert_eq!(standby.batch_count().await, 1);

    let page = application
        .read_after(&recipient, ServerSequence::ZERO, 128)
        .await?;
    assert_eq!(page.messages.len(), 1);
    assert_eq!(page.messages[0].server_sequence, ServerSequence::new(1));
    let acknowledged = application
        .acknowledge(&recipient, ServerSequence::new(1))
        .await?;
    assert_eq!(acknowledged.accepted, ServerSequence::new(1));
    Ok(())
}
