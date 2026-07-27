use std::error::Error;

use chacha20poly1305::{
    KeyInit, XChaCha20Poly1305, XNonce,
    aead::{Aead, Payload},
};
use hkdf::Hkdf;
use serde::Deserialize;
use sha2::{Digest, Sha256};
use x25519_dalek::{PublicKey, StaticSecret};

#[derive(Debug, Deserialize)]
struct Vector {
    protocol_version: u32,
    service_identifier: String,
    pairing_id: String,
    route_id: String,
    sender_device_id: String,
    recipient_device_id: String,
    message_id: String,
    key_id: String,
    client_sequence: u64,
    created_at_ms: i64,
    expires_at_ms: i64,
    pairing_expires_at_ms: i64,
    priority: u32,
    notification_hint: u32,
    host_secret_key: String,
    host_public_key: String,
    mobile_public_key: String,
    challenge: String,
    transcript_hash: String,
    pairwise_key: String,
    aad: String,
    nonce: String,
    plaintext: String,
    ciphertext: String,
}

fn tuple(parts: &[&[u8]]) -> Result<Vec<u8>, Box<dyn Error>> {
    let mut encoded = Vec::new();
    for part in parts {
        let length = u32::try_from(part.len()).map_err(|_| "vector tuple field is too large")?;
        encoded.extend_from_slice(&length.to_be_bytes());
        encoded.extend_from_slice(part);
    }
    Ok(encoded)
}

fn fixed<const N: usize>(hex_value: &str) -> Result<[u8; N], Box<dyn Error>> {
    Ok(hex::decode(hex_value)?
        .try_into()
        .map_err(|_| "invalid vector length")?)
}

#[test]
fn rust_reproduces_typescript_e2ee_v1_vector() -> Result<(), Box<dyn Error>> {
    let vector: Vector = serde_json::from_str(include_str!(
        "../../../packages/crypto/vectors/e2ee-v1.json"
    ))?;
    let host_secret = StaticSecret::from(fixed::<32>(&vector.host_secret_key)?);
    let host_public = PublicKey::from(&host_secret);
    assert_eq!(
        host_public.as_bytes(),
        &fixed::<32>(&vector.host_public_key)?
    );
    let mobile_public = PublicKey::from(fixed::<32>(&vector.mobile_public_key)?);

    let version = vector.protocol_version.to_be_bytes();
    let pairing_expiry = vector.pairing_expires_at_ms.to_be_bytes();
    let challenge = hex::decode(&vector.challenge)?;
    let transcript = tuple(&[
        b"pocket-omp/pairing-transcript/v1",
        &version,
        vector.service_identifier.as_bytes(),
        vector.pairing_id.as_bytes(),
        &challenge,
        host_public.as_bytes(),
        mobile_public.as_bytes(),
        &pairing_expiry,
    ])?;
    let transcript_hash = Sha256::digest(transcript);
    assert_eq!(
        transcript_hash.as_slice(),
        &hex::decode(&vector.transcript_hash)?
    );

    let shared = host_secret.diffie_hellman(&mobile_public);
    let mut devices = [
        vector.sender_device_id.as_str(),
        vector.recipient_device_id.as_str(),
    ];
    devices.sort_unstable();
    let info = tuple(&[
        b"pocket-omp/e2ee/v1",
        vector.route_id.as_bytes(),
        devices[0].as_bytes(),
        devices[1].as_bytes(),
    ])?;
    let hkdf = Hkdf::<Sha256>::new(Some(transcript_hash.as_slice()), shared.as_bytes());
    let mut pairwise_key = [0_u8; 32];
    hkdf.expand(&info, &mut pairwise_key)
        .map_err(|_| "invalid HKDF output length")?;
    assert_eq!(pairwise_key, fixed::<32>(&vector.pairwise_key)?);

    let client_sequence = vector.client_sequence.to_be_bytes();
    let created_at = vector.created_at_ms.to_be_bytes();
    let expires_at = vector.expires_at_ms.to_be_bytes();
    let priority = vector.priority.to_be_bytes();
    let notification_hint = vector.notification_hint.to_be_bytes();
    let aad = tuple(&[
        &version,
        vector.message_id.as_bytes(),
        vector.route_id.as_bytes(),
        vector.sender_device_id.as_bytes(),
        vector.recipient_device_id.as_bytes(),
        &client_sequence,
        &created_at,
        &expires_at,
        vector.key_id.as_bytes(),
        &priority,
        &notification_hint,
    ])?;
    assert_eq!(aad, hex::decode(&vector.aad)?);

    let cipher = XChaCha20Poly1305::new((&pairwise_key).into());
    let nonce = fixed::<24>(&vector.nonce)?;
    let plaintext = cipher
        .decrypt(
            XNonce::from_slice(&nonce),
            Payload {
                msg: &hex::decode(&vector.ciphertext)?,
                aad: &aad,
            },
        )
        .map_err(|_| "vector authentication failed")?;
    assert_eq!(plaintext, hex::decode(&vector.plaintext)?);
    Ok(())
}
