# approvals

## What it owns

One queue of things a person must approve before they happen (a campaign send, a batch of
flow messages, a review reply). The module that asks registers what to do when the item is
decided; the decision and its consequence commit in one transaction. Spine module, no
dependencies. All code is in `index.ts`.

Tables (`approvalsModule.tables`): `approvals`.

## Public functions

Other modules:
- `onApprovalDecided(kind, handler)` — register the handler for a kind (one per kind; a registry, so a second registration for the same kind is refused by `register`). Must be registered before `requestApproval` is called for that kind.
- `requestApproval(ctx, { kind, subjectType, subjectId, summary, payload?, venueId?, expiresAt? })` — no role check beyond refusing `anon`, `guest` and `device` principals (staff, agents and workers may ask). Throws if no handler is registered for `kind`. One pending approval per `(kind, subjectType, subjectId)`: asking again returns the pending one. `summary` is the plain-words description shown to the approver.

Console:
- `listApprovals(ctx, { status?, kind?, venueId? })` — manager (at `venueId` if given); org-wide rows (`venue_id` null) plus visible venues; max 200, newest first.
- `getApproval(ctx, id)` — manager at the approval's venue (any venue if org-wide).
- `decideApproval(ctx, id, { decision: 'approved' | 'rejected', note? })` — manager at the approval's venue; an `agent` principal is refused (`invalid`), so an assistant can queue but never grant. Already decided or past `expiresAt` is `conflict`. Runs the kind's handler in the same transaction; if it throws, the approval stays pending.

Platform / internal:
- `expireApprovals(ctx)` — marks due pending rows `expired` and calls each handler with `'expired'`. No role check. Scheduled by `campaigns/jobs.ts` (`campaigns.expire_approvals`, every 15 minutes).

Types: `Approval` (`status: 'pending' | 'approved' | 'rejected' | 'expired'`), `RequestApprovalInput`.

## Hooks

Defined: `onApprovalDecided(kind, handler)` receives `(ctx, approval, 'approved' | 'rejected' | 'expired')`.
Registered kinds today:
- `campaigns.campaign_send` (`CAMPAIGN_SEND_APPROVAL`, `campaigns/campaigns.ts`, handler in `campaigns/hooks.ts`)
- `campaigns.flow_batch` (`FLOW_BATCH_APPROVAL`, `campaigns/flows.ts`, handler in `campaigns/hooks.ts`)
- `reviews.reply` (`REVIEW_REPLY_APPROVAL`, `reviews/replies.ts`)

Registers on none.

## Config surface

Venue config is empty. No org settings.

## Jobs, schedules, events, templates, tools

- Events: `approval.requested` (`approval_id`, `kind`), `approval.decided` (`approval_id`, `kind`, `decision: approved | rejected | expired`).
- Audit: `approval.approved`, `approval.rejected` (expiry is tracked as an event, not audited).
- No jobs, schedules, templates or tools of its own.

## Simulated vs real

No providers.

## Known gaps

- The only schedule that runs `expireApprovals` belongs to campaigns and applies only to orgs where campaigns is on at some venue (`campaignsOnSomewhere`). A `reviews.reply` approval with an `expiresAt` in an org without campaigns is not expired by anything.
- No console route in `apps/` calls `listApprovals` or `decideApproval` yet; decisions happen in tests and the campaigns fixture seeder.
- This module notifies nobody when an approval is requested; it waits in the list unless the requesting module tells someone.
