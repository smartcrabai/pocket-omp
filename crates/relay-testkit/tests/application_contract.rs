use std::{collections::BTreeSet, sync::Arc, time::Duration};

use relay_application::{
    ApplicationError, CursorRepository, MessageRepository, PublishEnvelopesCommand, PublishOutcome,
    RelayApplication, RelayDependencies, SnapshotRepository, SubscriptionItem, SubscriptionOptions,
};
use relay_domain::{
    AccountId, ClientSequence, DeviceId, DeviceKind, EncryptedSnapshot, Entitlement, EnvelopeDraft,
    EnvelopeLimitPolicy, EnvelopeLimits, KeyId, MessageId, NotificationHint, Priority, RegionId,
    RelayPrincipal, RouteEpoch, RouteId, ServerSequence, SnapshotId,
};
use relay_testkit::{MemoryRelayStore, MemoryStandby, MemoryWakeupBus, SequentialIds, TestClock};

struct Fixture {
    application: RelayApplication,
    principal: RelayPrincipal,
    envelope: EnvelopeDraft,
    recipient: DeviceId,
    home: RegionId,
    standby_region: RegionId,
    standby: Arc<MemoryStandby>,
    wakeups: Arc<MemoryWakeupBus>,
}

fn fixture() -> Result<Fixture, Box<dyn std::error::Error>> {
    let now_ms = 1_800_000_000_000;
    let store = Arc::new(MemoryRelayStore::default());
    let standby = Arc::new(MemoryStandby::default());
    let wakeups = Arc::new(MemoryWakeupBus::default());
    let application = RelayApplication::new(
        RelayDependencies {
            messages: store.clone() as Arc<dyn MessageRepository>,
            cursors: store.clone() as Arc<dyn CursorRepository>,
            snapshots: store as Arc<dyn SnapshotRepository>,
            wakeups: wakeups.clone(),
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
    Ok(Fixture {
        application,
        principal: RelayPrincipal {
            account_id: AccountId::parse("account-1")?,
            device_id: sender.clone(),
            device_kind: DeviceKind::Host,
            route_grants: BTreeSet::from([route.clone()]),
            entitlement: Entitlement::RelayPro,
            credential_generation: 1,
            home_region: home.clone(),
            route_epoch: RouteEpoch::new(4),
            expires_at_ms: now_ms + 900_000,
        },
        envelope: EnvelopeDraft {
            message_id: MessageId::parse("message-1")?,
            route_id: route,
            sender_device_id: sender,
            recipient_device_id: recipient.clone(),
            client_sequence: ClientSequence::new(1),
            created_at_ms: now_ms,
            expires_at_ms: now_ms + 600_000,
            key_id: KeyId::parse("key-1")?,
            nonce: vec![1; 24],
            ciphertext: vec![2; 64],
            priority: Priority::Normal,
            notification_hint: NotificationHint::Wake,
        },
        recipient,
        home,
        standby_region,
        standby,
        wakeups,
    })
}

fn publish_command(fixture: &Fixture, envelope: EnvelopeDraft) -> PublishEnvelopesCommand {
    PublishEnvelopesCommand {
        principal: fixture.principal.clone(),
        envelopes: vec![envelope],
        piggyback_ack: None,
        target_region: fixture.home.clone(),
        standby_region: fixture.standby_region.clone(),
        route_epoch: RouteEpoch::new(4),
    }
}

#[tokio::test]
async fn publish_requires_standby_durability_before_delivery_and_deduplicates()
-> Result<(), Box<dyn std::error::Error>> {
    let fixture = fixture()?;
    fixture.standby.set_failure(true).await;
    let failed = fixture
        .application
        .publish(publish_command(&fixture, fixture.envelope.clone()))
        .await;
    assert!(matches!(failed, Err(ApplicationError::Replication(_))));
    assert!(
        fixture
            .application
            .read_after(&fixture.recipient, ServerSequence::ZERO, 128)
            .await?
            .messages
            .is_empty()
    );

    fixture.standby.set_failure(false).await;
    let retried = fixture
        .application
        .publish(publish_command(&fixture, fixture.envelope.clone()))
        .await?;
    assert!(
        matches!(retried.results[0].outcome, PublishOutcome::Accepted { server_sequence, duplicate: true } if server_sequence == ServerSequence::new(1))
    );
    assert_eq!(fixture.standby.batch_count().await, 1);
    assert_eq!(
        fixture
            .application
            .read_after(&fixture.recipient, ServerSequence::ZERO, 128)
            .await?
            .messages
            .len(),
        1
    );

    let duplicate = fixture
        .application
        .publish(publish_command(&fixture, fixture.envelope.clone()))
        .await?;
    assert!(matches!(
        duplicate.results[0].outcome,
        PublishOutcome::Accepted {
            duplicate: true,
            ..
        }
    ));
    assert_eq!(fixture.standby.batch_count().await, 1);

    let mut collision = fixture.envelope.clone();
    collision.ciphertext[0] ^= 0xff;
    let collision_result = fixture
        .application
        .publish(publish_command(&fixture, collision))
        .await?;
    assert_eq!(
        collision_result.results[0].outcome,
        PublishOutcome::Rejected {
            code: "IDEMPOTENCY_CONFLICT"
        }
    );
    Ok(())
}

#[tokio::test]
async fn subscription_enforces_ack_window_and_disconnects_slow_consumers()
-> Result<(), Box<dyn std::error::Error>> {
    let fixture = fixture()?;
    for sequence in 1..=3 {
        let mut envelope = fixture.envelope.clone();
        envelope.message_id = MessageId::parse(format!("message-{sequence}"))?;
        envelope.client_sequence = ClientSequence::new(sequence);
        fixture
            .application
            .publish(publish_command(&fixture, envelope))
            .await?;
    }

    let options = SubscriptionOptions {
        max_in_flight: 1,
        idle_poll_interval: Duration::from_millis(10),
        send_timeout: Duration::from_millis(50),
    };
    let mut subscription = fixture
        .application
        .subscribe(fixture.recipient.clone(), ServerSequence::ZERO, options)
        .await?;
    assert_eq!(fixture.wakeups.recipient_count().await, 1);
    let first = subscription.recv().await.ok_or("subscription closed")??;
    assert!(
        matches!(first, SubscriptionItem::Envelope(message) if message.server_sequence == ServerSequence::new(1))
    );
    assert!(
        tokio::time::timeout(Duration::from_millis(30), subscription.recv())
            .await
            .is_err()
    );
    fixture
        .application
        .acknowledge(&fixture.recipient, ServerSequence::new(1))
        .await?;
    let second = tokio::time::timeout(Duration::from_secs(1), subscription.recv())
        .await?
        .ok_or("subscription closed after acknowledgement")??;
    assert!(
        matches!(second, SubscriptionItem::Envelope(message) if message.server_sequence == ServerSequence::new(2))
    );

    let slow_options = SubscriptionOptions {
        max_in_flight: 2,
        idle_poll_interval: Duration::from_millis(10),
        send_timeout: Duration::from_millis(20),
    };
    let mut slow = fixture
        .application
        .subscribe(
            fixture.recipient.clone(),
            ServerSequence::ZERO,
            slow_options,
        )
        .await?;
    tokio::time::sleep(Duration::from_millis(50)).await;
    assert!(matches!(
        slow.recv().await,
        Some(Ok(SubscriptionItem::Envelope(_)))
    ));
    assert!(slow.recv().await.is_none());
    Ok(())
}

#[tokio::test]
async fn acknowledgements_are_monotonic_and_bounded_by_issued_sequence()
-> Result<(), Box<dyn std::error::Error>> {
    let fixture = fixture()?;
    fixture
        .application
        .publish(publish_command(&fixture, fixture.envelope.clone()))
        .await?;
    assert_eq!(
        fixture
            .application
            .acknowledge(&fixture.recipient, ServerSequence::new(1))
            .await?
            .accepted,
        ServerSequence::new(1)
    );
    assert!(matches!(
        fixture
            .application
            .acknowledge(&fixture.recipient, ServerSequence::ZERO)
            .await,
        Err(ApplicationError::AckRegression)
    ));
    assert!(matches!(
        fixture
            .application
            .acknowledge(&fixture.recipient, ServerSequence::new(2))
            .await,
        Err(ApplicationError::AckBeyondIssued)
    ));
    Ok(())
}

#[tokio::test]
async fn snapshot_validation_and_latest_lookup_preserve_encrypted_payloads()
-> Result<(), Box<dyn std::error::Error>> {
    let fixture = fixture()?;
    let snapshot = EncryptedSnapshot {
        snapshot_id: SnapshotId::parse("snapshot-1")?,
        route_id: fixture.envelope.route_id.clone(),
        recipient_device_id: fixture.recipient.clone(),
        covers_through_sequence: ServerSequence::new(12),
        created_at_ms: fixture.envelope.created_at_ms,
        expires_at_ms: fixture.envelope.expires_at_ms,
        key_id: fixture.envelope.key_id.clone(),
        nonce: vec![3; 24],
        ciphertext: vec![4; 256],
    };
    fixture.application.put_snapshot(snapshot.clone()).await?;
    assert_eq!(
        fixture
            .application
            .get_snapshot(&fixture.recipient, None)
            .await?,
        Some(snapshot.clone())
    );
    assert_eq!(
        fixture
            .application
            .get_snapshot(&fixture.recipient, Some("snapshot-1"))
            .await?,
        Some(snapshot)
    );

    let mut invalid = fixture
        .application
        .get_snapshot(&fixture.recipient, None)
        .await?
        .ok_or("snapshot missing")?;
    invalid.nonce.pop();
    assert!(matches!(
        fixture.application.put_snapshot(invalid).await,
        Err(ApplicationError::InvalidSnapshot)
    ));
    assert!(matches!(
        fixture
            .application
            .read_after(&fixture.recipient, ServerSequence::ZERO, 0)
            .await,
        Err(ApplicationError::InvalidReadLimit)
    ));
    assert!(matches!(
        fixture
            .application
            .read_after(&fixture.recipient, ServerSequence::ZERO, 129)
            .await,
        Err(ApplicationError::InvalidReadLimit)
    ));
    Ok(())
}
