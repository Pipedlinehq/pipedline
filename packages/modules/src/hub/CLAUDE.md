# hub — assistant access and plugs

The venue's agent surface (docs/modules/hub.md): an MCP server a staff member's own assistant
connects to (by pasted key or OAuth sign-in), the plug gateway that re-offers a connected
service's MCP tools under our roles, confirmation and audit, the Criota outcomes boundary,
the hosted-agent runner with two agents on it (`weekly_digest`, `ops_watch`), and the model's
budget and usage.

**Toggleable** (`hub`, depends on nothing). Owns `agent_keys`, `agent_calls` (@append_only),
`agent_confirmations`, `plug_reviews` (@reference), `agent_runs`, `agent_oauth_clients`
(@platform), `agent_oauth_codes`, `agent_oauth_tokens`, `llm_usage` (@append_only).
Migrations: 0006 and 0450 (0650 adds two `jobs` indexes the scale test called for).

## Public functions by purpose

Console (signed-in staff; `ctx.principal.kind === 'staff'`):
- `createAgentKey(ctx, {name, scopes, venueIds?, canWrite, expiresInDays})` manager+; only an owner may set `canWrite`. Returns the key once.
- `createServiceKey(ctx, {connectionId, name?, venueIds?, expiresInDays})` owner only. Audience `service:<plug>`, scope `outcomes:read` only, never writes, dies with the connection.
- `listAgentKeys(ctx, {staffId?})` own keys; an owner sees all. View has `audience`, `kind` ('key'|'oauth'), `label`.
- `revokeAgentKey(ctx, keyId)`, `setAgentKeyCanWrite(ctx, keyId, bool)` (owner; refused for service keys).
- `connectMcpPlug(ctx, {plugKey, accessKey, account?, venueId?})` connect a remote MCP plug (Criota).
- `reviewOAuthRequest(ctx, query)` → `OAuthConsent`: what the consent page shows. `decideOAuthRequest(ctx, query, {allow, allowChanges?, venueIds?, scopes?, lastsDays?})` → `{redirectTo}`.
- `listAgentRuns(ctx, filter)` hosted-agent history (manager+).
- `getLlmSettings(ctx)` / `setLlmSettings(ctx, {daily_token_budget})` (owner).

Web app mounts (web-standard `Request` → `Response`):
- `handleMcpRequest(app, request, {ip})` at `POST /api/mcp`. 401 carries `resource_metadata` for sign-in.
- `handleOAuthRequest(app, request, {ip})` → `Response | null`: `/.well-known/oauth-protected-resource[/api/mcp]`,
  `/.well-known/oauth-authorization-server`, `POST /api/hub/oauth/{register,token,revoke}`. Returns null for other paths.
- The consent page lives at `/console/oauth/authorize` (web app, not built yet); it calls the two console functions above.
- Paths and names: `address.ts` (`mcpResourceUrl`, `oauthIssuer`, `oauthEndpoints`), all on `app.config.platformHost`.

Other modules / internal:
- `resolveAgentKey(app, presented)` pasted key or OAuth access token → `ResolvedAgentKey | null` (same shape for both).
- `offeredTools(caller, {canAsk})`, `runTool(app, caller, offered, args, asking?)`, `narrowTo(caller, venues)`, `recordCall(app, caller, call)`.
- `criotaSharing(ctx, venueId)` → `{enabled, minCohort}`; `isCriotaPlug(key)`. Analytics' `campaignOutcomes` calls these for service keys.
- `hubStates(ctx, venueIds)`, `serviceOf(audience)`, `revokeAllAgentKeys(ctx, reason)`.
- `reviewPlug(app, {plugKey, reviewedBy, tools|from})` PLATFORM: pin a plug's reviewed tool list.
- Hosted agents (`hosted.ts`): `defineHostedAgent({key, name, description, templateVersion, ceiling, scopes?, role?})`,
  `agentMode(ctx, venueId, def)`, `stricterMode(a, b)`, `MODE_RANK`, `getHostedAgent`, `startAgentRun`, `finishAgentRun`.
