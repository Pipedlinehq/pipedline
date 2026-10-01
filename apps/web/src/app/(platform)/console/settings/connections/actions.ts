'use server';

import { randomBytes } from 'node:crypto';
import { redirect } from 'next/navigation';
import { getPlug, requireStaff, revokeConnection } from '@ros/core';
import { simPosToken } from '@ros/adapters';
import { comms, hub, ledger } from '@ros/modules';
import { runAction } from '@/lib/actions';
import { getConsole, inConsole } from '@/lib/console';
import { scopesFor, signInPosPlug } from '@/lib/pos-signin';
import { act, actApp, int, text, type DataFormState } from '@/lib/console-actions';
import { app } from '@/lib/runtime';
import type { FormState } from '@/ui/client';
import { dateTime } from '@/ui/format';

const PATH = '/console/settings/connections';

/**
 * What the provider is called with. A real point of sale hands over a token (typed here, or from
 * its own sign-in). The simulated one has no sign-in to hand anything over, so outside production
 * its credentials are made here the way its sign-in would: the token the simulator expects for
 * that account, and a webhook secret of the connection's own.
 */
function credentialsFrom(fd: FormData, opts: { forConnection?: boolean } = {}): Record<string, string> {
  const token = text(fd, 'accessToken');
  if (token) return { accessToken: token };
  let plug;
  try {
    plug = getPlug(text(fd, 'plugKey'));
  } catch {
    return {};
  }
  if (plug.simulated && plug.adapters.pos && app().config.env !== 'production') {
    return { accessToken: simPosToken(text(fd, 'externalAccountId')), ...(opts.forConnection ? { webhookSecret: `simpos-whsec-${randomBytes(18).toString('hex')}` } : {}) };
  }
  return {};
}

type Located = { plugKey: string; externalAccountId: string; locations: Array<{ ref: string; name: string }> };

/** Step one of connecting a POS: ask the provider for the account's locations. Touches no tenant data. */
export async function findPosLocations(_prev: DataFormState<Located>, fd: FormData): Promise<DataFormState<Located>> {
  const plugKey = text(fd, 'plugKey');
  const externalAccountId = text(fd, 'externalAccountId');
  // Only a manager of the selected venue may start this; the connect step checks it again.
  const gate = await act((ctx, c) => Promise.resolve(void requireStaff(ctx, { venueId: c.venue.id, minRole: 'manager' })), { revalidate: [] });
  if (!gate.ok) return gate;
  if (!externalAccountId) return { ok: false, error: 'Enter the account or merchant ID.' };
  const r = await runAction(() => ledger.listPosLocations(app(), { plugKey, externalAccountId, credentials: credentialsFrom(fd) }));
  if (!r.ok) return { ok: false, error: r.error };
  return { ok: true, data: { plugKey, externalAccountId, locations: r.data.map((l) => ({ ref: l.ref, name: l.name })) } };
}

export async function connectPosLocation(_prev: FormState, fd: FormData): Promise<FormState> {
  return act(
    (ctx, c) =>
      ledger.connectPos(ctx, {
        plugKey: text(fd, 'plugKey'),
        venueId: c.venue.id,
        externalAccountId: text(fd, 'externalAccountId'),
        locationRef: text(fd, 'locationRef'),
        credentials: credentialsFrom(fd, { forConnection: true }),
        backfillMonths: int(fd, 'backfillMonths') ?? 0,
      }),
    { success: (v) => `Connected. Sales from ${getPlug(v.plugKey).name} now reach the ledger${v.backfillingFrom ? '; past sales are being fetched' : ''}.`, revalidate: PATH },
  );
}

// ── A point of sale connected by signing in at the provider (Square) ─────────

/**
 * Begin the sign-in: the service checks the role and makes the signed `state`; the browser is
 * then sent to the provider. The venue is the console's selected one, never a form field.
 * What comes back is handled by /console/connections/<plug>/callback.
 */
export async function startPosSignIn(_prev: FormState, fd: FormData): Promise<FormState> {
  const plugKey = text(fd, 'plugKey');
  const r = await runAction(() =>
    inConsole((ctx, c) => ledger.startPosOAuth(ctx, { plugKey, venueId: c.venue.id, scopes: scopesFor(plugKey, text(fd, 'access')), backfillMonths: int(fd, 'historyMonths') ?? 0 })),
  );
  if (!r.ok) return { ok: false, error: r.error };
  redirect(r.data.url);
}

/** End a sign-in connection: revoked here first, then the access is ended at the provider. */
export async function disconnectPosSignIn(_prev: FormState, fd: FormData): Promise<FormState> {
  const connectionId = text(fd, 'connectionId');
  // Only for the sentence that answers: a name from the catalogue, never text from the form.
  const service = signInPosPlug(text(fd, 'plugKey'))?.name ?? 'the point of sale';
  const { session } = await getConsole();
  return actApp(() => ledger.disconnectPosOAuth(app(), { orgId: session.orgId, principal: session.principal, connectionId }), {
    success: (r) =>
      r.revokedAtProvider
        ? `Disconnected. Sales have stopped arriving, the stored sign-in was destroyed, and our access at ${service} has been ended.`
        : `Disconnected. Sales have stopped arriving and the stored sign-in was destroyed. ${service} could not be told just now: our access there ends on its own within 30 days, or straight away if you remove the app in your ${service} account.`,
    revalidate: PATH,
  });
}

