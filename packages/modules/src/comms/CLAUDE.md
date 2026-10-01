# comms

## What it owns

The outbox for email and SMS (queue in the caller's transaction, a worker sends), templates,
sending identities, suppressions, provider delivery events and opt-outs, plus two outward
syncs: the venue's own email platform (ESP) and ad-platform purchase conversions. Spine module;
`dependsOn: ['identity']`.

Tables (`commsModule.tables`): `messages`, `message_events`, `sending_identities`,
`suppressions`, `templates`, `esp_sync_state`, `esp_sync_profiles`, `ad_conversions`.

## Public functions

Other modules:
- `queueMessage(ctx, { templateKey, channel, idempotencyKey, variables, customerId?, to?, venueId?, campaignId?, flowId?, sendAt? })` — no role check. One message per `idempotencyKey`. Marketing needs a customer with `marketing_email`/`marketing_sms` consent; no consent, no address, a suppression, or marketing email on the connected ESP tier is stored as `status: 'suppressed'` with a reason, not dropped. Transactional still goes to an unsubscribed address, never to `bounced_hard`/`complained`. Enqueues `comms.send`.
- `defineTemplate({ key, channel, kind, description, subject?, body, variables })` — email needs a subject. `getTemplateDef`, `listTemplateDefs`, `renderTemplate(ctx, key, channel, vars, frame)` (org override from `templates` wins), `fill`, `escapeHtml`, `textToHtml`.
- `optOut(ctx, channel, address, customerId, via)` — suppress and revoke the matching marketing consent.
- `isSuppressed`, `addSuppression` (bounce/complaint never downgraded to unsubscribe), `normaliseAddress`.
- `emailMarketingTier(ctx)` — `connected` only if chosen and an org-level ESP connection is live.
- `hashEmailForAds`, `hashPhoneForAds`, `conversionEventId`.

Console:
- `listMessagesForCustomer(ctx, customerId, limit?)` — staff in `GUEST_FACING_ROLES`; max 200.
- `addManualSuppression(ctx, channel, address)` — manager.
- `listSendingIdentities(ctx)` — manager. `addSendingIdentity(ctx, input, provider)` — owner; starts `pending`.
- `connectEmailPlatform(ctx, input)` / `disconnectEmailPlatform(ctx, id)` — owner. `emailPlatformStatus(ctx)`, `requestEmailPlatformSync(ctx, id)` — manager.
- `connectAdsAccount(ctx, input)` — owner. `adsConversionStatus(ctx, { venueId? })` — manager.

Platform / internal:
- `setSendingIdentityStatus(ctx, id, status)` — internal principals only (never an owner).
- `handleMessageWebhook(app, { adapterKey, rawBody, headers, url })` — verifies with `app.config.comms.webhookSecrets[adapterKey]`, claims each event, applies delivered/opened/clicked/bounced/failed/complained/unsubscribed; a STOP with no message id is matched by account.
- `unsubscribeByToken(app, orgId, token)`, `unsubscribeToken(app, orgId, messageId)` — HMAC link token; used by `apps/web/src/app/sites/[host]/u/[token]/page.tsx`.
- `syncEmailPlatform(app, { orgId, connectionId })`, `enqueueEspSyncs(app, orgId)`.

## Hooks

Defines none (templates use a registry via `defineTemplate`). Registers:
- `identity.onConsentChanged` in `suppression.ts` (revoke adds a suppression, re-grant lifts only an `unsubscribed` one) and in `esp.ts` (enqueues an ESP sync, except for opt-outs that came from the platform).
- `ledger.onTransactionRecorded` in `conversions.ts` — a completed, identified sale by a guest with `ad_platform_sharing` consent at a venue with an ads connection gets one `ad_conversions` row and a `comms.ad_conversion` job.

## Config surface

Venue config is empty. Org settings:
- `comms` (`commsSettings`): `smsQuietHours { start, end }` (default 20:00-09:00, marketing SMS deferred), `dailyMarketingEmailCap` (2000), `dailyMarketingSmsCap` (500), `replyToEmail`, `senderAddressLine` (marketing footer).
- `comms_esp` (`espSettings`): `emailMarketingTier: 'native' | 'connected'`, set by connect/disconnect.
- App config: `comms.emailAdapter`, `comms.smsAdapter`, `comms.platformSendingDomain`, `comms.platformSmsSender`, `comms.webhookSecrets`.

## Jobs, schedules, events, templates, tools

- Jobs: `comms.send` (6 attempts; defers for quiet hours and daily cap), `comms.esp_sync`, `comms.esp_sync_all`, `comms.ad_conversion` (6 attempts; re-checks consent and refund before sending).
- Schedule: `comms.esp_sync`, every 15 minutes, per org with a live ESP connection.
- Events: `message.sent`, `message.delivered`, `message.opened`, `message.clicked`, `message.bounced`, `message.unsubscribed`, `message.suppressed`, `email_platform.synced`, `ad_conversion.sent`.
- Template: `generic.notice` (email, transactional).
- Plugs: `sim-esp`, `klaviyo`, `sim-ads`, `meta-capi`. No tools.

## Simulated vs real

- Email/SMS sending: simulator only (`sim-email`, `sim-sms` in `packages/adapters/src/sim/message.ts`); no real message adapter exists.
- ESP: real `packages/adapters/src/klaviyo/` plus `sim/esp.ts`.
- Ads: real `packages/adapters/src/meta-capi/` plus `sim/ads.ts`.

## Known gaps

- `orgTemplateInput` is exported but nothing writes the `templates` table; there is no function to save an org's template override.
- Nothing in `apps/` calls `handleMessageWebhook` (no provider webhook route yet).
- `replyToEmail` is in the settings schema but the send path does not use it.
- Marketing with no verified sending identity fails the message (`no_verified_sending_identity`); verification depends on provisioning calling `setSendingIdentityStatus`.
