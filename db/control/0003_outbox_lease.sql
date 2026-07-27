ALTER TABLE control.outbox
  ADD COLUMN IF NOT EXISTS lease_owner TEXT,
  ADD COLUMN IF NOT EXISTS leased_until TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS last_error TEXT;

CREATE INDEX IF NOT EXISTS control_outbox_lease_idx
  ON control.outbox (occurred_at)
  WHERE published_at IS NULL;