export async function connectAssistantPlug(_prev: FormState, fd: FormData): Promise<FormState> {
  return act(
    (ctx) => hub.connectMcpPlug(ctx, { plugKey: text(fd, 'plugKey'), accessKey: text(fd, 'accessKey'), account: text(fd, 'account') || 'default', venueId: null }),
    { success: 'Connected. We check the key with the service in the background; switch its tools on for assistants under Features → Assistant access.', revalidate: PATH },
  );
}

export async function revoke(_prev: FormState, fd: FormData): Promise<FormState> {
  const id = text(fd, 'connectionId');
  return act((ctx) => revokeConnection(ctx, id), { success: 'Disconnected. Its stored credentials were destroyed.', revalidate: PATH });
}

export async function fetchHistory(_prev: FormState, fd: FormData): Promise<FormState> {
  const connectionId = text(fd, 'connectionId');
  const months = int(fd, 'months') ?? 3;
  return act((ctx) => ledger.requestPosBackfill(ctx, { connectionId, months }), { success: `Fetching the last ${months} months of sales. It runs in the background.`, revalidate: PATH });
}

/** Ask every assistant plug whether it still accepts its key. The check itself runs as the platform, so the role check is made here first. */
export async function checkPlugs(_prev: FormState, _fd: FormData): Promise<FormState> {
  const gate = await act((ctx, c) => Promise.resolve(void requireStaff(ctx, { venueId: c.venue.id, minRole: 'manager' })), { revalidate: [] });
  if (!gate.ok) return gate;
  const { session } = await getConsole();
  return actApp(() => hub.checkPlugConnections(app(), session.orgId), {
    success: (checks) =>
      checks.length === 0
        ? 'No assistant plugs are connected.'
        : checks.map((c) => `${getPlug(c.plug).name}: ${c.reachable === 'yes' ? 'answering' : c.reachable === 'refused' ? 'refused the key' : 'could not be reached'}${c.pinned === 'changed' ? ', tools changed since review' : ''}`).join('. ') + '.',
    revalidate: PATH,
  });
}

// ── The organisation's own email platform ───────────────────────────────────

export async function connectEmailPlatform(_prev: FormState, fd: FormData): Promise<FormState> {
  const r = await act(
    (ctx) =>
      comms.connectEmailPlatform(ctx, {
        plugKey: text(fd, 'plugKey'),
        externalAccountId: text(fd, 'externalAccountId'),
        credentials: { apiKey: text(fd, 'apiKey') },
        tier: text(fd, 'tier') === 'native' ? 'native' : 'connected',
      }),
    {
      success: (s) => `${s.name} connected. ${s.tier === 'connected' ? 'It sends your marketing email from now on' : 'We keep sending your marketing email; it is kept in step'}, and the first sync has started.`,
      revalidate: PATH,
    },
  );
  // Only the outcome goes back to the browser.
  return r.ok ? { ok: true, message: r.message } : r;
}

export async function syncEmailPlatform(_prev: FormState, fd: FormData): Promise<FormState> {
  return act((ctx) => comms.requestEmailPlatformSync(ctx, text(fd, 'connectionId')), { success: 'A sync has been queued. It runs in the background.', revalidate: PATH });
}

export async function disconnectEmailPlatform(_prev: FormState, fd: FormData): Promise<FormState> {
  return act((ctx) => comms.disconnectEmailPlatform(ctx, text(fd, 'connectionId')), { success: 'Disconnected. Marketing email is sent by us again, and the stored key was destroyed.', revalidate: PATH });
}

// ── Ad platform conversions ─────────────────────────────────────────────────

export async function connectAdsAccount(_prev: FormState, fd: FormData): Promise<FormState> {
  const r = await act(
    (ctx, c) =>
      comms.connectAdsAccount(ctx, {
        plugKey: text(fd, 'plugKey'),
        venueId: text(fd, 'scope') === 'org' ? null : c.venue.id,
        externalAccountId: text(fd, 'externalAccountId'),
        credentials: { accessToken: text(fd, 'accessToken') },
      }),
    { success: 'Connected. Purchases by guests who agreed to ad-platform sharing are reported from now on; nobody else’s are.', revalidate: PATH },
  );
  return r.ok ? { ok: true, message: r.message } : r;
}

// ── A key for a connected service (Criota) to read outcomes with ────────────

type MadeServiceKey = { key: string; name: string; expiresAt: string; service: string };

/** The key goes back in this response only, to the one browser that asked. */
export async function createServiceKey(_prev: DataFormState<MadeServiceKey>, fd: FormData): Promise<DataFormState<MadeServiceKey>> {
  return act(
    async (ctx, c) => {
      const made = await hub.createServiceKey(ctx, { connectionId: text(fd, 'connectionId'), name: text(fd, 'name') || undefined, expiresInDays: int(fd, 'expiresInDays') ?? 30 });
      return { key: made.key, name: made.view.name, service: text(fd, 'service'), expiresAt: dateTime(made.view.expiresAt, c.venue.timezone, { date: true, time: false }) };
    },
    { revalidate: PATH },
  );
}
