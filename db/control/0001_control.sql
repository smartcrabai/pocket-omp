CREATE SCHEMA IF NOT EXISTS control;

CREATE TABLE control.account (
  account_id TEXT PRIMARY KEY,
  status TEXT NOT NULL CHECK (status IN ('active','disabled','deleted')),
  created_at TIMESTAMPTZ NOT NULL,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE control.auth_identity (
  provider TEXT NOT NULL CHECK (provider IN ('apple','google','email')),
  provider_subject TEXT NOT NULL,
  account_id TEXT NOT NULL REFERENCES control.account(account_id),
  email TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (provider, provider_subject)
);

CREATE TABLE control.device (
  device_id TEXT PRIMARY KEY,
  account_id TEXT NOT NULL REFERENCES control.account(account_id),
  kind TEXT NOT NULL CHECK (kind IN ('HOST','MOBILE')),
  name TEXT NOT NULL CHECK (char_length(name) BETWEEN 1 AND 128),
  public_key BYTEA NOT NULL CHECK (octet_length(public_key) = 32),
  credential_generation BIGINT NOT NULL CHECK (credential_generation > 0),
  revoked_at TIMESTAMPTZ,
  last_seen_at TIMESTAMPTZ NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX device_account_idx ON control.device(account_id);

CREATE TABLE control.host (
  host_id TEXT PRIMARY KEY,
  device_id TEXT NOT NULL UNIQUE REFERENCES control.device(device_id),
  protocol_version INTEGER NOT NULL DEFAULT 1,
  capabilities JSONB NOT NULL DEFAULT '{}'::jsonb
);

CREATE TABLE control.device_credential (
  device_id TEXT NOT NULL REFERENCES control.device(device_id),
  generation BIGINT NOT NULL,
  credential_hash TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  revoked_at TIMESTAMPTZ,
  PRIMARY KEY (device_id, generation)
);

CREATE TABLE control.pairing_request (
  pairing_id TEXT PRIMARY KEY,
  account_id TEXT REFERENCES control.account(account_id),
  host_device_id TEXT REFERENCES control.device(device_id),
  mobile_device_id TEXT REFERENCES control.device(device_id),
  route_id TEXT,
  host_name TEXT NOT NULL,
  host_public_key BYTEA NOT NULL CHECK (octet_length(host_public_key) = 32),
  mobile_public_key BYTEA CHECK (mobile_public_key IS NULL OR octet_length(mobile_public_key) = 32),
  challenge_hash BYTEA NOT NULL UNIQUE CHECK (octet_length(challenge_hash) = 32),
  watch_secret_hash TEXT NOT NULL,
  transcript_hash BYTEA CHECK (transcript_hash IS NULL OR octet_length(transcript_hash) = 32),
  host_confirmed BOOLEAN NOT NULL DEFAULT false,
  mobile_confirmed BOOLEAN NOT NULL DEFAULT false,
  state TEXT NOT NULL CHECK (state IN ('awaiting-claim','awaiting-confirmations','completed','expired')),
  expires_at TIMESTAMPTZ NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE control.route_pair (
  route_id TEXT PRIMARY KEY,
  account_id TEXT NOT NULL REFERENCES control.account(account_id),
  host_device_id TEXT NOT NULL REFERENCES control.device(device_id),
  mobile_device_id TEXT NOT NULL REFERENCES control.device(device_id),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (host_device_id, mobile_device_id)
);

CREATE TABLE control.region_route (
  route_id TEXT PRIMARY KEY REFERENCES control.route_pair(route_id),
  home_region TEXT NOT NULL,
  standby_region TEXT NOT NULL,
  relay_origin TEXT NOT NULL,
  route_epoch BIGINT NOT NULL CHECK (route_epoch > 0),
  frozen BOOLEAN NOT NULL DEFAULT false,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CHECK (home_region <> standby_region)
);

CREATE TABLE control.entitlement (
  account_id TEXT PRIMARY KEY REFERENCES control.account(account_id),
  product TEXT NOT NULL DEFAULT 'relay_pro',
  state TEXT NOT NULL CHECK (state IN ('active','grace-period','billing-retry','paused','expired','refunded','revoked')),
  usable_until TIMESTAMPTZ,
  last_occurred_at TIMESTAMPTZ NOT NULL,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE control.billing_event (
  provider_event_id TEXT PRIMARY KEY,
  account_id TEXT NOT NULL REFERENCES control.account(account_id),
  event_type TEXT NOT NULL,
  occurred_at TIMESTAMPTZ NOT NULL,
  received_at TIMESTAMPTZ NOT NULL,
  payload_hash BYTEA NOT NULL CHECK (octet_length(payload_hash) = 32),
  processed_at TIMESTAMPTZ
);

CREATE TABLE control.push_token (
  registration_id TEXT PRIMARY KEY,
  account_id TEXT NOT NULL REFERENCES control.account(account_id),
  device_id TEXT NOT NULL REFERENCES control.device(device_id),
  provider TEXT NOT NULL CHECK (provider IN ('expo','apns','fcm')),
  token_hash BYTEA NOT NULL CHECK (octet_length(token_hash) = 32),
  encrypted_token BYTEA NOT NULL,
  encryption_key_id TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  revoked_at TIMESTAMPTZ,
  UNIQUE (provider, token_hash)
);

CREATE TABLE control.attachment (
  object_id TEXT PRIMARY KEY,
  account_id TEXT NOT NULL REFERENCES control.account(account_id),
  ciphertext_size BIGINT NOT NULL CHECK (ciphertext_size > 0),
  ciphertext_hash BYTEA NOT NULL CHECK (octet_length(ciphertext_hash) = 32),
  storage_region TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('pending','available','deleted','expired')),
  expires_at TIMESTAMPTZ NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE control.outbox (
  event_id TEXT PRIMARY KEY,
  kind TEXT NOT NULL,
  payload JSONB NOT NULL,
  occurred_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  published_at TIMESTAMPTZ,
  attempts INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX control_outbox_pending_idx ON control.outbox(occurred_at) WHERE published_at IS NULL;

CREATE TABLE control.signing_key_metadata (
  key_id TEXT PRIMARY KEY,
  purpose TEXT NOT NULL,
  public_key BYTEA NOT NULL,
  not_before TIMESTAMPTZ NOT NULL,
  not_after TIMESTAMPTZ NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('staged','active','retiring','retired'))
);

CREATE TABLE control.admin_role (
  staff_subject TEXT NOT NULL,
  role TEXT NOT NULL CHECK (role IN ('support-read','support-write','billing-admin','security-admin')),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (staff_subject, role)
);

CREATE TABLE control.support_access_grant (
  grant_id TEXT PRIMARY KEY,
  staff_subject TEXT NOT NULL,
  account_id TEXT NOT NULL REFERENCES control.account(account_id),
  reason TEXT NOT NULL,
  expires_at TIMESTAMPTZ NOT NULL,
  revoked_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE control.admin_audit_event (
  audit_id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  event_id TEXT NOT NULL UNIQUE,
  staff_subject TEXT NOT NULL,
  action TEXT NOT NULL,
  account_id TEXT,
  target_id TEXT,
  correlation_id TEXT NOT NULL,
  metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
  occurred_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE FUNCTION control.reject_admin_audit_mutation() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'admin audit events are append-only';
END;
$$;
CREATE TRIGGER admin_audit_append_only
  BEFORE UPDATE OR DELETE ON control.admin_audit_event
  FOR EACH ROW EXECUTE FUNCTION control.reject_admin_audit_mutation();
