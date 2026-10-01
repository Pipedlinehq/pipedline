-- Hub: who a key is for (a staff member's assistant, or a connected service), assistant sign-in
-- by OAuth, hosted agents on the call record, and model usage per org. docs/modules/hub.md.

-- ── Audience ──────────────────────────────────────────────────────────────────
-- 'assistant': a staff member's own assistant (the default, every key so far).
-- 'service:<plug key>': a key an owner made for a connected service (e.g. service:criota). It
-- may hold only outcomes:read, never writes, and dies with the connection it was made for.
alter table agent_keys add column audience text not null default 'assistant'
  check (audience = 'assistant' or audience ~ '^service:[a-z0-9][a-z0-9-]{0,59}$');
alter table agent_keys add column connection_id uuid references connections(id);
alter table agent_keys add constraint agent_keys_service_has_connection
  check ((audience = 'assistant') = (connection_id is null));
-- 'key': pasted by a person. 'oauth': made when a person signed an assistant in; it is never
-- presented itself (its key_hash is of a value nobody holds), only its tokens are.
alter table agent_keys add column kind text not null default 'key' check (kind in ('key', 'oauth'));
alter table agent_keys add column oauth_client_id text;
create index agent_keys_connection on agent_keys (org_id, connection_id) where connection_id is not null;

-- ── Hosted agents on the call record ─────────────────────────────────────────────
alter table agent_calls add column hosted_agent_key text;
alter table agent_calls add column agent_run_id uuid references agent_runs(id);

-- ── OAuth: assistants that registered themselves (RFC 7591) ──────────────────────
-- Belongs to no org and grants nothing: it names where a person may be sent back to.
create table agent_oauth_clients (
  client_id text primary key,
  client_name text not null,
  redirect_uris text[] not null,
  client_uri text,
  created_at timestamptz not null default now(),
  last_used_at timestamptz
);
comment on table agent_oauth_clients is '@platform';

-- A person's yes, as a one-use code. Exchanged once, within two minutes, with the PKCE verifier.
create table agent_oauth_codes (
  code_hash bytea primary key,
  org_id uuid not null references orgs(id),
  staff_id uuid not null references staff(id),
  client_id text not null references agent_oauth_clients(client_id),
  client_name text not null,
  redirect_uri text not null,
  code_challenge text not null,
  resource text not null,
  scopes text[] not null,
  venue_ids uuid[],
  can_write boolean not null default false,
  lasts_days integer not null,
  expires_at timestamptz not null,
  used_at timestamptz,
  key_id uuid references agent_keys(id),              -- what the exchange made, so a replay can end it
  created_at timestamptz not null default now()
);
create index agent_oauth_codes_org on agent_oauth_codes (org_id, created_at);

-- Access and renewal tokens of a signed-in assistant. Only hashes are kept.
create table agent_oauth_tokens (
  token_hash bytea primary key,
  org_id uuid not null references orgs(id),
  key_id uuid not null references agent_keys(id),
  kind text not null check (kind in ('access', 'refresh')),
  resource text not null,
  expires_at timestamptz not null,
  used_at timestamptz,                                 -- a renewal token, once renewed with
  created_at timestamptz not null default now()
);
create index agent_oauth_tokens_key on agent_oauth_tokens (org_id, key_id);

-- ── Model usage (the runtime model boundary) ─────────────────────────────────────
create table llm_usage (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references orgs(id),
  day date not null,                                   -- the org's own calendar day
  purpose text not null,
  model text not null,
  tier text not null,
  input_tokens integer not null,
  output_tokens integer not null,
  outcome text not null,
  occurred_at timestamptz not null default now()
);
create index llm_usage_org_day on llm_usage (org_id, day);
comment on table llm_usage is '@append_only';

select app.apply_tenant_rls();
