# campaigns — segments, lifecycle flows, one-off campaigns

Written from the in-progress state of 2026-10-01; check index.ts for anything newer.

Rule-based guest segments (counts, never lists), five lifecycle flows run as hosted agents
(welcome, post-purchase, win-back, VIP, birthday), and one-off email/SMS campaigns that go only with a
manager's approval and then in waves. Every message goes through `comms.queueMessage` as marketing.

**Toggleable** per venue (module switch only; `campaignsConfig` is empty). `dependsOn: []`. Owns
`segments`, `flows`, `flow_enrollments`, `campaigns` (tables from 0005; 0350 adds
`flow_enrollments.venue_id` and `cycle`). Segments and flows are org-wide: their functions use
`assertCampaignsOnSomewhere` (module on at a venue the caller can see, else not found).

## Public functions by purpose
Segments:
- `listSegments(ctx)`, `getSegment(ctx, id)` read_only. `saveSegment(ctx, saveSegmentInput)`, `deleteSegment(ctx, id)` manager.
- `previewSegment(ctx, previewSegmentInput)` manager at the venue; counts and reachable share per channel.
- `ensureSystemSegments(ctx)` idempotent (`SYSTEM_SEGMENTS`: New, One-timers, Lapsed 60+, At risk, Regulars, VIP).
- Rule tree: `segmentRule`, `parseSegmentRule`, `compileSegmentRule`, `RFM_SEGMENTS`; leaves read `customers` and analytics' `fact_customer`.
One-off campaigns (loaded campaign at a venue with no role → not found):
- `draftCampaign(ctx, draftCampaignInput)` manager; email needs subject, SMS body ≤ 480.
- `updateCampaign(ctx, updateCampaignInput)` manager, draft only. `cancelCampaign(ctx, {campaignId})` manager.
- `submitCampaign(ctx, {campaignId})` manager, a person only (an `agent` principal is forbidden); creates a `campaigns.campaign_send` approval (TTL `approvalTtlHours`).
- `getCampaign(ctx, id)`, `listCampaigns(ctx, listCampaignsInput)`, `getCampaignResults(ctx, {campaignId})` read_only.
- `sendCampaignWave(ctx, campaignId, wave)` worker; recounts, queues up to `campaignWaveSize`, schedules the next wave.
- `draftCampaignCopy(app, {orgId, principal, input: draftCopyInput})` manager; one LLM call outside the transaction, contacts redacted, audited. `redactContacts`, `campaignCopySchema`.
Flows:
- `listFlows(ctx)` manager. `runFlowNow(ctx, {flowKey})` manager (enqueues `flowRunJob`).
- `setFlowMode(ctx, setFlowModeInput)` manager for off/shadow; owner for supervised/autonomous; an agent may not raise to supervised+.
- `updateFlow(ctx, updateFlowInput)` owner (partial `flowConfig`, `offerId`). `pinFlowTemplate(ctx, {flowKey, version})` owner.
- `ensureFlows(ctx)` creates the five flows in shadow. `runFlows(app, orgId, {flowKey?, trigger})`, `sendFlowBatch(ctx, approvalId)` worker.
- `effectiveMode(flow)`: the org's setting, never above the agent ceiling; a flow with an offer is capped at supervised. `FLOW_KEYS`, `FLOW_TEMPLATES` (winback has 1.1.0 with a 7-day reminder), `INITIAL_FLOW_VERSION`.
- `effectiveModeAt(ctx, flow, venueId)`: what a flow really runs at, at one venue: the stricter of `effectiveMode(flow)` and the hub's `agentMode` for the flow's agent there (`hosted_agents` / `autonomy_level_per_agent`). A venue that has not listed the flow's agent (or has the hub off) runs it at nothing; listed without a level, shadow. `runFlowAtVenue` and `sendFlowBatch` use it; `listFlows` returns it per venue as `venueModes`. The fixture venues list every flow agent at its ceiling (seeder `35-campaigns.ts`).
Settings: `getCampaignsSettings(ctx)`, `setCampaignsSettings(ctx, patch)` manager.

## Hooks
- `ledger.onTransactionRecorded`: credits the latest campaign/flow message within `attributionWindowDays` as a touch (via `identity.resolveCustomer`, then `ledger.reattributeTransaction`); a purchase exits win-back/post-purchase; enrols post-purchase (first order) and VIP (`vipOrders`).
- `identity.onConsentChanged`: marketing grant → welcome enrolment; revoke → every enrolment exits.
- `identity.onCustomerMerge`, `identity.onCustomerErase` (enrolments deleted), `identity.registerCustomerDataProvider('campaigns', …)`.
- `approvals.onApprovalDecided`: `campaigns.flow_batch` (approved → `flowBatchSendJob`), `campaigns.campaign_send` (approved → first wave; else back to draft).
- Defines hosted agents `FLOW_AGENTS` (`flow_welcome` ceiling autonomous; the rest supervised).

## Config surface
Venue: `campaignsConfig = z.object({})`. Org settings namespace `campaigns`: `campaignWaveSize` (500),
`waveIntervalMinutes` (60), `approvalTtlHours` (48), `attributionWindowDays` (7). Per flow row
(`flows.config`, `flowConfig`): `channel`, `waveSize`, `dailyCap` (autonomous), `staleAfterDays`,
`welcomeDelayMinutes`, `postPurchaseDays`, `winbackLapsedDays`, `winbackMaxLapsedDays`,
`winbackCooldownDays`, `vipOrders`, `birthdayDaysBefore`, `copy{subject, body}`.

## Jobs, schedules, events, templates, tools
- Jobs: `campaigns.flow_run`, `campaigns.flow_batch_send`, `campaigns.campaign_send`, `campaigns.expire_approvals`.
- Schedules (per org, when on at any venue): `campaigns.flow_run` hourly; `campaigns.expire_approvals` every 15 min (runs `approvals.expireApprovals`).
- Events: `campaign.drafted`, `campaign.submitted`, `campaign.wave_queued`, `campaign.sent`, `flow.enrolled`, `flow.exited`, `flow.step_queued`.
- Templates (marketing, email + sms): `campaigns.welcome`, `.post_purchase`, `.winback`, `.winback_reminder`, `.vip`, `.birthday`, `.campaign`.
- Tools: `message_draft` (write, `campaigns:write`, manager; propose/commit saves a draft only), `campaigns_summary` (read, `campaigns:read`).

## Simulated vs real
No adapter of its own. Sending is comms' outbox and message adapter; copy uses the `llm` adapter
(`purpose: 'campaigns.draft_copy'`). The connected email platform (`comms/esp.ts`) and ad conversions
(`comms/conversions.ts`) belong to comms, not here. Seeder `35-campaigns.ts`; tests `packages/modules/test/campaigns/`.

## Known gaps
- `CampaignStatus` and `listCampaignsInput` include `scheduled`, but no code sets it (no scheduled send).
- No `apps/` code calls these functions yet.
