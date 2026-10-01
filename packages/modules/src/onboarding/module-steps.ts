import { type App, type Ctx, findConnectionFor, getModule, invalid, isAppError, setModule } from '@ros/core';
import { getLoyaltySummary } from '../loyalty/reads';
import { getProgram, saveProgram } from '../loyalty/program';
import { loyaltyModule } from '../loyalty/module';
import { getMenuEditor } from '../menu/edit';
import { orderingModule } from '../ordering/module';
import { listOrders } from '../ordering/orders';
import { createTableCodes } from '../qr/codes';
import { qrModule } from '../qr/module';
import { listRedirects, normaliseRedirectFrom } from '../website/redirects';
import { type CheckResult, registerGoLiveCheck } from './golive';
import { intakeVenueSlugs } from './intake';
import { menuImportStanding, requestMenuImport } from './menu-import';
import { PROVISIONER } from './platform';
import { type ProvisioningState, type StepOutcome, registerProvisioningStep } from './provisioning';

/**
 * Provisioning steps and go-live checks for the modules beyond the spine and the website
 * (docs/ONBOARDING.md sections 3 and 4). Each calls the module's own published functions as the
 * provisioner; none touches another module's tables. A step that waits on the venue says what
 * the venue has to do, in words it can act on, and is picked up again by the ten-minute poll.
 */

const orgOf = (s: ProvisioningState): string => {
  if (!s.orgId) throw new Error('The organisation has not been created yet');
  return s.orgId;
};
const venuesOf = (s: ProvisioningState): Array<{ slug: string; id: string; name: string }> => {
  const ids = (s.results.org?.venues ?? {}) as Record<string, string>;
  return intakeVenueSlugs(s.intake).map((slug, i) => ({ slug, id: ids[slug]!, name: s.intake.venues.venues[i]!.name })).filter((v) => v.id);
};
const asProvisioner = <T>(app: App, orgId: string, fn: (ctx: Ctx) => Promise<T>) => app.tenant(orgId, PROVISIONER, fn);
const on = async (ctx: Ctx, venueId: string, def: Parameters<typeof getModule>[2]) => (await getModule(ctx, venueId, def)).enabled;
const names = (list: Array<{ name: string }>) => list.map((v) => v.name).join(', ');

// ── 45 · menu import ─────────────────────────────────────────────────────────

registerProvisioningStep({
  key: 'menu_import',
  order: 45,
  label: 'Import the menu for the owner to confirm item by item',
  blockedOn: ['modules'],
  async run(app, s): Promise<StepOutcome> {
    const m = s.intake.menu;
    if (m.source === 'none') return { status: 'skipped', reason: 'No menu source was given. The menu is entered in the console.' };
    if (m.source === 'file') {
      return { status: 'blocked', blockedOn: 'Reading a PDF or photo of the menu is not available yet. Paste the menu text, or give the address of the menu page, in the intake.' };
    }
    const orgId = orgOf(s);
    const venues = venuesOf(s);
    // One import per venue, made once: a re-run reads the ids it recorded.
    const imports = { ...((s.previous?.imports ?? {}) as Record<string, string>) };
    for (const v of venues) {
      if (imports[v.id]) continue;
      const source = m.source === 'url' ? { kind: 'url' as const, url: m.sourceUrl ?? '' } : { kind: 'text' as const, text: m.sourceText ?? '' };
      imports[v.id] = (await asProvisioner(app, orgId, (ctx) => requestMenuImport(ctx, { venueId: v.id, source }))).importId;
    }
    const standing = await asProvisioner(app, orgId, async (ctx) => Promise.all(venues.map(async (v) => ({ v, st: await menuImportStanding(ctx, v.id) }))));
    const failed = standing.filter((x) => x.st.failed && !x.st.pending && !x.st.confirmed);
    if (failed.length) return { status: 'blocked', blockedOn: `The menu could not be read for ${names(failed.map((x) => x.v))}. Paste the menu text in the console's menu import instead.`, result: { imports } };
    const waiting = standing.reduce((n, x) => n + x.st.waitingItems, 0);
    const reading = standing.some((x) => x.st.pending && !x.st.waitingItems);
    if (reading) return { status: 'blocked', blockedOn: 'The menu is being read. It will be ready for review in a few minutes.', result: { imports } };
    if (waiting) return { status: 'blocked', blockedOn: `Review the imported menu: ${waiting} ${waiting === 1 ? 'item waits' : 'items wait'} for a yes or a no, allergens included.`, result: { imports } };
    return { status: 'done', result: { imports } };
  },
});

