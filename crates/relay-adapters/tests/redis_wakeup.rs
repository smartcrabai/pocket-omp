use redis::AsyncCommands;
use relay_adapters::{RedisTicketStatus, RedisWakeupBus, TicketStatusPort};
use relay_application::WakeupBus;
use relay_domain::DeviceId;
use testcontainers_modules::{
    redis::{REDIS_PORT, Redis},
    testcontainers::runners::AsyncRunner,
};
use tokio_stream::StreamExt;

#[tokio::test]
async fn redis_wakeup_publishes_only_to_the_recipient_channel()
-> Result<(), Box<dyn std::error::Error>> {
    let container = Redis::default().start().await?;
    let host = container.get_host().await?;
    let port = container.get_host_port_ipv4(REDIS_PORT).await?;
    let redis_url = format!("redis://{host}:{port}");
    let client = redis::Client::open(redis_url.as_str())?;
    let mut subscription = client.get_async_pubsub().await?;
    subscription.subscribe("relay:wakeup:device-1").await?;
    let mut messages = subscription.into_on_message();
    let bus = RedisWakeupBus::connect(&redis_url).await?;

    bus.notify_recipient(&DeviceId::parse("device-1")?)
        .await
        .map_err(|_| "Wakeup publish failed")?;

    let message = tokio::time::timeout(std::time::Duration::from_secs(2), messages.next())
        .await?
        .ok_or("Redis subscription ended")?;
    assert_eq!(message.get_channel_name(), "relay:wakeup:device-1");
    assert_eq!(message.get_payload::<String>()?, "device-1");

    let recipient = DeviceId::parse("device-2")?;
    let mut wakeups = bus
        .subscribe(&recipient)
        .await
        .map_err(|_| "Wakeup subscription failed")?;
    bus.notify_recipient(&recipient)
        .await
        .map_err(|_| "Wakeup publish failed")?;
    assert_eq!(
        tokio::time::timeout(std::time::Duration::from_secs(2), wakeups.recv()).await?,
        Some(())
    );

    let status = RedisTicketStatus::connect(&redis_url).await?;
    let mut connection = client.get_multiplexed_async_connection().await?;
    let _: () = connection
        .set("relay:credential_generation:device-2", 4_u64)
        .await?;
    let _: () = connection.set("relay:route_epoch:route-2", 9_u64).await?;
    let route = relay_domain::RouteId::parse("route-2")?;
    assert!(
        status
            .is_valid("ticket-2", &recipient, 4, std::slice::from_ref(&route), 9)
            .await
            .map_err(|_| "Ticket status lookup failed")?
    );
    let _: usize = connection.sadd("relay:revoked_tickets", "ticket-2").await?;
    assert!(
        !status
            .is_valid("ticket-2", &recipient, 4, &[route], 9)
            .await
            .map_err(|_| "Ticket status lookup failed")?
    );
    Ok(())
}
