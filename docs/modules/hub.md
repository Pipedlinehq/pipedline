# MODULE — `hub` (agent access & plugs)

> Draft, 2026-09-30. Staging at the bottom matches `ROADMAP.md`.

The venue's agent surface. One place where a venue's assistant can see and act on the venue, and
one place where the venue connects everything else it uses. Criota is one plug among the others.

## 1. Three things, built in this order

```
(a) We are an MCP server      the venue's own assistant ──► our tools ──► the same server actions the console uses
(b) Connections registry      Square, Klaviyo, Meta ads, Google Business Profile, Xero, Criota … one table, one health view
(c) Gateway                   our MCP server also offers the tools of the venue's connected plugs,
                              under our roles, our confirm-before-write, our audit log
(d) Hosted agent (last)       scheduled and console-side agents that use the same tool catalogue
```

**Do not build a chat product first.** Claude and ChatGPT are already the host a venue owner has
open. (a) makes the venue usable from the assistant they already pay for, and it is cheap because
the pattern exists: Criota's MCP server (`Criota/apps/api/src/mcp/`) already solves scoped keys,
confirmed writes and audit. Lift that into a shared package rather than writing it twice.

**(c) is the part worth owning.** A venue that connects five separate MCP servers to its assistant
has five sign-ins, five permission models and no record of what was done. Through the gateway it
adds one connector ("my venue") and gets every plug it has connected, with one role model and one
audit trail. That is the "hub", and it is what a generic assistant host does not give a venue.

## 2. The server contract (taken from Criota's, which is proven on staging and live reads)

1. **Tenant comes from the key, never from an argument.** No tool takes `org_id`. A tool may take
   a `venue` only to choose among venues the key can already see.
2. **Every tool is pinned to a server action the console already uses.** Module guards
   (`assertModule`), RLS, role checks, plan limits and rate limits then apply without a second
   implementation. A disabled module's tools are not offered.
3. **Output is an allowlist.** Each tool declares the exact shape it returns; a field nobody named
   cannot leave. This is what keeps guest PII and card identifiers inside.
4. **A write is two calls.** The first changes nothing and returns the question in plain words.
   The second carries the person's yes and a signed, single-use, short-lived note; the change is
   made only if the question rebuilt from current state reads the same. An assistant that cannot
   put a question to its person is offered reads only.
5. **Money never moves without a confirmation**, whatever autonomy level is configured: refunds,
   comps, loyalty adjustments, campaign sends with a cost, anything that spends ad budget.
6. **Every call is audit-logged**: key, tool, plug, outcome. Never argument values, never results.
7. **Keys** are per staff member, hashed, shown once, revocable, expiring, scoped, and read-only
   unless the owner ticks "can make changes". A key can never exceed its staff member's role.

## 3. Guest data through an assistant

The identity graph is the asset and the largest liability. Defaults:

- **Aggregates by default.** `customers_summary`, cohort counts, repeat rate, spend bands.
- **Guest-level reads are their own scope** (`guests:read`), off by default, with a field
  allowlist: name, contact, visit count, last visit, loyalty tier, allergy notes. Never card
  identifiers, never raw transaction payloads.
- **Bulk export is not a tool.** Exports stay in the console behind the owner role.
- **Guest-written text is untrusted input.** Review text, order notes, booking requests and
  inbound messages can carry instructions aimed at the assistant. Return them labelled as quoted
  guest content, length-capped, and never in the same field as our own instructions.

## 4. Schema

```sql
plugs(key PRIMARY KEY, name, kind,          -- 'adapter' | 'mcp'
      tier,                                  -- 'first_party' | 'curated' | 'community'
      capabilities jsonb, manifest_version,
      tools_digest,                          -- hash of the reviewed tool list (see §6)
      status)                                -- catalogue, platform-owned

connections(id, org_id, venue_id NULL, plug_key, status,
            scopes[], secret_ref,            -- a vault reference, never the secret
            external_account_id, connected_by_staff_id, connected_at,
            last_ok_at, last_error, expires_at)
-- UNIQUE(org_id, venue_id, plug_key, external_account_id)

agent_keys(id, org_id, staff_id, name, key_hash, scopes[], venue_ids[],
           can_write, expires_at, last_used_at, revoked_at)

agent_calls(id, org_id, key_id, plug_key, tool, effect,   -- 'read' | 'write'
            outcome, occurred_at)                          -- no arguments, no results

agent_confirmations(nonce PRIMARY KEY, key_id, tool, args_digest, question_digest,
                    expires_at, spent_at)
```

