import { type Ctx, findConnectionFor, getModule, getPlug, listModuleDefs, listPlugs, requireOwner } from '@ros/core';
import { getMenuEditor } from '../menu/edit';
import { orderingModule } from '../ordering/module';
import { qrModule } from '../qr/module';
import { getPrimaryHost } from '../tenancy/domains';
import { getTradingHours } from '../tenancy/hours';
import { getOrg } from '../tenancy/orgs';
import { onPluginEnabled } from '../tenancy/plugins';
import { getVenue } from '../tenancy/venues';
import { type ChecklistItem, getOwnGoLiveChecklist } from './golive';
import { menuImportStanding } from './menu-import';
import { requeueStepsForModule } from './provisioning';

/**
 * Where a venue's setup stands, as one answer (docs/PIPEDLINE.md `setup_status`): what is done,
 * what is next in plain words, and what only the owner can answer. It is written to be enough,
 * by itself, for an assistant that has never seen this platform to drive the whole setup: each
 * step names the tools that do it, and `next` is one instruction.
 *
 * It decides nothing of its own. Every fact is read through the function that owns it: the
 * venue and its hours (tenancy), the plugins (the module catalogue), connections (core), the
 * menu and its imports, and the go-live checklist, which stays the only gate on going live.
 */
export type SetupStepStatus = 'done' | 'to_do' | 'waiting' | 'optional';

export interface SetupStep {
  key: string;
  title: string;
  status: SetupStepStatus;
  /** What is true now, and what to do about it. */
  detail: string;
  /** Assistant tools that do this step, in the order to use them. */
  tools: string[];
  /** True when it needs something only the owner has or can do: an answer, a sign-in, a yes. */
  ownerOnly: boolean;
}

export interface SetupStatus {
  organisation: { name: string; status: string };
  venue: { name: string; status: string };
  siteAddress: string | null;
  /** True once the organisation is live: there is nothing left to set up. */
  complete: boolean;
  summary: string;
  steps: SetupStep[];
  next: { step: string; whatToDo: string; tools: string[] } | null;
  /** Questions to put to the owner: things nobody else knows. */
  askTheOwner: string[];
  /** The failing go-live checks, when the venue is not live yet. */
  blockingGoLive: Array<{ check: string; reason: string }>;
}

// A module switched on after provisioning ran gets what it needs set up (default pages, a default programme …).
onPluginEnabled(async (ctx, { moduleKey }) => void (await requeueStepsForModule(ctx, moduleKey)));

const plural = (n: number, one: string, many: string) => `${n} ${n === 1 ? one : many}`;

/** The services a venue can connect by signing in that supply `kind`, by name. */
function signInServices(ctx: Ctx, kind: 'pos' | 'payment'): string[] {
  return listPlugs()
    .filter((p) => p.auth === 'oauth' && p.adapters[kind] && !(p.simulated && ctx.app.config.env === 'production'))
    .map((p) => p.name);
}

