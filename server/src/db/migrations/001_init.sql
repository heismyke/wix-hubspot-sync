-- One row per Wix site that has the app installed and opened the dashboard.
CREATE TABLE IF NOT EXISTS installations (
  instance_id   TEXT PRIMARY KEY,
  site_key      TEXT NOT NULL UNIQUE,          -- public id used by the UTM capture script
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- HubSpot OAuth connection. Tokens are AES-256-GCM encrypted (see secretStore.ts).
CREATE TABLE IF NOT EXISTS hubspot_connections (
  instance_id        TEXT PRIMARY KEY REFERENCES installations(instance_id) ON DELETE CASCADE,
  portal_id          BIGINT NOT NULL,
  hub_domain         TEXT,
  scopes             TEXT[] NOT NULL DEFAULT '{}',
  access_token_enc   TEXT NOT NULL,
  refresh_token_enc  TEXT NOT NULL,
  expires_at         TIMESTAMPTZ NOT NULL,
  connected_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
  wix_poll_cursor    TIMESTAMPTZ,
  hubspot_poll_cursor TIMESTAMPTZ
);
CREATE INDEX IF NOT EXISTS hubspot_connections_portal_idx ON hubspot_connections(portal_id);

CREATE TABLE IF NOT EXISTS field_mappings (
  id               SERIAL PRIMARY KEY,
  instance_id      TEXT NOT NULL REFERENCES installations(instance_id) ON DELETE CASCADE,
  position         INT NOT NULL,
  wix_field        TEXT NOT NULL,
  hubspot_property TEXT NOT NULL,
  direction        TEXT NOT NULL CHECK (direction IN ('wix_to_hubspot','hubspot_to_wix','bidirectional')),
  transform        TEXT NOT NULL DEFAULT 'none' CHECK (transform IN ('none','trim','lowercase','uppercase')),
  UNIQUE (instance_id, hubspot_property)
);

-- External ID mapping + last-synced fingerprints (the core of loop prevention).
CREATE TABLE IF NOT EXISTS contact_links (
  instance_id        TEXT NOT NULL REFERENCES installations(instance_id) ON DELETE CASCADE,
  wix_contact_id     TEXT NOT NULL,
  hubspot_contact_id TEXT NOT NULL,
  wix_hash           TEXT,
  hubspot_hash       TEXT,
  last_sync_source   TEXT CHECK (last_sync_source IN ('wix','hubspot','form')),
  last_sync_id       UUID,
  last_synced_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (instance_id, wix_contact_id),
  UNIQUE (instance_id, hubspot_contact_id)
);

-- Durable job queue. Webhooks only enqueue; a worker does the API calls with retries.
CREATE TABLE IF NOT EXISTS jobs (
  id           BIGSERIAL PRIMARY KEY,
  instance_id  TEXT NOT NULL,
  kind         TEXT NOT NULL,
  payload      JSONB NOT NULL,
  dedupe_key   TEXT,
  status       TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','running','done','failed')),
  attempts     INT NOT NULL DEFAULT 0,
  run_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
  last_error   TEXT,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (instance_id, dedupe_key)
);
CREATE INDEX IF NOT EXISTS jobs_pending_idx ON jobs(run_at) WHERE status = 'pending';

-- Observability: what the sync did, with ids only (no PII).
CREATE TABLE IF NOT EXISTS sync_log (
  id                 BIGSERIAL PRIMARY KEY,
  instance_id        TEXT NOT NULL,
  at                 TIMESTAMPTZ NOT NULL DEFAULT now(),
  source             TEXT NOT NULL,
  action             TEXT NOT NULL,
  wix_contact_id     TEXT,
  hubspot_contact_id TEXT,
  sync_id            UUID,
  detail             TEXT
);
CREATE INDEX IF NOT EXISTS sync_log_instance_idx ON sync_log(instance_id, at DESC);

-- Visitor attribution posted by the site script, joined to submissions by hashed email.
CREATE TABLE IF NOT EXISTS attributions (
  id          BIGSERIAL PRIMARY KEY,
  instance_id TEXT NOT NULL REFERENCES installations(instance_id) ON DELETE CASCADE,
  email_ref   TEXT NOT NULL,
  data        JSONB NOT NULL,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS attributions_lookup_idx ON attributions(instance_id, email_ref, created_at DESC);

-- Form submissions processed (metadata only).
CREATE TABLE IF NOT EXISTS form_events (
  instance_id         TEXT NOT NULL REFERENCES installations(instance_id) ON DELETE CASCADE,
  submission_id       TEXT NOT NULL,
  form_id             TEXT,
  email_ref           TEXT,
  hubspot_contact_id  TEXT,
  attribution         JSONB,
  created_at          TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (instance_id, submission_id)
);

CREATE TABLE IF NOT EXISTS schema_migrations (name TEXT PRIMARY KEY, applied_at TIMESTAMPTZ NOT NULL DEFAULT now());
