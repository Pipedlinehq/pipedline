-- Console depth pass, wave 2 (docs/CONSOLE_IA.md section 9, pattern 8): Home. The needs-attention
-- counts are read live from the owning modules and stored nowhere. What Home remembers: which
-- guidance cards a staff member has put away, and which suggestions a venue has approved or
-- dismissed (with the reason, so a suggestion is not made again). Owned by the hub module: a
-- suggestion is approved by running one of the assistant's own tools.

-- A guidance or setup card one person closed. Per staff member: putting a card away is a
-- personal tidy, not a venue decision.
create table home_dismissals (
  org_id uuid not null references orgs(id),
  staff_id uuid not null references staff(id),
  card_key text not null check (char_length(card_key) between 1 and 60),
  dismissed_at timestamptz not null default now(),
  primary key (org_id, staff_id, card_key)
);

-- A suggestion the venue acted on or put away. Keyed by the suggestion's own key (what it is
-- about), so the same suggestion is not shown again at that venue once decided.
create table home_suggestion_decisions (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references orgs(id),
  venue_id uuid not null references venues(id),
  suggestion_key text not null check (char_length(suggestion_key) between 1 and 160),
  decision text not null check (decision in ('approved', 'dismissed')),
  -- Why it was dismissed, in the person's words (optional); the tool's question when approved.
  reason text check (char_length(reason) <= 500),
  decided_by_id uuid references staff(id),
  decided_at timestamptz not null default now()
);
create unique index home_suggestion_decisions_one on home_suggestion_decisions (org_id, venue_id, suggestion_key);

select app.apply_tenant_rls();
