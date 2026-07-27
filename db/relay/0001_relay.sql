CREATE SCHEMA IF NOT EXISTS relay;

CREATE TABLE relay.recipient_state (
  recipient_device_id text PRIMARY KEY,
  home_region text NOT NULL,
  standby_region text NOT NULL,
  route_epoch bigint NOT NULL CHECK (route_epoch >= 0),
  next_sequence bigint NOT NULL DEFAULT 1 CHECK (next_sequence > 0),
  acked_sequence bigint NOT NULL DEFAULT 0 CHECK (acked_sequence >= 0),
  lease_generation text,
  lease_expires_at timestamptz,
  updated_at timestamptz NOT NULL DEFAULT now(),
  CHECK (acked_sequence < next_sequence)
);

CREATE TABLE relay.message (
  expires_at timestamptz NOT NULL,
  recipient_device_id text NOT NULL,
  server_sequence bigint NOT NULL CHECK (server_sequence > 0),
  sender_device_id text NOT NULL,
  message_id text NOT NULL,
  route_id text NOT NULL,
  client_sequence numeric(20, 0) NOT NULL CHECK (client_sequence >= 0),
  created_at timestamptz NOT NULL,
  key_id text NOT NULL,
  nonce bytea NOT NULL CHECK (octet_length(nonce) = 24),
  ciphertext bytea NOT NULL,
  ciphertext_size integer NOT NULL CHECK (ciphertext_size = octet_length(ciphertext) AND ciphertext_size BETWEEN 1 AND 262144),
  priority smallint NOT NULL,
  notification_hint smallint NOT NULL,
  delivery_state smallint NOT NULL CHECK (delivery_state IN (0, 1)),
  home_region text NOT NULL,
  route_epoch bigint NOT NULL CHECK (route_epoch >= 0),
  PRIMARY KEY (expires_at, recipient_device_id, server_sequence)
) PARTITION BY RANGE (expires_at);

CREATE TABLE relay.message_default PARTITION OF relay.message DEFAULT;
CREATE INDEX relay_message_recipient_delivery_sequence_idx ON relay.message (recipient_device_id, delivery_state, server_sequence);
CREATE INDEX relay_message_route_created_idx ON relay.message (route_id, created_at);
CREATE INDEX relay_message_expires_idx ON relay.message (expires_at);

CREATE TABLE relay.message_dedup (
  sender_device_id text NOT NULL,
  message_id text NOT NULL,
  payload_hash bytea NOT NULL CHECK (octet_length(payload_hash) = 32),
  recipient_device_id text NOT NULL,
  server_sequence bigint NOT NULL CHECK (server_sequence > 0),
  expires_at timestamptz NOT NULL,
  replication_status smallint NOT NULL CHECK (replication_status IN (0, 1)),
  PRIMARY KEY (sender_device_id, message_id)
);

CREATE TABLE relay.snapshot (
  recipient_device_id text NOT NULL,
  snapshot_id text NOT NULL,
  route_id text NOT NULL,
  created_at timestamptz NOT NULL,
  expires_at timestamptz NOT NULL,
  covers_through_sequence bigint NOT NULL CHECK (covers_through_sequence >= 0),
  key_id text NOT NULL,
  nonce bytea NOT NULL CHECK (octet_length(nonce) = 24),
  ciphertext bytea NOT NULL,
  ciphertext_size integer NOT NULL CHECK (ciphertext_size = octet_length(ciphertext) AND ciphertext_size BETWEEN 1 AND 33554432),
  PRIMARY KEY (recipient_device_id, snapshot_id)
);
CREATE INDEX relay_snapshot_latest_idx ON relay.snapshot (recipient_device_id, created_at DESC);

CREATE TABLE relay.replication_outbox (
  id uuid PRIMARY KEY,
  home_region text NOT NULL,
  standby_region text NOT NULL,
  recipient_device_id text NOT NULL,
  server_sequence bigint NOT NULL,
  payload_hash bytea NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  attempt_count integer NOT NULL DEFAULT 0,
  replicated_at timestamptz
);

CREATE TABLE relay.replication_inbox (
  source_region text NOT NULL,
  replication_batch_id text NOT NULL,
  recipient_device_id text NOT NULL,
  replicated_next_sequence bigint NOT NULL,
  received_at timestamptz NOT NULL DEFAULT now(),
  payload_hash bytea NOT NULL,
  PRIMARY KEY (source_region, replication_batch_id)
);

CREATE TABLE relay.outbox (
  id uuid PRIMARY KEY,
  aggregate_key text NOT NULL,
  kind text NOT NULL,
  payload jsonb NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  available_at timestamptz NOT NULL DEFAULT now(),
  attempt_count integer NOT NULL DEFAULT 0,
  published_at timestamptz
);
CREATE INDEX relay_outbox_available_idx ON relay.outbox (available_at) WHERE published_at IS NULL;
