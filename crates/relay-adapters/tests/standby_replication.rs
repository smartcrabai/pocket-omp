use relay_adapters::{PostgresRelayStore, PostgresStandbyReplicator, PromotionError};
use relay_application::{
    MessageRepository, ReplicationBatch, ReplicationError, StandbyReplicationPort,
};
use relay_domain::{
    ClientSequence, DeliveryState, DeviceId, EnvelopeDraft, KeyId, MessageId, NotificationHint,
    Priority, RegionId, RouteEpoch, RouteId, ServerSequence, StoredEnvelope,
};
use testcontainers_modules::{postgres, testcontainers::runners::AsyncRunner};

#[tokio::test]
async fn standby_replication_is_durable_idempotent_and_collision_safe()
-> Result<(), Box<dyn std::error::Error>> {
    let container = postgres::Postgres::default().start().await?;
    let host = container.get_host().await?;
    let port = container.get_host_port_ipv4(5432).await?;
    let database_url = format!("postgres://postgres:postgres@{host}:{port}/postgres");
    let store = PostgresRelayStore::connect(&database_url).await?;
    store.migrate().await?;
    let home = RegionId::parse("home-1")?;
    let standby = RegionId::parse("standby-1")?;
    let recipient = DeviceId::parse("recipient-1")?;
    let message = StoredEnvelope {
        server_sequence: ServerSequence::new(7),
        envelope: EnvelopeDraft {
            message_id: MessageId::parse("message-7")?,
            route_id: RouteId::parse("route-1")?,
            sender_device_id: DeviceId::parse("sender-1")?,
            recipient_device_id: recipient.clone(),
            client_sequence: ClientSequence::new(9),
            created_at_ms: 1_800_000_000_000,
            expires_at_ms: 1_800_000_600_000,
            key_id: KeyId::parse("key-1")?,
            nonce: vec![4; 24],
            ciphertext: vec![5; 128],
            priority: Priority::Normal,
            notification_hint: NotificationHint::RunFinished,
        },
        payload_hash: [6; 32],
        delivery_state: DeliveryState::PendingReplication,
        home_region: home.clone(),
        route_epoch: RouteEpoch::new(3),
    };
    let replicator = PostgresStandbyReplicator::new(store.clone(), standby.clone());
    let batch = ReplicationBatch {
        batch_id: "batch-1".to_owned(),
        source_region: home.clone(),
        target_region: standby.clone(),
        route_epoch: RouteEpoch::new(3),
        envelopes: vec![message.clone()],
    };

    let first = replicator
        .replicate_batch(batch.clone())
        .await
        .map_err(|_| "initial replication failed")?;
    let duplicate = replicator
        .replicate_batch(batch.clone())
        .await
        .map_err(|_| "idempotent replication failed")?;
    assert_eq!(first.durable_through, ServerSequence::new(7));
    assert_eq!(duplicate, first);
    let page = store
        .read_after(&recipient, ServerSequence::ZERO, 10)
        .await
        .map_err(|_| "standby read failed")?;
    assert_eq!(page.messages.len(), 1);
    assert_eq!(page.messages[0].server_sequence, message.server_sequence);
    assert_eq!(page.messages[0].payload_hash, message.payload_hash);
    assert_eq!(page.messages[0].delivery_state, DeliveryState::Deliverable);

    let promoted_epoch = store
        .promote_recipient(&recipient, RouteEpoch::new(3), &standby, &home)
        .await
        .map_err(|_| "standby promotion failed")?;
    assert_eq!(promoted_epoch, RouteEpoch::new(4));
    assert_eq!(
        store
            .promote_recipient(&recipient, RouteEpoch::new(3), &standby, &home)
            .await,
        Err(PromotionError::Conflict),
    );

    let mut collision = batch;
    collision.envelopes[0].payload_hash = [8; 32];
    let error = replicator.replicate_batch(collision).await;
    assert_eq!(error, Err(ReplicationError::Rejected));
    Ok(())
}
