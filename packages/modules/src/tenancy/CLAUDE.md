# tenancy

## What it owns

Orgs, venues, domains (host to tenant), weekly trading hours and one-off exceptions, and
org-level settings. Spine module (always on, no `venue_modules` row), no dependencies.

Tables (`tenancyModule.tables`): `orgs`, `venues`, `domains`, `trading_hours`, `hour_exceptions`,
`venue_modules`, `feature_flags`, `connections`. Note: the code that reads and writes
`venue_modules` (`getModule`, `assertModule`, `setModule`) and `connections` (`listConnections`,
`loadConnection`, `onConnectionRevoked` …) lives in `packages/core/src/modules.ts` and
`packages/core/src/connections.ts`, not here. Nothing in the repo uses `feature_flags` yet.

## Public functions

Platform / internal (bypass RLS, no role check):
- `createOrg(pctx, input)` — org + first venue + owner user/staff (`staff_venues` role `owner`) + verified primary subdomain `<slug>.<tenantRootDomain>`; switches on the non-spine modules named in `input.modules` (dependencies must be listed too). Reserved slugs refused. Used by fixtures and `onboarding/steps.ts`.
- `setOrgStatus(pctx, orgId, status)` — `onboarding | live | paused | closed`. Used by fixtures and onboarding go-live / offboarding.
- `listActiveOrgs(app)` — ids, slugs, time zones of `onboarding`/`live` orgs, for schedulers.
- `resolveHost(app, host)` — host to `{ orgId, venueId, primaryHost, orgStatus }`, verified hosts only; 30 s in-process cache. `clearHostCache()` empties it.
- `markDomainVerified(ctx, domainId, providerDomainId?)` — principal must be `platform` or `worker` (never an owner); makes the domain primary.

Console:
- `getOrg(ctx)` — no role check. `updateOrg(ctx, input)` — owner.
- `getOrgSettings(ctx, namespace, schema, fallback)` — no role check; a stored value that fails the schema returns `fallback`. `setOrgSettings(ctx, namespace, schema, value)` — manager (any venue).
- `listVenues(ctx)` — staff; only venues the caller has a role at.
- `createVenue(ctx, input)` — owner; every owner gets `owner` at the new venue.
- `updateVenue(ctx, venueId, input)` — manager at that venue; also sets `status`.
- `setTradingHours(ctx, venueId, hours)` — manager; replaces the week. A period past midnight has `closesAt < opensAt`.
- `setHourException(ctx, venueId, input)` / `removeHourException(ctx, venueId, date)` — manager.
- `listDomains(ctx)`, `addCustomDomain(ctx, { host, venueId? })`, `removeDomain(ctx, domainId)` — owner. A custom domain serves nothing until verified; the platform subdomain cannot be removed.

Public / any principal (no role check, RLS scopes to the org):
- `getVenue(ctx, venueId)`, `getVenueBySlug(ctx, slug)`, `listPublicVenues(ctx)` (status `live`/`setup`).
- `getTradingHours(ctx, venueId)`, `listHourExceptions(ctx, venueId, from, to)`.
- `openWindows(ctx, venueId, date)` — open periods on a venue-local date as instants; an exception replaces the weekly hours.
- `isOpenAt(ctx, venueId, at)` — counts a late period that began the previous day.

Plugins (plugins.ts; docs/PIPEDLINE.md section 2). All need manager at the venue:
- `listPlugins(ctx, venueId)` — every module and plug: purpose, `needs`, on or off, settings, and the settings as JSON Schema (`z.toJSONSchema` of the module's own schema).
- `enablePlugin` / `configurePlugin` / `disablePlugin(ctx, { venueId, plugin, config? })` — core `setModule` behind a check that names an unknown setting or an invalid value in words. `planPluginChange(ctx, input, want)` is the same check without the write (what a tool's question is built from). A spine module is refused for enable/disable; one with org settings is configured through its own setter. A module with `assistantConfigurable: false` (the hub) is refused to `agent` principals.
- `registerOrgPluginSettings({ module, schema, get, set })` — a spine module's org-level settings, listed and changed as that plugin's settings (analytics registers). `onPluginEnabled(fn)` — hook, in the transaction that switched a module on (onboarding requeues that module's provisioning steps).
Quota (quota.ts): `getOrgQuota(ctx)`, `writeOrgQuota(ctx, patch)` (platform and worker principals only), `assertVenueQuota(ctx)`; `orgs.settings.quota.max_venues`, default 5. `createVenue` refuses a staff caller past it. `setOrgSettings` refuses the `quota` namespace.
`getPrimaryHost(ctx, venueId?)` — the verified host a venue's public site answers on; no role check.

Also exported: the zod inputs `createOrgInput`, `updateOrgInput`, `venueInput`, `updateVenueInput`, `tradingHoursInput`, `hourExceptionInput`, `customDomainInput`.

## Hooks

Defines `onPluginEnabled`. Registers on none. (`onConnectionRevoked` is defined in core, not here.)

## Config surface

Venue config schema is empty (`z.object({})`). Org settings: this module provides the
`orgs.settings` namespaced store. Namespaces in use elsewhere: `comms`, `analytics`, the ESP
namespace in `comms/esp.ts`, the campaigns namespace in `campaigns/settings.ts`, the hub LLM and
hub rate-limit namespaces in `hub/`.

## Jobs, schedules, events, templates, tools

- Tools: `venue_status` (read, scope `venue:read`: open now, today's periods, modules on, connection health) and `hours_set_exception` (write, scope `venue:write`, `minRole: 'manager'`, propose/commit over `setHourException`).
- Setup tools (setup-tools.ts): `venue_describe` (read, `venue:read`), `venue_update` (write, `venue:write`, manager: `updateVenue` + `setTradingHours`), `plugins_list` (read, `plugins:read`, manager), `plugin_enable` / `plugin_configure` / `plugin_disable` (write, `plugins:write`, manager), `connections_list` (read, `connections:read`).
- No jobs, schedules, events or templates.
- Audit actions: `org.updated`, `org.settings`, `venue.created`, `venue.updated`, `hours.set`, `hours.exception_set`, `hours.exception_removed`, `domain.added`, `domain.verified`, `domain.removed`.

## Simulated vs real

No provider calls. Custom-domain verification is expected to come from the hosting provider
via provisioning calling `markDomainVerified`; there is no hosting adapter in this module.

## Known gaps

- `feature_flags` is listed as owned but no code reads or writes it.
- `resolveHost` caches per process for 30 s; only `markDomainVerified` and `removeDomain` clear it (on this process). `addCustomDomain` does not need to, since unverified hosts never resolve.
- `setOrgSettings` checks manager at any venue, not owner, and does not stop one module writing another's namespace; that is convention.