// ── 95 · SMS sender id ───────────────────────────────────────────────────────

registerProvisioningStep({
  key: 'sms_sender',
  order: 95,
  label: 'SMS sender id registration',
  blockedOn: ['org'],
  async run(_app, s): Promise<StepOutcome> {
    const id = s.intake.comms.smsSenderId;
    if (!id) return { status: 'skipped', reason: 'No SMS sender id was asked for. Texts go out from the platform sender.' };
    // No SMS provisioning port exists yet, so registration cannot be started from here.
    return {
      status: 'blocked',
      blockedOn: `Registering the SMS sender id "${id}" cannot be started automatically: no SMS provisioning provider is set up. Start the registration with the SMS provider by hand (it has lead time), then retry this step once it is approved.`,
      result: { senderId: id },
    };
  },
});

// ── 110 · ordering defaults ──────────────────────────────────────────────────

registerProvisioningStep({
  key: 'ordering_defaults',
  order: 110,
  label: 'Online ordering: pacing from the intake',
  blockedOn: ['modules'],
  modules: [orderingModule.key],
  async run(app, s): Promise<StepOutcome> {
    const orgId = orgOf(s);
    const pacing = s.intake.operations.pacing;
    const config = {
      ...(pacing.ordersPerSlot ? { max_orders_per_slot: pacing.ordersPerSlot } : {}),
      ...(pacing.slotMinutes ? { slot_minutes: pacing.slotMinutes } : {}),
    };
    const set: string[] = [];
    await asProvisioner(app, orgId, async (ctx) => {
      for (const v of venuesOf(s)) {
        if (!(await on(ctx, v.id, orderingModule))) continue;
        if (Object.keys(config).length) await setModule(ctx, orderingModule, { venueId: v.id, config });
        set.push(v.slug);
      }
    });
    if (!set.length) return { status: 'skipped', reason: 'No venue takes online orders.' };
    return { status: 'done', result: { venues: set, config } };
  },
});

// ── 120 · payments ───────────────────────────────────────────────────────────

/** Venues that take money online: ordering on, or table ordering from QR codes. */
async function takesPayment(ctx: Ctx, venueId: string): Promise<boolean> {
  if (await on(ctx, venueId, orderingModule)) return true;
  const qr = await getModule(ctx, venueId, qrModule);
  return qr.enabled && qr.config.stage === 'order';
}

registerProvisioningStep({
  key: 'payments_connect',
  order: 120,
  label: 'Payment account connected',
  blockedOn: ['modules'],
  modules: [orderingModule.key, qrModule.key],
  async run(app, s): Promise<StepOutcome> {
    const orgId = orgOf(s);
    const { paying, missing } = await asProvisioner(app, orgId, async (ctx) => {
      const paying = [];
      const missing = [];
      for (const v of venuesOf(s)) {
        if (!(await takesPayment(ctx, v.id))) continue;
        paying.push(v);
        if (!(await findConnectionFor(ctx, 'payment', v.id))) missing.push(v);
      }
      return { paying, missing };
    });
    if (!paying.length) return { status: 'skipped', reason: 'No venue takes payment online.' };
    if (missing.length) return { status: 'blocked', blockedOn: `Connect your payment account in the console (Settings, Payments) so guests can pay online at ${names(missing)}.` };
    return { status: 'done', result: { venues: paying.map((v) => v.slug) } };
  },
});