- The runner (`runner.ts`): `runHostedAgent(app, {orgId, agent, venueId?, trigger}, body)` → `HostedRunOutcome`. The body gets a
  `HostedRun`: `read(tool, args)` (our tools and a plug's read tools, through `runTool` / `runPlugTool`), `act(tool, args)` →
  `ActionResult` (`shadow` | `queued` | `waiting` | `declined` | `done` | `capped` | `refused`), `generate(ModelStep)` (bounded:
  `MAX_MODEL_STEPS_PER_RUN`, schema-checked, then the agent's own `check`; throws `ModelStepRejected`), `mode`, `venues`, `everywhere`.
  `hostedCaller(app, {orgId, agent, venueId?, as?})` / `hostedCallerIn(ctx, …)` build the agent's `ResolvedAgentKey` (an `agent`
  principal, key id `hosted:<agent>`, never an owner). `hostedActionsToday`, `actionSubject`, `HOSTED_ACTION_APPROVAL`
  (`hub.agent_action`), `REPROPOSE_AFTER_HOURS`, `getHostedAgentSettings` / `setHostedAgentSettings` (owner).
- Ops (`ops.ts`): `opsStatus(ctx, {venueId})` manager+: unhealthy connections, flagged orders, paid orders nobody accepted,
  "open, mid-service, no sale when there usually is one". Also the `ops_status` tool.
- Agents (`agents/`): `runWeeklyDigest(app, {orgId, trigger})`, `weeklyDigestDue`, `checkFigures`, `noteFacts`, `allowedFigures`,
  `figure`; `runOpsWatch(app, {orgId, trigger})`, `opsWatchBody`, `agentOnAnywhere`.
- `llmUsageStore(() => app)` the budget/usage store the Anthropic adapter is built with (runtime wires it).

## Hooks
- Registers on `auth.onStaffDisabled` (revokes the person's keys and sign-ins), core `onConnectionRevoked`
  (revokes service keys made for that connection), `onboarding.onOrgClosing` (`lifecycle.ts`: revokes every key).
- Defines none.

## Config surface
Venue (`hubConfig`): `agent_access_enabled`, `allowed_scopes[]` ('*', 'sales:*', '*:read'), `guest_level_reads_enabled`,
`max_keys_per_staff`, `key_max_lifetime_days`, `write_confirmation_ttl_minutes`, `enabled_plugs[]`,
`criota_share_enabled` (off by default), `criota_min_cohort` (floor 5, default 10), `hosted_agents[]`,
`autonomy_level_per_agent`. Org settings: `hub` (`calls_per_key_per_minute`, `calls_per_org_per_minute`),
`llm` (`daily_token_budget`, default 500,000 tokens/day; null = no cap), `hosted_agents` (`actions_per_day` default 20,
`approval_ttl_hours` default 48). Venue also: `ops_order_waiting_minutes` (10), `ops_quiet_min_usual_sales` (3).

## How a hosted agent acts
A level per venue (`hosted_agents` lists it; `autonomy_level_per_agent` raises it from shadow; never above the agent's `ceiling`).
- shadow: `act` builds the tool's own question (transaction rolled back) and records it on the run; nothing queued.
- supervised: one approval per proposed action (`requestApproval`, kind `hub.agent_action`, subject = agent + tool + venue +
  arguments). Approved: the handler rebuilds the question in the deciding transaction, as the agent with the approver's roles
  behind it, and commits only if it reads the same; otherwise it throws `conflict` and the approval stays pending. Rejected: not
  proposed again for 24 hours. The same action already waiting: `waiting`, no second approval.
- autonomous: commits at once only when the agent's ceiling is autonomous AND the tool is not `sensitive`; else as supervised.
- Daily cap per org on proposed and made actions (`actions_per_day`), counted from `agent_calls`. A plug's write tools are never
  offered to an agent. `Asking.notes` (`calls.ts`) is where a question's single-use note is kept: `agent_confirmations` for a
  key, the run's own memory for an agent.

## Jobs, schedules, events, templates, tools
Jobs/schedules: `hub.prune_confirmations` (daily), `hub.check_plugs` (every 15 min), `hub.weekly_digest` (hourly check; sends
once a week from Monday 07:00 org time), `hub.ops_watch` (every 15 min); the last two only for orgs with the agent listed at a
venue. Templates: plug-unhealthy notice (`health.ts`), `hub.weekly_digest` (transactional email to owners). Plugs: `criota`,
`criota-sim` (simulated). Tools: `ops_status` (read, `ops:read`, manager); otherwise it serves every module's `defineTool` and
each connected plug's reviewed tools (`<namespace>__<tool>`). Hosted agents: `weekly_digest` (ceiling autonomous, scope
`metrics:read`, read-only role), `ops_watch` (ceiling supervised, scopes `ops:read`, `orders:write`).
`agent_calls.actor_kind`: `agent_key` | `oauth_assistant` | `service_key` | `hosted_agent`.

## Simulated vs real
Remote MCP: real HTTP adapter (`packages/adapters/src/mcp/http.ts`) pointed at the simulated Criota in tests.
Model: `packages/adapters/src/anthropic` is used when `ANTHROPIC_API_KEY` is set (runtime), else the simulator.
OAuth is served by this module itself; tested end to end with the official MCP client (`test/hub-2/oauth.test.ts`).

## Setup tools (docs/PIPEDLINE.md sections 1 and 2)
The hub serves them like any other tool; they are declared by the modules that own the behaviour:
onboarding (`setup_status`, `menu_import_start`, `menu_import_review`, `menu_import_confirm`, `go_live_check`, `go_live_confirm`,
`go_live_test_email`, `go_live`), tenancy (`venue_describe`, `venue_update`, `plugins_list`, `plugin_enable`, `plugin_configure`,
`plugin_disable`, `connections_list`), ledger (`connection_start`), auth (`team_invite`). New scopes, named by the tools as every
scope is: `setup:read`, `setup:write`, `plugins:read`, `plugins:write`, `connections:read`, `connections:write`, `team:write`
(plus the existing `venue:*`, `menu:*`). A self-serve org starts with this module switched on at its venue and nothing else, so its
owner's assistant can connect (by OAuth sign-in or a pasted key) and do the rest.
- `hubModule.assistantConfigurable` is `false`: `plugin_enable` / `plugin_configure` answer forbidden for this module to any `agent`
  principal (tenancy `planPluginChange`). An assistant never changes what assistants may do; `plugin_disable` is allowed.
- `connection_start` returns a provider sign-in link. Its signed `state` is bound to the staff member behind the key, and only that
  person's console session can finish it (`ledger.completePosOAuth`). No token, code or secret passes through the assistant.

## Known gaps
- OAuth: dynamic registration only (no client-id metadata documents); a renewal token presented twice ends the
  connection (Criota's 30-second grace not ported); no sweep job for expired codes/tokens/idle clients yet.
- The consent page UI is not built. Sign-in is https-only in practice (the MCP client refuses http token endpoints).
- Hosted agents: no change at a connected service (plug writes are not offered). An autonomous commit runs with no person
  behind it, so a tool whose service function writes a staff foreign key from `staffOf(ctx)` fails closed (nothing changed)
  rather than commit; none of today's non-sensitive tools does. `weekly_digest` checks figures, not adjectives: the email
  carries the digest's own sentence beneath the note for that reason. `ops_watch` writes its note to the run record only;
  nobody is emailed. No console page lists agent runs or the hosted-action approvals' detail yet.
- Criota outcomes are per venue; a service key seeing two sharing venues must name one.