**`connections` replaces the scattered credential columns.** Square merchant/location ids, the
Resend domain, the Twilio subaccount and the Criota link are all connections. One table gives
one health view ("last successful sync, token expiring in 6 days"), one re-auth flow, and one
place to revoke. `modules/pos-adapters.md`'s `connect()` writes here.

## 5. First tools (reads ship before writes)

| Tool | Effect | Module |
|---|---|---|
| `venue_status` | read | tenancy (hours, modules on, connection health) |
| `sales_summary` | read | ledger (by day, daypart, channel; totals and counts only) |
| `menu_list` | read | ordering |
| `menu_set_availability` | write | ordering (the 86 button) |
| `hours_set_exception` | write | tenancy (public holiday, closure) |
| `orders_list` | read | ordering |
| `customers_summary` | read | identity (aggregates) |
| `loyalty_summary` | read | loyalty |
| `page_update_copy` | write | website |
| `message_draft` | write (creates a draft only) | comms |

Sending a campaign is not in the first cut. Drafting is; the send stays in the console until the
confirmation flow has run on real venues.

### 5a. Setup tools (added 2026-10-01, `PIPEDLINE.md` "What has to change" 1 and 2)

A venue is set up through the same server. A person signs in by email, starts their own organisation and draft
venue (`onboarding.selfServeStart`; no platform admin), connects their assistant, and the assistant drives the
rest. Each tool is declared by the module that owns the behaviour and pinned to the function the console uses.

| Tool | Effect | Module | Scope · least role |
|---|---|---|---|
| `setup_status` | read | onboarding | `setup:read` · owner. What is done, the one next step in plain words, what only the owner can answer. Called first, and after every change. |
| `venue_describe` | read | tenancy | `venue:read` |
| `venue_update` | write | tenancy | `venue:write` · manager. Name, address, phone, time zone, cuisine, the week's hours. |
| `plugins_list` | read | tenancy | `plugins:read` · manager. Every module and plug: purpose, needs, on or off, settings, and the settings as JSON Schema generated from the module's zod schema. |
| `plugin_enable` / `plugin_configure` / `plugin_disable` | write | tenancy | `plugins:write` · manager. A setting the module does not have, or a value its schema refuses, is answered with which and why. |
| `connections_list` | read | tenancy | `connections:read` |
| `connection_start` | write | ledger | `connections:write` · manager. Returns the provider's sign-in link for the owner to open. |
| `menu_import_start` / `menu_import_confirm` | write | onboarding | `menu:write` · manager |
| `menu_import_review` | read | onboarding | `menu:read` |
| `go_live_check` | read | onboarding | `setup:read` · owner |
| `go_live_confirm` / `go_live_test_email` / `go_live` | write | onboarding | `setup:write` · owner |
| `team_invite` | write | auth | `team:write` · manager. Never an owner: that is a console action. |

Rules that are specific to these:

- **An assistant never sets the rules it is held to.** The hub's own settings (`allowed_scopes`, guest-level
  reads, the autonomy of hosted agents, sharing with Criota) are refused to any assistant, with or without a
  yes. It may switch assistant access off, since that only takes access away.
- **The assistant never holds a credential.** `connection_start` hands back a link. The sign-in, the code the
  provider returns, the tokens and the choice of location stay in the owner's own browser session.
- **Imported menu text is quoted content**, and an allergen list a model read is not confirmed until the
  owner has said they checked it; the question shows every item as it will go on the menu.
- **Going live is the checklist's decision.** `go_live` is refused, with the reasons, while any check fails,
  and only the owner of a venue they started themself may call it.
- **Built-in modules are listed as always on.** Analytics has no switch; its settings are the organisation's
  and are changed with `plugin_configure`.

