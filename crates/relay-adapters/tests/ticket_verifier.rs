use std::{
    collections::BTreeMap,
    sync::{
        Arc,
        atomic::{AtomicBool, Ordering},
    },
    time::{SystemTime, UNIX_EPOCH},
};

use async_trait::async_trait;
use ed25519_dalek::{
    SigningKey,
    pkcs8::{EncodePrivateKey, EncodePublicKey, spki::der::pem::LineEnding},
};
use jsonwebtoken::{Algorithm, EncodingKey, Header, encode};
use relay_adapters::{Ed25519TicketVerifier, TicketStatusPort};
use relay_application::{TicketError, TicketVerifier};
use relay_domain::{DeviceId, RouteId};
use serde::Serialize;

#[derive(Serialize)]
struct Claims {
    iss: &'static str,
    aud: &'static str,
    sub: &'static str,
    exp: u64,
    iat: u64,
    jti: &'static str,
    account_id: &'static str,
    device_id: &'static str,
    device_kind: &'static str,
    route_grants: [&'static str; 1],
    entitlement: &'static str,
    credential_generation: u64,
    home_region: &'static str,
    relay_origin: &'static str,
    route_epoch: u64,
}

#[derive(Debug, Default)]
struct TestTicketStatus(AtomicBool);

#[async_trait]
impl TicketStatusPort for TestTicketStatus {
    async fn is_valid(
        &self,
        _ticket_id: &str,
        device_id: &DeviceId,
        credential_generation: u64,
        route_grants: &[RouteId],
        route_epoch: u64,
    ) -> Result<bool, TicketError> {
        Ok(!self.0.load(Ordering::SeqCst)
            && device_id.as_str() == "device-1"
            && credential_generation == 3
            && route_grants == [RouteId::parse("route-1").map_err(|_| TicketError::Invalid)?]
            && route_epoch == 7)
    }
}

#[tokio::test]
async fn ed25519_ticket_verification_rejects_revocation_and_tampering()
-> Result<(), Box<dyn std::error::Error>> {
    let signing_key = SigningKey::from_bytes(&[7; 32]);
    let private_pem = signing_key.to_pkcs8_pem(LineEnding::LF)?;
    let public_pem = signing_key
        .verifying_key()
        .to_public_key_pem(LineEnding::LF)?;
    let status = Arc::new(TestTicketStatus::default());
    let verifier = Ed25519TicketVerifier::new(
        BTreeMap::from([("key-1".to_owned(), public_pem)]),
        "https://control.example.test",
        status.clone(),
    )?;
    let now = SystemTime::now().duration_since(UNIX_EPOCH)?.as_secs();
    let claims = Claims {
        iss: "https://control.example.test",
        aud: "pocket-omp-relay",
        sub: "device-1",
        exp: now + 600,
        iat: now,
        jti: "ticket-1",
        account_id: "account-1",
        device_id: "device-1",
        device_kind: "HOST",
        route_grants: ["route-1"],
        entitlement: "relay_pro",
        credential_generation: 3,
        home_region: "home-1",
        relay_origin: "https://home-1.relay.example.test",
        route_epoch: 7,
    };
    let mut header = Header::new(Algorithm::EdDSA);
    header.kid = Some("key-1".to_owned());
    let ticket = encode(
        &header,
        &claims,
        &EncodingKey::from_ed_pem(private_pem.as_bytes())?,
    )?;

    let principal = verifier
        .verify(&ticket)
        .await
        .map_err(|_| "valid ticket was rejected")?;
    assert_eq!(principal.device_id.as_str(), "device-1");
    assert_eq!(principal.route_epoch.get(), 7);

    status.0.store(true, Ordering::SeqCst);
    assert_eq!(verifier.verify(&ticket).await, Err(TicketError::Revoked));
    let tampered = format!("{ticket}x");
    assert_eq!(verifier.verify(&tampered).await, Err(TicketError::Invalid));
    Ok(())
}
