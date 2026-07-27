CREATE TABLE relay.replication_batch (
  batch_id TEXT PRIMARY KEY,
  source_region TEXT NOT NULL,
  target_region TEXT NOT NULL,
  route_epoch BIGINT NOT NULL CHECK (route_epoch > 0),
  durable_through_sequence BIGINT NOT NULL CHECK (durable_through_sequence >= 0),
  payload_hash BYTEA NOT NULL CHECK (octet_length(payload_hash) = 32),
  committed_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX replication_batch_committed_idx
  ON relay.replication_batch (committed_at DESC);