/** Owner only, as the go-live checklist is. */
export async function getSetupStatus(ctx: Ctx, venueId: string): Promise<SetupStatus> {
  requireOwner(ctx);
  const venue = await getVenue(ctx, venueId);
  const org = await getOrg(ctx);
  const hours = await getTradingHours(ctx, venue.id);
  const host = await getPrimaryHost(ctx, venue.id);
  const onboarding = await ctx.db.selectFrom('onboardings').select(['id', 'status', 'origin']).executeTakeFirst();
  const live = org.status === 'live';
  const steps: SetupStep[] = [];
  const ask: string[] = [];

  // 1 · the venue's details
  const missing = [!venue.addressLine1 && 'street address', !venue.suburb && 'suburb', !venue.state && 'state', !venue.postcode && 'postcode', !venue.phone && 'phone number'].filter((m): m is string => !!m);
  if (missing.length) ask.push(`What is the venue's ${missing.join(', ')}?`);
  steps.push({
    key: 'venue_details',
    title: 'The venue\'s details',
    status: missing.length ? 'to_do' : 'done',
    detail: missing.length ? `Still missing: ${missing.join(', ')}. Ask the owner, then save them. Check the name and time zone (${venue.timezone}) with them too.` : `${venue.name}, ${venue.addressLine1}, ${venue.suburb} ${venue.state} ${venue.postcode}. Time zone ${venue.timezone}.`,
    tools: ['venue_describe', 'venue_update'],
    ownerOnly: missing.length > 0,
  });

  // 2 · opening hours
  if (!hours.length) ask.push('What are the opening hours, day by day?');
  steps.push({
    key: 'opening_hours',
    title: 'Opening hours',
    status: hours.length ? 'done' : 'to_do',
    detail: hours.length ? `${plural(hours.length, 'opening period is', 'opening periods are')} set for the week.` : 'No opening hours are set. Ask the owner for each day\'s hours and save the whole week in one call (venue_update, `hours`).',
    tools: ['venue_update'],
    ownerOnly: !hours.length,
  });

  // 3 · plugins
  const on: Array<{ key: string; name: string }> = [];
  for (const def of listModuleDefs()) {
    if (def.spine || def.key.startsWith('test_')) continue;
    if ((await getModule(ctx, venue.id, def)).enabled) on.push({ key: def.key, name: def.name });
  }
  const chosen = on.filter((m) => m.key !== 'hub');
  const pos = await findConnectionFor(ctx, 'pos', venue.id);
  const payment = await findConnectionFor(ctx, 'payment', venue.id);
  const pluginsDone = chosen.length > 0 || !!pos;
  if (!pluginsDone) ask.push('What do you want this to do for the venue: a QR menu, online ordering, a website, loyalty, or only answers from the till you already use?');
  steps.push({
    key: 'plugins',
    title: 'Choose what to switch on',
    status: pluginsDone ? 'done' : 'to_do',
    detail: chosen.length
      ? `Switched on: ${chosen.map((m) => m.name).join(', ')}. More can be switched on, changed or switched off at any time.`
      : pos
        ? 'Nothing is switched on beyond the built-in parts; the till is connected, which is a complete setup by itself. Plugins can be added at any time.'
        : 'Nothing is switched on yet. Read plugins_list, tell the owner what each plugin does and needs, and switch on what they choose with plugin_enable (its settings follow the plugin\'s settings_schema). Analytics is built in and already on.',
    tools: ['plugins_list', 'plugin_enable', 'plugin_configure', 'plugin_disable'],
    ownerOnly: !pluginsDone,
  });

  // 4 · connections
  const qr = await getModule(ctx, venue.id, qrModule);
  const takesPayment = on.some((m) => m.key === orderingModule.key) || (qr.enabled && qr.config.stage === 'order');
  const services = signInServices(ctx, takesPayment ? 'payment' : 'pos');
  const connected = [...new Set([pos, payment].filter((c) => !!c).map((c) => getPlug(c!.plug_key).name))];
  const needsConnection = takesPayment && !payment;
  steps.push({
    key: 'connections',
    title: 'Connect the till and payments',
    status: needsConnection ? 'to_do' : connected.length ? 'done' : 'optional',
    detail: needsConnection
      ? `Taking orders needs a payment account, and none is connected. Call connection_start${services.length ? ` (${services.join(' or ')})` : ''}, give the owner the link it returns, and they sign in there and approve. Then check connections_list.`
      : connected.length
        ? `${connected.join(', ')} ${connected.length === 1 ? 'is' : 'are'} connected.`
        : `Optional: nothing switched on needs a connected service. To bring the till's sales in${services.length ? ` (${services.join(' or ')})` : ''}, call connection_start and give the owner the link.`,
    tools: ['connections_list', 'connection_start'],
    ownerOnly: needsConnection,
  });

  // 5 · the menu
  const editor = await getMenuEditor(ctx, venue.id);
  const itemCount = editor.menus.filter((m) => m.isActive).flatMap((m) => m.sections.flatMap((s) => s.items)).length;
  const imports = await menuImportStanding(ctx, venue.id);
  const reading = imports.pending > 0 && imports.waitingItems === 0;
  const menuStatus: SetupStepStatus = imports.waitingItems ? 'to_do' : reading ? 'waiting' : itemCount ? 'done' : 'to_do';
  if (menuStatus === 'to_do' && !imports.waitingItems) ask.push('Where is your menu? Give the address of a web page that lists it, or paste the menu as text.');
  if (imports.waitingItems) ask.push('Are the imported menu items right, and have you checked each one\'s allergens against the kitchen\'s own list?');
  steps.push({
    key: 'menu',
    title: 'The menu',
    status: menuStatus,
    detail: imports.waitingItems
      ? `${plural(imports.waitingItems, 'imported item waits', 'imported items wait')} for a yes or a no. Read them with menu_import_review, go through them with the owner (prices and allergens), then menu_import_confirm.`
      : reading
        ? 'The menu is being read. Call menu_import_review in a minute.'
        : itemCount
          ? `${plural(itemCount, 'item is', 'items are')} on the menu.`
          : `There is no menu yet.${imports.failed ? ' The last import could not be read.' : ''} Ask the owner for the address of a page that lists their menu, or for the menu as text, and call menu_import_start.`,
    tools: ['menu_import_start', 'menu_import_review', 'menu_import_confirm'],
    ownerOnly: menuStatus === 'to_do',
  });

  // 6 · the team (never required)
  steps.push({
    key: 'team',
    title: 'Invite the team',
    status: 'optional',
    detail: 'Optional: add managers and staff with team_invite. Each person signs in with their own email address.',
    tools: ['team_invite'],
    ownerOnly: false,
  });

  // 7 · going live: the checklist is the gate, and each failing check says how it is put right.
  let failing: ChecklistItem[] = [];
  let goLive: SetupStep;
  if (live) {
    goLive = { key: 'go_live', title: 'Go live', status: 'done', detail: `${org.tradingName} is live${host ? ` at ${ctx.app.config.scheme}://${host}` : ''}.`, tools: [], ownerOnly: false };
  } else if (!onboarding) {
    goLive = { key: 'go_live', title: 'Go live', status: 'waiting', detail: 'This organisation is being set up with the platform team, who take it live.', tools: [], ownerOnly: false };
  } else {
    const checklist = await getOwnGoLiveChecklist(ctx);
    failing = checklist.items.filter((i) => i.status === 'fail');
    const byPlatform = onboarding.origin !== 'self_serve';
    goLive = {
      key: 'go_live',
      title: 'Go live',
      status: failing.length ? 'to_do' : byPlatform ? 'waiting' : 'to_do',
      detail: failing.length
        ? `Not ready: ${plural(failing.length, 'check fails', 'checks fail')}. ${failing.map((f) => `${f.label}: ${f.reason}${f.fix ? ` To fix: ${f.fix.how}` : ''}`).join(' ')}`
        : byPlatform
          ? 'Every check passes. The platform team takes this organisation live.'
          : 'Every check passes. Ask the owner whether to go live now, then call go_live. Until then the venue is a draft and its site is not public.',
      tools: ['go_live_check', 'go_live_confirm', 'go_live_test_email', 'go_live'],
      ownerOnly: true,
    };
    for (const f of failing) if (f.needsOwnerConfirmation && !f.confirmedAt) ask.push(`Do you confirm: ${f.label.toLowerCase()}?`);
  }
  steps.push(goLive);

  // What to do next: the first step that is waiting on someone, in order.
  const before = steps.filter((s) => s.key !== 'go_live');
  const todo = before.find((s) => s.status === 'to_do');
  const waiting = before.find((s) => s.status === 'waiting');
  let next: SetupStatus['next'] = null;
  if (live) next = null;
  else if (todo) next = { step: todo.key, whatToDo: todo.detail, tools: todo.tools };
  else if (waiting) next = { step: waiting.key, whatToDo: waiting.detail, tools: waiting.tools };
  else if (failing.length) {
    // The earlier steps are done, so what fails now is a go-live check: take the first one that has a way forward.
    const f = failing[0]!;
    next = { step: 'go_live', whatToDo: `${f.label}: ${f.reason}${f.fix ? ` ${f.fix.how}` : ''}${f.fix?.ownerOnly ? ' Only the owner can do this; tell them, then call go_live_check.' : ''}`, tools: [...(f.fix?.tool ? [f.fix.tool] : []), 'go_live_check'] };
  } else if (goLive.status === 'to_do') next = { step: 'go_live', whatToDo: goLive.detail, tools: ['go_live'] };
  else next = { step: 'go_live', whatToDo: goLive.detail, tools: [] };

  const done = steps.filter((s) => s.status === 'done').length;
  const needed = steps.filter((s) => s.status !== 'optional').length;
  return {
    organisation: { name: org.tradingName, status: org.status },
    venue: { name: venue.name, status: venue.status },
    siteAddress: host ? `${ctx.app.config.scheme}://${host}` : null,
    complete: live,
    summary: live
      ? `Setup is complete: ${org.tradingName} is live. Plugins, settings, the menu and the team can still be changed at any time.`
      : `${venue.name} is a draft: ${done} of ${needed} setup steps are done. It is not public until it goes live.`,
    steps,
    next,
    askTheOwner: live ? [] : ask,
    blockingGoLive: failing.map((f) => ({ check: f.key, reason: f.reason })),
  };
}