// ── 130 · QR codes for the declared tables ───────────────────────────────────

registerProvisioningStep({
  key: 'qr_tables',
  order: 130,
  label: 'QR codes for the declared tables',
  blockedOn: ['modules'],
  modules: [qrModule.key],
  async run(app, s): Promise<StepOutcome> {
    const areas = s.intake.floorPlan.areas.filter((a) => a.tables.length);
    if (!areas.length) return { status: 'skipped', reason: 'No tables were declared.' };
    const orgId = orgOf(s);
    // The floor plan in the intake is one room: it belongs to the first venue with QR codes on.
    const made = await asProvisioner(app, orgId, async (ctx) => {
      for (const v of venuesOf(s)) {
        if (!(await on(ctx, v.id, qrModule))) continue;
        let count = 0;
        // createTableCodes keeps a table's existing code, so a re-run makes nothing twice.
        for (const a of areas) count += (await createTableCodes(ctx, { venueId: v.id, labels: a.tables.map((t) => t.label), area: a.name, printBatch: 'onboarding' })).length;
        return { venue: v.slug, codes: count };
      }
      return null;
    });
    if (!made) return { status: 'skipped', reason: 'QR codes are not switched on at any venue.' };
    return { status: 'done', result: made };
  },
});

// ── 140 · loyalty defaults ───────────────────────────────────────────────────

registerProvisioningStep({
  key: 'loyalty_defaults',
  order: 140,
  label: 'Loyalty programme defaults',
  blockedOn: ['modules'],
  modules: [loyaltyModule.key],
  async run(app, s): Promise<StepOutcome> {
    const orgId = orgOf(s);
    return asProvisioner(app, orgId, async (ctx): Promise<StepOutcome> => {
      const anyOn = (await Promise.all(venuesOf(s).map((v) => on(ctx, v.id, loyaltyModule)))).some(Boolean);
      if (!anyOn) return { status: 'skipped', reason: 'Loyalty is not switched on at any venue.' };
      const existing = await getProgram(ctx);
      // An owner's own programme is never overwritten by a re-run.
      if (existing) return { status: 'done', result: { programme: existing.name, created: false } };
      const made = await saveProgram(ctx, { name: `${s.intake.identity.tradingName} Rewards`.slice(0, 120) });
      return { status: 'done', result: { programme: made.name, created: true } };
    });
  },
});

// ── 150 · point of sale ──────────────────────────────────────────────────────

registerProvisioningStep({
  key: 'pos_connect',
  order: 150,
  label: 'Point of sale connected',
  blockedOn: ['org'],
  async run(app, s): Promise<StepOutcome> {
    const named = s.intake.operations.existingPos || s.intake.integrations.square.merchantId;
    if (!named) return { status: 'skipped', reason: 'No point of sale was named.' };
    const orgId = orgOf(s);
    const missing = await asProvisioner(app, orgId, async (ctx) => {
      const out = [];
      for (const v of venuesOf(s)) if (!(await findConnectionFor(ctx, 'pos', v.id))) out.push(v);
      return out;
    });
    if (missing.length) return { status: 'blocked', blockedOn: `Connect your point of sale in the console (Settings, Connections) so sales at ${names(missing)} reach the platform.` };
    return { status: 'done', result: { venues: venuesOf(s).map((v) => v.slug) } };
  },
});

// ── Go-live checks ───────────────────────────────────────────────────────────

const pass = (reason: string): CheckResult => ({ status: 'pass', reason });
const fail = (reason: string): CheckResult => ({ status: 'fail', reason });
const na = (reason: string): CheckResult => ({ status: 'not_applicable', reason });

