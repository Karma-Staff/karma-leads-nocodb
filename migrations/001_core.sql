-- The application schema. One leads table (the three NocoDB tables were ~20 of
-- ~24 columns identical); identity/authz owned here, never by NocoDB; the
-- Segments table becomes a view.

-- pg_trgm backs the trigram search indexes below. It is a trusted extension
-- (PG13+), so the database owner may create it without superuser — which is
-- exactly the situation on managed hosts like Render, where db/init never runs.
CREATE EXTENSION IF NOT EXISTS pg_trgm;

-- ---------------------------------------------------------------- identity
CREATE TABLE organizations (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  name text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE app_users (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  oidc_sub text UNIQUE,                -- WorkOS user id, set on first login
  email text UNIQUE NOT NULL,          -- always lowercased
  display_name text,
  disabled boolean NOT NULL DEFAULT false,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE organization_memberships (
  org_id bigint NOT NULL REFERENCES organizations(id),
  user_id bigint NOT NULL REFERENCES app_users(id),
  role text NOT NULL CHECK (role IN ('admin', 'member')),
  PRIMARY KEY (org_id, user_id)
);

-- ---------------------------------------------------------------- leads
CREATE TABLE leads (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  lead_code text UNIQUE NOT NULL,      -- KL-…, the public identifier
  kind text NOT NULL CHECK (kind IN ('company', 'person', 'job')),
  name text NOT NULL,                  -- display: company / person / job title
  company text,                        -- employer for person/job (= name for company)
  title text,                          -- person's job title
  contact text,                        -- job posting's recruiter
  contact_title text,
  website text,
  job_url text,
  category text,
  industry text,
  employees int,
  revenue bigint,
  certs int,
  city text,
  state text,
  phone text,
  email text,
  phone_key text,                      -- normalized 10-digit; placeholder-rejected
  status text NOT NULL DEFAULT 'New',
  owner text,
  favorite boolean NOT NULL DEFAULT false,
  removed boolean NOT NULL DEFAULT false,
  notes text,                          -- legacy import-time notes column
  source text,
  source_file text,
  date_added date,                     -- jobs' Posted lands here too
  company_lead_id bigint REFERENCES leads(id),   -- person/job -> its company
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

-- registry tombstones: an old code in a bookmark still resolves
CREATE TABLE lead_code_aliases (
  code text PRIMARY KEY,
  lead_id bigint NOT NULL REFERENCES leads(id) ON DELETE CASCADE
);

-- every natural key a lead ever arrived on — the server-side dedupe substrate
CREATE TABLE lead_keys (
  kind text NOT NULL CHECK (kind IN ('company', 'person', 'job')),
  key_type text NOT NULL CHECK (key_type IN ('phone', 'email', 'namecity', 'name')),
  key_value text NOT NULL,
  lead_id bigint NOT NULL REFERENCES leads(id) ON DELETE CASCADE,
  PRIMARY KEY (kind, key_type, key_value)
);
CREATE INDEX lead_keys_lead_idx ON lead_keys (lead_id);

-- the query paths the old system full-scanned
CREATE INDEX leads_kind_removed_idx   ON leads (kind, removed);
CREATE INDEX leads_status_idx         ON leads (status) WHERE NOT removed;
CREATE INDEX leads_state_idx          ON leads (state);
CREATE INDEX leads_owner_idx          ON leads (owner) WHERE owner IS NOT NULL;
CREATE INDEX leads_favorite_idx       ON leads (favorite) WHERE favorite;
CREATE INDEX leads_phone_key_idx      ON leads (phone_key) WHERE phone_key IS NOT NULL;
CREATE INDEX leads_segment_idx        ON leads (category, state) WHERE kind = 'company';
CREATE INDEX leads_company_lead_idx   ON leads (company_lead_id) WHERE company_lead_id IS NOT NULL;
CREATE INDEX leads_date_added_idx     ON leads (date_added DESC NULLS LAST, id DESC);
CREATE INDEX leads_name_trgm_idx      ON leads USING gin (name gin_trgm_ops);
CREATE INDEX leads_company_trgm_idx   ON leads USING gin (company gin_trgm_ops);
CREATE INDEX leads_email_trgm_idx     ON leads USING gin (email gin_trgm_ops);
CREATE INDEX leads_city_trgm_idx      ON leads USING gin (city gin_trgm_ops);

-- ---------------------------------------------------------------- work product
CREATE TABLE lead_comments (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  lead_id bigint NOT NULL REFERENCES leads(id) ON DELETE CASCADE,
  author_user_id bigint REFERENCES app_users(id),
  author_email text NOT NULL,          -- survives account deletion; ETL fills it
  body text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz,
  deleted_at timestamptz
);
CREATE INDEX lead_comments_lead_idx ON lead_comments (lead_id) WHERE deleted_at IS NULL;

CREATE TABLE blocklist (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  phone text,
  phone_key text UNIQUE NOT NULL,
  company text,
  reason text,
  added_by text,
  created_at timestamptz NOT NULL DEFAULT now()
);

-- the Recent tab's per-account trail (was recents.json): 25 shown, deduped by
-- lead via the PK — touching again just moves touched_at forward
CREATE TABLE recents (
  user_id bigint NOT NULL REFERENCES app_users(id) ON DELETE CASCADE,
  lead_id bigint NOT NULL REFERENCES leads(id) ON DELETE CASCADE,
  kind text,                           -- last interaction kind, display only
  touched_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (user_id, lead_id)
);
CREATE INDEX recents_user_time_idx ON recents (user_id, touched_at DESC);

-- append-only action log behind the manager's Team activity tab. Written by
-- the API on every mutation — not client-reported. (NocoDB's own audit table
-- stays off; it once hit 1.3 GB.)
CREATE TABLE activity_log (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  at timestamptz NOT NULL DEFAULT now(),
  actor text NOT NULL,                 -- email, or a service identity name
  user_id bigint REFERENCES app_users(id),
  action text NOT NULL CHECK (action IN ('open','status','owner','favorite',
    'unfavorite','note','remove','restore','import','jobsearch')),
  lead_id bigint,                      -- no FK: the log outlives its leads
  lead_code text,
  lead_name text,
  from_value text,
  to_value text,
  meta jsonb
);
CREATE INDEX activity_at_idx    ON activity_log (at DESC);
CREATE INDEX activity_actor_idx ON activity_log (actor, at DESC);

-- ---------------------------------------------------------------- imports
-- rotatable, revocable pipeline credentials; scopes gate which routes work
CREATE TABLE service_tokens (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  name text NOT NULL,
  token_hash text NOT NULL UNIQUE,     -- sha256 hex of the presented token
  scopes text[] NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  revoked_at timestamptz
);

CREATE TABLE import_jobs (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  created_by text NOT NULL,            -- service identity name or user email
  filename text,
  category text,
  idempotency_key text UNIQUE,
  status text NOT NULL DEFAULT 'open'
    CHECK (status IN ('open', 'processing', 'committed', 'failed', 'aborted')),
  counts jsonb,
  error text,
  created_at timestamptz NOT NULL DEFAULT now(),
  committed_at timestamptz
);

CREATE TABLE import_rows (             -- staging; dies with its job
  job_id uuid NOT NULL REFERENCES import_jobs(id) ON DELETE CASCADE,
  seq int NOT NULL,
  payload jsonb NOT NULL,
  PRIMARY KEY (job_id, seq)
);

-- ---------------------------------------------------------------- admin views
-- what the old Segments table materialized; NocoDB browses this read-only
CREATE VIEW segments AS
  SELECT category, state, count(*) AS companies
  FROM leads
  WHERE kind = 'company' AND NOT removed
        AND category IS NOT NULL AND state IS NOT NULL
  GROUP BY category, state;