## 6. Plugs, tiers, and the community idea

| Tier | What | Who maintains | Trust |
|---|---|---|---|
| First-party | OS modules, Criota | us | full |
| Curated | Square, Klaviyo, Meta ads, Google Business Profile, Xero | us, or the vendor's own MCP server behind our gateway | reviewed; writes confirmed |
| Community | contributed plugs | the author | read-only until reviewed; listed only after review |

Rules that make a community tier survivable:

- **A community plug is a manifest, not code we run.** It declares tools, the HTTP calls or remote
  MCP endpoint behind them, and the scopes needed. Nothing arbitrary executes on our workers.
- **Pin the tool list.** A remote MCP server can change a tool's description after review, and
  the description is text the assistant obeys. Store a digest of the reviewed tool list; if it
  changes, the plug drops to unavailable until re-reviewed.
- **Least scope per connection.** A plug gets only the scopes its manifest declared and the owner
  approved.
- **Start curated.** A community tier needs a community. Until venues exist, every plug is ours.

## 7. Criota as a plug

This is the join the platform exists for, so its boundary is stated here rather than implied.

| Direction | What crosses | What never crosses |
|---|---|---|
| Criota → OS | campaign, creator and offer identifiers; the landing link that stamps `acquisition_*` | creator scoring internals |
| OS → Criota | per-campaign outcomes for that venue: new customers, attributed spend as a band, repeat rate | guest rows, contact details, card identifiers, any per-guest record |

- The venue turns the plug on; it is not on by default, including for venues that came in through
  the channel.
- **Minimum cohort size** before any figure is released, so a small campaign cannot identify a guest.
- Criota's own display rules carry over: a band not a number, "aligned with" not "drove", no
  result for the first 7 days.
- Outcomes measured through a recognised card count only guests who ticked the card box
  (`SCHEMA.md` §2a), whose wording covers this. Outcomes measured without a card (a creator's
  link or QR code stamping `acquisition_*` on a new customer) are the venue's own first-party
  record and leave only as totals. Whether totals need their own opt-in is a question for the
  privacy lawyer, not an assumption to build on.
- **No cross-venue joins.** Criota sees each venue's outcomes separately. A guest who visits two
  venues is two unrelated counts.

## 8. Hosted agents (later)

Scheduled work (win-back drafts, review-reply drafts, a weekly summary) runs on Railway workers
against the same tool catalogue, through one `llm-port` module with the model id in config. Orchestration is deterministic; the model is used only
in bounded, schema-validated steps; outward actions go through the comms outbox with an
idempotency key; approvals land in a console queue. Rollout per venue is shadow → supervised →
autonomous, and money-touching actions never leave supervised.

Numbers an assistant quotes come from deterministic queries and say where they came from. The
model assembles the view; it does not compute the revenue figure.

## 9. Failure modes to design for

- Assistant cannot ask its person → reads only, with a message pointing at the console.
- Confirmation reused, expired, or state changed since the question → nothing changes, say so.
- Outcome unknown after a timeout → say "could not confirm", never "done".
- Plug token expired → connection marked unhealthy, its tools withdrawn, owner notified.
- One key hammering the server → per-key and per-org rate limits.
- Remote plug's tool list changed → withdrawn until re-reviewed.

## 10. Config surface

`agent_access_enabled` · `allowed_scopes[]` · `guest_level_reads_enabled` · `max_keys_per_staff`
· `key_max_lifetime_days` · `write_confirmation_ttl_minutes` · `enabled_plugs[]`
· `criota_share_enabled` · `criota_min_cohort` · `hosted_agents[]` · `autonomy_level_per_agent`

## 11. Proposed staging

| With | Ships |
|---|---|
| Stage 0 | `connections` table (Square uses it from the first adapter) |
| Stage 1 | MCP server, reads only |
| Stage 2 | confirmed writes (86, hours, copy) |
| Stage 3 | Criota plug and the gateway, alongside the attribution join |
| Stage 4 | hosted agents; community tier only if there is demand |

Depends on: `tenancy`, `console` (staff and roles), audit. To confirm first: see `VERIFY.md` #13.
