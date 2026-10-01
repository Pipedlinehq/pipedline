# onboarding — intake, provisioning, menu import, go-live, offboarding

Everything between "sold" and "live" (docs/ONBOARDING.md), and leaving: the multi-session intake,
the provisioning job built from registered steps, menu import with item-by-item confirmation, the
gated go-live checklist, the status board, tenant health, support access on the record, and
closing an org.

**Spine** (depends on tenancy). Owns `onboardings`, `provisioning_steps`, `onboarding_touches`
(@platform), `menu_imports`, `support_access`. Migrations 0006, 0400, 0550, 0551
(`onboardings.origin` = `platform` | `self_serve`, `onboardings.started_by_user_id`).

Two ways in, one machinery (docs/PIPEDLINE.md sections 1 and 2):
- **Platform-led**: a platform admin fills the intake, starts provisioning and takes the org live.
- **Self-serve**: a person who signed in by email starts their own org; provisioning runs by
  itself; their assistant sets the venue up through the setup tools; the owner takes it live.

## Public functions by purpose
Platform admin only (`requirePlatformAdmin`: a `platform` principal whose `adminUserId` is in `platform_admins`):
- Intake: `startOnboarding(app, actor, {tradingName})`, `saveIntakeSection(app, actor, {onboardingId, section, data})`, `getIntake`.
- `startProvisioning(app, actor, {onboardingId})` (refuses an incomplete intake), `retryProvisioningStep(app, actor, {onboardingId, step})`.
- Board: `listOnboardings`, `getOnboarding`, `recordManualTouch`, `onboardingMetrics`.
- `runGoLiveChecks(app, actor, {onboardingId})`, `goLive(app, actor, {onboardingId})` (refuses while any check fails).
- `closeOrg(app, actor, {orgId, reason})`, health (`getTenantHealth`, `listTenantHealth`), support access.
Owner (tenant ctx): `getOwnOnboarding(ctx)`, `getGoLiveChecklist(app, orgId, principal)`,
`confirmGoLiveItem(ctx, {key})` (owner only, never platform), `sendGoLiveTestEmail(ctx)`, `exportOrgData(ctx)`,
`getOwnGoLiveChecklist(ctx)` (the checklist from inside the org's transaction, plus `live` and `origin`),
`describeGoLiveConfirmation(ctx, {key})` (what exactly the owner would be confirming; throws when there is nothing to confirm yet),
`goLiveAsOwner(ctx)` (self-serve orgs only; same checklist, same refusal; a platform-led org answers forbidden),
`getSetupStatus(ctx, venueId)` (setup.ts: steps, `next`, `askTheOwner`, failing checks).
Self-serve (self-serve.ts):
- `selfServeStart(app, actor, {venueName, firstName?, timezone?, another?}, {ip?})`. `actor` is the staff principal of a signed-in
  session (`auth.verifyOpenLogin` then `auth.authenticate`), with or without an org. Opens an onboarding with origin `self_serve`
  and a short intake, runs `runProvisioning` inline, returns `{orgId, venueId, host, created}`; the caller then calls `auth.selectOrg`.
  A person who already belongs to an org gets that org back (`created: false`). `another: true` starts a further org only for the
  owner of a live one who has no draft. Limits: `SELF_SERVE_LIMITS` (5 calls/hour per person, 20/hour per address, 3 new orgs/day
  per address; the per-address ones need `ip`). Writes the default quota (`tenancy.writeOrgQuota`) and audits `org.self_serve_started`.
- `setOrgQuota(app, actor, {orgId, quota})` platform admin: change an org's `quota.max_venues`.
- A self-serve intake is parsed with `parseIntake(raw, 'self_serve')`: the venue's address, hours, the services and `content.about`
  may be absent. `ProvisioningState.origin` tells a step which it is. A self-serve org starts with `SELF_SERVE_MODULES` (`hub`) only.
Menu import (manager at the venue; any staff role may read):
- `requestMenuImport(ctx, {venueId, source: {kind:'text', text} | {kind:'url', url} | {kind:'file'}})` queues the job; `file` is refused.
- `getMenuImport(ctx, id)`, `listMenuImports(ctx, {venueId})` — items with `allergensUnverified`.
- `editImportItem(ctx, {importId, itemKey, patch})` (setting `allergens` marks them checked),
  `confirmImportItem(ctx, {importId, itemKey, allergensChecked})` writes via `menu.createMenu/createSection/createModifierGroup/createModifier/createItem`,
  `discardImportItem`, `discardMenuImport`, `menuImportStanding(ctx, venueId)`.
- `fetchMenuPage(url, deps)` / `checkFetchUrl` / `isPublicAddress` / `htmlToText` (menu-fetch.ts); `setMenuFetchDeps(deps)` for tests.
Registries for other modules: `registerProvisioningStep`, `registerGoLiveCheck`, `registerOrgExportProvider`,
`declareServiceModule(service, moduleKey)`, `onOrgClosing(fn)`.
- A provisioning step may name `modules: [...]`: when one of them is switched on later through `tenancy.enablePlugin`, a run of the
  step that was `skipped` is queued again (`requeueStepsForModule(ctx, moduleKey)`, registered on `tenancy.onPluginEnabled`).
  Tagged today: pages (website), ordering_defaults (ordering), payments_connect (ordering, qr), qr_tables (qr), loyalty_defaults (loyalty).
- A go-live check may give `fix: {how, tool?, ownerOnly?}` (how a failing check is put right; shown by `go_live_check` and
  `setup_status`) and, when it needs the owner's yes, `whatIsConfirmed(c)` (the words of the question).

## Provisioning steps (order · key)
steps.ts: 10 org · 20 brand · 30 hours · 40 modules · 50 pages · 60 redirects · 70 subdomain · 80 custom_domain
(blocked on DNS) · 90 sending_domain (blocked on DNS) · 100 staff.
module-steps.ts: 45 menu_import (blocked until the owner has decided every item; PDF → blocked with reason) ·
95 sms_sender (blocked: no SMS provisioning port exists) · 110 ordering_defaults (pacing from intake) ·
120 payments_connect (blocked: "Connect your payment account…") · 130 qr_tables (codes for declared tables) ·
140 loyalty_defaults (a default programme if loyalty is on and none exists) · 150 pos_connect (blocked until connected).
A blocked step is re-run by the `onboarding.poll` schedule; waiting does not count as an attempt.

## Go-live checks (order · key)
5 menu_confirmed (owner confirmation; no imported item still waiting) · 10 hours_confirmed (owner) · 20 domain_live ·
30 transactional_email · 40 staff_signed_in · 50 pages_published · 60 structured_data_valid · 65 redirects_mapped ·
70 payment_ready (connection + a paid order) · 75 kitchen_test_order (a paid order accepted/readied) ·
80 loyalty_enrolment_tested. `MODULE_PROVISIONING_STEPS` / `MODULE_GO_LIVE_CHECKS` list the module ones.

## Hooks
Defines `onOrgClosing` (hub registers: revoke every key). Calls core `revokeConnection` on close (which runs
`onConnectionRevoked`).

## Jobs, events, templates, tools
Jobs: `onboarding.provision`, `onboarding.poll` (schedule every 10 min, platform), `onboarding.menu_import`.
Events: `org.provisioned`, `org.went_live`, `org.closed`. Template: `onboarding.test_send`.
Tools (tools.ts; every write is propose + commit):
- `setup_status` (read, `setup:read`, owner): the first call. Steps `venue_details`, `opening_hours`, `plugins`, `connections`,
  `menu`, `team`, `go_live`, each `done | to_do | waiting | optional` with the tools that do it; `next` is one instruction.
- `menu_import_start` (write, `menu:write`, manager), `menu_import_review` (read, `menu:read`), `menu_import_confirm` (write,
  `menu:write`, manager: edits, confirm, discard, up to 40 items; refuses an unpriced item, and unverified allergens without `allergens_checked`).
- `go_live_check` (read, `setup:read`, owner), `go_live_confirm` and `go_live_test_email` (write, `setup:write`, owner: the two
  owner actions the checklist needs, `confirmGoLiveItem` and `sendGoLiveTestEmail`), `go_live` (write, `setup:write`, owner; `goLiveAsOwner`).
The other setup tools live with what they change: tenancy (`venue_describe`, `venue_update`, `plugins_list`, `plugin_enable`,
`plugin_configure`, `plugin_disable`, `connections_list`), ledger (`connection_start`), auth (`team_invite`).
Acceptance test: `packages/modules/test/setup/self-serve.test.ts` (an unseen email address to a live venue through MCP alone).

## Config surface
No venue config. Intake schema (`intake.ts`, `INTAKE_VERSION`) is the input contract.

## Simulated vs real
Hosting and sending domains: simulators only (`sim/hosting.ts`). Menu extraction: `app.adapters.llm`
(simulator, or the Anthropic adapter when `ANTHROPIC_API_KEY` is set). Page fetch: real node http(s) with a
pinned, checked address.

## Known gaps
PDF/photo menu import (needs a vetted parser). SMS sender registration (no provisioning port). Floor plan
seeding beyond QR codes. The payment/kitchen checks read orders; they cannot tell a test order from a real one.
Self-serve: no web page calls `requestOpenLogin` / `verifyOpenLogin` / `selfServeStart` yet (apps/web is untouched). No
platform-wide cap on new orgs per day, only per person and per address. `menu_confirmed` fails for a venue with no menu, so a
venue that only wants answers from its till (docs/PIPEDLINE.md section 5) cannot go live without one. `site_preview` is not built.
A module switched on in the console with core `setModule` (not `tenancy.enablePlugin`) does not requeue its provisioning steps.
The page copy a self-serve site starts with comes from the short intake (a name, no "about" text).
