# auth (module key `console`)

## What it owns

Who can sign in and as what: platform users, staff and their per-venue roles, passwordless
one-time codes for staff, guests and platform admins, sessions, and paired kitchen/counter
screens (devices). Spine module; its `defineModule` key is `'console'` (name "Console access"),
not `auth`. `dependsOn: ['tenancy', 'identity']`.

Tables (`authModule.tables`): `users`, `platform_admins`, `staff`, `staff_venues`, `sessions`,
`otp_codes`, `devices`. `users`, `sessions`, `otp_codes` and `platform_admins` are read and
written through `app.db` (outside the tenant role).

Constants: `SESSION_TTL_DAYS` (staff 14, guest 30, platform 1), `OTP_TTL_MINUTES` (10),
`OTP_MAX_ATTEMPTS` (5).

## Public functions

Sign-in (take `App`; no tenant yet):
- `requestStaffLogin(app, email, meta?)` / `verifyStaffLogin(app, email, code, meta?)` — answers the same whether or not the address exists; first sign-in turns `invited` staff `active`; session's `activeOrgId` is set only if the person belongs to exactly one org.
- `requestPlatformLogin(app, email, meta?)` / `verifyPlatformLogin(app, email, code, meta?)` — `platform_admins` only.
- `requestGuestLogin(app, orgId, destination, meta?)` / `verifyGuestLogin(app, orgId, destination, code, { visitorSessionId?, venueId?, ip?, userAgent? })` — email or SMS code; resolves or creates the customer with `verified: true`, stamps acquisition from the visitor session, links the session to the customer.
- `requestOpenLogin(app, email, meta?)` / `verifyOpenLogin(app, email, code, meta?)` — the open front door (self-serve start): a code goes to any address, and a correct one creates the `users` row if there is none and a staff session with no org. The person belongs to nothing until `onboarding.selfServeStart` or an invitation.
- `issueOtp`, `verifyOtp`, `parseDestination`, `badCode` — the code primitives. OTPs are hashed at rest, rate-limited (5 per destination and 30 per IP per 15 min), sent straight to the message adapter (never via the outbox), single use.

Sessions (take `App`):
- `createSession`, `resolveSession`, `revokeSession(app, token)`, `revokeUserSessions(app, userId, orgId?)`.
- `authenticate(app, token)` — session to `{ orgId, principal, session }`; a staff session with no org chosen yields an empty staff principal and `orgId: null`.
- `selectOrg(app, token, orgId)` — membership checked in the database.
- `membershipsOf(app, userId)`, `staffPrincipal(app, userId, orgId)` — principal built from the database only; owners hold every venue.

Console:
- `listStaff(ctx)` — manager.
- `inviteStaff(ctx, { email, firstName, lastName?, phone?, isOwner, roles })` — manager; `isOwner` needs owner; a non-owner cannot grant manager or owner, and only at venues they manage. Queues the `staff.invite` email.
- `setStaffRoles(ctx, staffId, { roles })` — owner; refuses owners.
- `disableStaff(ctx, staffId)` — owner; not yourself, not the last owner. Runs `onStaffDisabled` handlers, then revokes the person's sessions at this org after commit.
- `createDevicePairing(ctx, { venueId, name, purpose: 'kitchen' | 'counter' })` — manager; 8-char code, 15 minutes.
- `listDevices(ctx, venueId)`, `revokeDevice(ctx, deviceId)` — manager at the venue.

Device:
- `pairDevice(app, code, { ip? })` — redeems the code for a `ros_d_` token (10 tries per IP per 10 min).
- `authenticateDevice(app, token)` — `{ orgId, principal: { kind: 'device', deviceId, venueId, purpose } }`.

Role values: `owner`, `manager`, `host`, `kitchen`, `front_of_house`, `read_only`.

## Hooks

Defined: `onStaffDisabled(handler)` — same transaction as the disable. Registered by
`hub/keys.ts` (revokes the person's assistant keys). Registers on none.

## Config surface

Venue config is empty. No org settings. Uses app config `comms.emailAdapter`,
`comms.smsAdapter`, `comms.platformSendingDomain`, `comms.platformSmsSender`, `platformHost`, `scheme`.

## Jobs, schedules, events, templates, tools

- Template: `staff.invite` (email, transactional; `first_name`, `inviter`, `console_url`).
- Audit: `staff.invited`, `staff.roles_set`, `staff.disabled`, `device.pairing_started`, `device.revoked`.
- Tool: `team_invite` (write, scope `team:write`, `minRole: 'manager'`, propose/commit over `inviteStaff`; any role but owner).
- No jobs, schedules or events.

## Simulated vs real

OTP delivery calls the message adapter named in app config; only the simulators `sim-email`
and `sim-sms` exist (`packages/adapters/src/sim/message.ts`), so codes are not really delivered yet.

## Known gaps

- No function to grant or remove owner status on an existing staff member (`setStaffRoles` says "Remove owner status first" but nothing does that), and no re-enable for a disabled staff member.
- No cleanup of expired `sessions` or `otp_codes` rows.