registerGoLiveCheck({
  key: 'menu_confirmed',
  label: 'Menu confirmed by the owner',
  order: 5,
  needsOwnerConfirmation: true,
  fix: { how: 'Bring the menu in (menu_import_start, menu_import_review, menu_import_confirm), then the owner confirms it is right.', tool: 'go_live_confirm' },
  async whatIsConfirmed(c) {
    const lines: string[] = [];
    await asProvisioner(c.app, c.orgId, async (ctx) => {
      for (const v of c.venues) {
        const editor = await getMenuEditor(ctx, v.id);
        const items = editor.menus.filter((m) => m.isActive).flatMap((m) => m.sections.flatMap((sec) => sec.items));
        const st = await menuImportStanding(ctx, v.id);
        if (st.waitingItems) throw invalid(`${v.name} has ${st.waitingItems} imported ${st.waitingItems === 1 ? 'item' : 'items'} still waiting for a yes or a no. Decide those first.`);
        if (!items.length) throw invalid(`${v.name} has no menu items yet. Bring the menu in first.`);
        lines.push(`${v.name}: ${items.length} ${items.length === 1 ? 'item' : 'items'}`);
      }
    });
    return `the menu is right, prices and allergens included. ${lines.join('; ')}`;
  },
  async run(c) {
    if (!c.venues.length) return fail('There is no venue yet.');
    const problems: string[] = [];
    await asProvisioner(c.app, c.orgId, async (ctx) => {
      for (const v of c.venues) {
        const editor = await getMenuEditor(ctx, v.id);
        const items = editor.menus.filter((m) => m.isActive).flatMap((m) => m.sections.flatMap((sec) => sec.items));
        const st = await menuImportStanding(ctx, v.id);
        if (st.waitingItems) problems.push(`${v.name} has ${st.waitingItems} imported ${st.waitingItems === 1 ? 'item' : 'items'} still waiting for a yes or a no`);
        else if (!items.length) problems.push(`${v.name} has no menu items`);
      }
    });
    if (problems.length) return fail(`${problems.join('; ')}.`);
    const confirmed = c.confirmations.menu_confirmed;
    if (!confirmed) return fail('The menu is in place, but the owner has not confirmed it yet.');
    return pass(`The menu was confirmed by the owner on ${confirmed.at.slice(0, 10)}.`);
  },
});

/** Venues with online ordering on. */
async function orderingVenues(c: { app: App; orgId: string; venues: Array<{ id: string; name: string }> }) {
  return asProvisioner(c.app, c.orgId, async (ctx) => {
    const out = [];
    for (const v of c.venues) if (await on(ctx, v.id, orderingModule)) out.push(v);
    return out;
  });
}

const PAID = ['paid', 'partially_refunded', 'refunded'];

registerGoLiveCheck({
  key: 'payment_ready',
  label: 'Payment account connected and a test payment taken',
  order: 70,
  fix: { how: 'Connect the payment account (connection_start), then the owner places one small order on their own site and pays for it with a real card.', tool: 'connection_start', ownerOnly: true },
  async run(c) {
    const venues = await orderingVenues(c);
    if (!venues.length) return na('No venue takes online orders.');
    const problems: string[] = [];
    await asProvisioner(c.app, c.orgId, async (ctx) => {
      for (const v of venues) {
        if (!(await findConnectionFor(ctx, 'payment', v.id))) {
          problems.push(`${v.name} has no payment account connected`);
          continue;
        }
        const orders = await listOrders(ctx, { venueId: v.id, limit: 50 });
        if (!orders.some((o) => PAID.includes(o.paymentStatus))) problems.push(`no test payment has been taken at ${v.name}`);
      }
    });
    if (problems.length) return fail(`${problems.join('; ')}.`);
    return pass(`Payments are connected and a test payment was taken at ${venues.length === 1 ? 'the venue' : `all ${venues.length} venues`}.`);
  },
});

registerGoLiveCheck({
  key: 'kitchen_test_order',
  label: 'A test order reached the kitchen screen',
  order: 75,
  fix: { how: 'Someone at the venue accepts the paid test order on the kitchen order screen.', ownerOnly: true },
  async run(c) {
    const venues = await orderingVenues(c);
    if (!venues.length) return na('No venue takes online orders.');
    const missing: string[] = [];
    await asProvisioner(c.app, c.orgId, async (ctx) => {
      for (const v of venues) {
        const orders = await listOrders(ctx, { venueId: v.id, limit: 50 });
        // The kitchen acted on it from the screen: accepted, made ready, or handed over.
        if (!orders.some((o) => PAID.includes(o.paymentStatus) && (o.acceptedAt || o.readyAt || o.completedAt))) missing.push(v.name);
      }
    });
    if (missing.length) return fail(`No paid test order has been accepted on the kitchen screen at ${missing.join(', ')}.`);
    return pass('A paid test order was accepted on the kitchen screen.');
  },
});

registerGoLiveCheck({
  key: 'loyalty_enrolment_tested',
  label: 'Loyalty enrolment tested',
  order: 80,
  fix: { how: 'The owner joins the loyalty programme once, as a guest would, from the venue\'s own site.', ownerOnly: true },
  async run(c) {
    return asProvisioner(c.app, c.orgId, async (ctx) => {
      const anyOn = (await Promise.all(c.venues.map((v) => on(ctx, v.id, loyaltyModule)))).some(Boolean);
      if (!anyOn) return na('Loyalty is not switched on.');
      const summary = await getLoyaltySummary(ctx, {});
      if (!summary.program) return fail('There is no loyalty programme yet.');
      if (summary.members.total < 1) return fail('Nobody has joined the loyalty programme yet. Join it once as a test guest.');
      return pass(`${summary.members.total} ${summary.members.total === 1 ? 'member has' : 'members have'} joined the programme.`);
    });
  },
});

registerGoLiveCheck({
  key: 'redirects_mapped',
  label: 'Old site addresses redirected',
  order: 65,
  fix: { how: 'The old site\'s addresses are mapped to the new pages in the console (Website, Redirects).', ownerOnly: true },
  async run(c) {
    const m = ((c.intake as { migration?: { existingSiteUrl?: string | null; sitemapUrls?: string[]; redirects?: Array<{ from: string }> } }).migration ?? {});
    const old = [...(m.sitemapUrls ?? []), ...(m.redirects ?? []).map((r) => r.from)].map((u) => normaliseRedirectFrom(u)).filter((p): p is string => !!p && p !== '/');
    if (!m.existingSiteUrl && !old.length) return na('There is no old site to redirect.');
    let mapped: Set<string>;
    try {
      mapped = new Set((await asProvisioner(c.app, c.orgId, (ctx) => listRedirects(ctx))).map((r) => r.from));
    } catch (e) {
      if (isAppError(e) && e.code === 'module_disabled') return na('The website is switched off.');
      throw e;
    }
    if (!old.length) return mapped.size ? pass(`${mapped.size} old addresses are redirected.`) : fail('The old site was named but none of its addresses are redirected. Add its sitemap in the intake.');
    const unmapped = [...new Set(old)].filter((p) => !mapped.has(p));
    if (unmapped.length) return fail(`${unmapped.length} old ${unmapped.length === 1 ? 'address has' : 'addresses have'} no redirect: ${unmapped.slice(0, 5).join(', ')}${unmapped.length > 5 ? ' …' : ''}.`);
    return pass(`All ${new Set(old).size} old addresses are redirected.`);
  },
});

/** Keys this file registers, so a test of the spine alone can set them aside. */
export const MODULE_PROVISIONING_STEPS = ['menu_import', 'sms_sender', 'ordering_defaults', 'payments_connect', 'qr_tables', 'loyalty_defaults', 'pos_connect'] as const;
export const MODULE_GO_LIVE_CHECKS = ['menu_confirmed', 'payment_ready', 'kitchen_test_order', 'loyalty_enrolment_tested', 'redirects_mapped'] as const;
