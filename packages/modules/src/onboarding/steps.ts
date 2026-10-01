import { type App, type HostingPort, type SendingDomainPort, AppError, getModule, getModuleDef, isAppError, listModuleDefs, setModule } from '@ros/core';
import { inviteStaff } from '../auth/staff';
import { addSendingIdentity, listSendingIdentities, setSendingIdentityStatus } from '../comms/identities';
import { addCustomDomain, clearHostCache, listDomains, markDomainVerified, resolveHost } from '../tenancy/domains';
import { setHourException, setTradingHours } from '../tenancy/hours';
import { createOrg } from '../tenancy/orgs';
import { createVenue, getVenueBySlug, updateVenue } from '../tenancy/venues';
import { setBrand } from '../website/brand';
import { websiteModule } from '../website/module';
import { ensureDefaultPages, listPublishedPages } from '../website/pages';
import { importRedirects, suggestRedirects } from '../website/redirects';
import type { DefaultPageCopy } from '../website/skeletons';
import { type Intake, type Service, intakeVenueSlugs } from './intake';
import { PROVISIONER } from './platform';
import { type ProvisioningState, registerProvisioningStep } from './provisioning';

/**
 * The provisioning steps that belong to the spine and to the website: the org itself, its
 * brand, hours, modules, pages, redirects, domains, sending domain and staff. Other modules
 * register theirs (menu import, floor plan, SMS sender, payments connect, loyalty defaults).
 */

const orgOf = (s: ProvisioningState): string => {
  if (!s.orgId) throw new Error('The organisation has not been created yet');
  return s.orgId;
};

/** venue slug → venue id, as recorded by the step that created the org. */
const venuesOf = (s: ProvisioningState): Record<string, string> => (s.results.org?.venues ?? {}) as Record<string, string>;

// ── Services → modules ─────────────────────────────────────────────────────────────────────

const serviceModules = new Map<Service, Set<string>>([
  ['dine-in', new Set(['qr'])],
  ['pickup', new Set(['ordering'])],
  ['delivery', new Set(['ordering', 'delivery'])],
  ['catering', new Set()],
  ['functions', new Set()],
]);
/** Switched on at every venue whatever it declared: the site is how a venue goes live. */
const ALWAYS_ON = ['website'];
/**
 * What a self-serve venue starts with: assistant access, so the owner's assistant can connect
 * and set the rest up. Every other plugin is the venue's own choice (docs/PIPEDLINE.md section 5).
 */
export const SELF_SERVE_MODULES = ['hub'];

/** A module says which declared service switches it on (e.g. bookings for dine-in, once it exists). */
export function declareServiceModule(service: Service, moduleKey: string): void {
  serviceModules.get(service)?.add(moduleKey);
}

/**
 * The modules a venue's declared services switch on, with their dependencies, in the order
 * they must be enabled. Keys with no registered module are left out.
 */
export function modulesForServices(services: readonly Service[]): string[] {
  const known = new Map(listModuleDefs().map((d) => [d.key, d]));
  const ordered: string[] = [];
  const add = (key: string, trail: string[] = []) => {
    const def = known.get(key);
    if (!def || def.spine || ordered.includes(key) || trail.includes(key)) return;
    for (const dep of def.dependsOn) add(dep, [...trail, key]);
    ordered.push(key);
  };
  for (const key of ALWAYS_ON) add(key);
  for (const service of services) for (const key of serviceModules.get(service) ?? []) add(key);
  return ordered;
}

// ── 10 · org, venues, owner ────────────────────────────────────────────────────────────────

registerProvisioningStep({
  key: 'org',
  order: 10,
  label: 'Create the organisation, its venues and the owner',
  async run(app, s) {
    const { identity, venues } = s.intake;
    const slugs = intakeVenueSlugs(s.intake);
    const first = venues.venues[0]!;

    let orgId = s.orgId;
    if (!orgId) {
      // One platform transaction creates the org and ties the onboarding to it, so a crash
      // cannot leave an org that a retry would try to create a second time.
      const created = await app.platform('provisioning: create org', async (pctx) => {
        const c = await createOrg(pctx, {
          slug: identity.slug,
          legalName: identity.legalName,
          tradingName: identity.tradingName,
          abn: identity.abn ?? undefined,
          timezone: first.timezone,
          cuisineTags: first.cuisineTags,
          priceBand: first.priceBand ?? undefined,
          owner: {
            email: identity.primaryContact.email,
            firstName: identity.primaryContact.firstName,
            lastName: identity.primaryContact.lastName ?? undefined,
            phone: identity.primaryContact.mobile ?? undefined,
          },
          venue: {
            slug: slugs[0],
            name: first.name,
            timezone: first.timezone,
            addressLine1: first.addressLine1,
            suburb: first.suburb,
            state: first.state,
            postcode: first.postcode,
            lat: first.lat ?? undefined,
            lng: first.lng ?? undefined,
            phone: first.phone ?? undefined,
            email: first.email ?? undefined,
            capacity: first.capacity ?? undefined,
          },
          modules: [],
        });
        await pctx.db.updateTable('onboardings').set({ org_id: c.orgId }).where('id', '=', s.onboardingId).execute();
        await pctx.db.updateTable('provisioning_steps').set({ org_id: c.orgId }).where('onboarding_id', '=', s.onboardingId).execute();
        return c;
      });
      orgId = created.orgId;
    }

    // The remaining venues, and the details createOrg does not take. Found by slug, so a re-run adds nothing twice.
    const venueIds: Record<string, string> = {};
    await app.tenant(orgId, PROVISIONER, async (ctx) => {
      for (const [i, v] of venues.venues.entries()) {
        const slug = slugs[i]!;
        let id: string;
        try {
          id = (await getVenueBySlug(ctx, slug)).id;
        } catch (e) {
          if (!isAppError(e) || e.code !== 'not_found') throw e;
          id = (
            await createVenue(ctx, {
              slug,
              name: v.name,
              timezone: v.timezone,
              addressLine1: v.addressLine1,
              suburb: v.suburb,
              state: v.state,
              postcode: v.postcode,
              lat: v.lat,
              lng: v.lng,
              phone: v.phone,
              email: v.email,
              capacity: v.capacity,
              cuisineTags: v.cuisineTags,
              priceBand: v.priceBand,
            })
          ).id;
        }
        await updateVenue(ctx, id, { addressLine2: v.addressLine2 ?? null, cuisineTags: v.cuisineTags, priceBand: v.priceBand ?? null });
        venueIds[slug] = id;
      }
    });
    const host = `${identity.slug}.${app.config.tenantRootDomain}`;
    return { status: 'done', result: { orgId, venues: venueIds, host } };
  },
});

// ── 20 · brand tokens and skeleton ─────────────────────────────────────────────────────────

registerProvisioningStep({
  key: 'brand',
  order: 20,
  label: 'Brand tokens and layout skeleton',
  blockedOn: ['org'],
  async run(app, s) {
    const b = s.intake.brand;
    const brand = await app.tenant(orgOf(s), PROVISIONER, (ctx) =>
      setBrand(ctx, {
        tokens: b.tokens,
        skeleton: b.skeleton,
        logo: { svgUrl: b.logo.svgUrl ?? null, rasterUrl: b.logo.rasterUrl ?? null, markUrl: b.logo.markUrl ?? null },
        toneOfVoice: b.toneOfVoice ?? null,
      }),
    );
    return { status: 'done', result: { skeleton: brand.skeleton } };
  },
});

// ── 30 · trading hours ─────────────────────────────────────────────────────────────────────

registerProvisioningStep({
  key: 'hours',
  order: 30,
  label: 'Trading hours',
  blockedOn: ['org'],
  async run(app, s) {
    const ids = venuesOf(s);
    const slugs = intakeVenueSlugs(s.intake);
    // A draft venue has no hours yet: they are set afterwards, by the owner or their assistant.
    if (!s.intake.venues.venues.some((v) => v.hours.length || v.exceptions.length)) return { status: 'skipped', reason: 'No trading hours were given.' };
    await app.tenant(orgOf(s), PROVISIONER, async (ctx) => {
      for (const [i, v] of s.intake.venues.venues.entries()) {
        const venueId = ids[slugs[i]!]!;
        if (v.hours.length) await setTradingHours(ctx, venueId, v.hours);
        for (const ex of v.exceptions) await setHourException(ctx, venueId, ex);
      }
    });
    return { status: 'done', result: { venues: slugs.length } };
  },
});

// ── 40 · modules from the declared services ────────────────────────────────────────────────

registerProvisioningStep({
  key: 'modules',
  order: 40,
  label: 'Switch on modules for the declared services',
  blockedOn: ['org'],
  async run(app, s) {
    const ids = venuesOf(s);
    const slugs = intakeVenueSlugs(s.intake);
    const enabled: Record<string, string[]> = {};
    await app.tenant(orgOf(s), PROVISIONER, async (ctx) => {
      for (const [i, v] of s.intake.venues.venues.entries()) {
        const venueId = ids[slugs[i]!]!;
        const keys = s.origin === 'self_serve' ? SELF_SERVE_MODULES : modulesForServices(v.services ?? s.intake.services.services);
        for (const key of keys) {
          if (key === websiteModule.key) {
            await setModule(ctx, websiteModule, { venueId, enabled: true, config: { socialLinks: s.intake.integrations.socialLinks } });
          } else {
            await setModule(ctx, getModuleDef(key), { venueId, enabled: true });
          }
        }
        enabled[slugs[i]!] = keys;
      }
    });
    return { status: 'done', result: { enabled } };
  },
});

// ── 50 · default pages ─────────────────────────────────────────────────────────────────────

function instagramHandle(url: string | null | undefined): string | null {
  if (!url) return null;
  const m = /instagram\.com\/([A-Za-z0-9._]{1,30})\/?(?:[?#].*)?$/.exec(url);
  return m ? m[1]! : null;
}

function copyFor(intake: Intake, venueIndex: number | null): DefaultPageCopy {
  const v = venueIndex === null ? (intake.venues.venues.length === 1 ? intake.venues.venues[0]! : null) : intake.venues.venues[venueIndex]!;
  const name = venueIndex === null ? intake.identity.tradingName : v!.name;
  const services = new Set<Service>(venueIndex === null ? intake.venues.venues.flatMap((x) => x.services ?? intake.services.services) : (v!.services ?? intake.services.services));
  const photos = intake.brand.photography;
  return {
    tradingName: name,
    tagline: intake.content.tagline ?? null,
    about: intake.content.about,
    heroImageUrl: photos.hero ?? null,
    galleryImages: [...photos.food, ...photos.room].slice(0, 12).map((url, i) => ({ url, alt: `${name}, photograph ${i + 1}` })),
    testimonials: intake.content.testimonials,
    faq: intake.content.faq,
    instagramHandle: instagramHandle(intake.integrations.socialLinks.instagram),
    suburb: v?.suburb ?? null,
    takesBookings: services.has('dine-in'),
    takesOrders: services.has('pickup') || services.has('delivery'),
  };
}

registerProvisioningStep({
  key: 'pages',
  order: 50,
  label: 'Default pages from the skeleton and intake copy',
  blockedOn: ['brand', 'modules'],
  modules: [websiteModule.key],
  async run(app, s) {
    const ids = venuesOf(s);
    const slugs = intakeVenueSlugs(s.intake);
    const created: string[] = [];
    // A venue that has not switched the website on has no pages to make. The step runs again if it does.
    const siteOn = await app.tenant(orgOf(s), PROVISIONER, async (ctx) => {
      for (const slug of slugs) if (ids[slug] && (await getModule(ctx, ids[slug]!, websiteModule)).enabled) return true;
      return false;
    });
    if (!siteOn) return { status: 'skipped', reason: 'The website is not switched on.' };
    await app.tenant(orgOf(s), PROVISIONER, async (ctx) => {
      const site = await ensureDefaultPages(ctx, { copy: copyFor(s.intake, null), publish: true }, 'provisioning');
      created.push(...site.created.map((p) => p.slug));
      // A group also gets a page set per venue, for each venue's own site.
      if (slugs.length > 1) {
        for (const [i, slug] of slugs.entries()) {
          const own = await ensureDefaultPages(ctx, { venueId: ids[slug]!, copy: copyFor(s.intake, i), publish: true }, 'provisioning');
          created.push(...own.created.map((p) => `${slug}/${p.slug}`));
        }
      }
    });
    return { status: 'done', result: { created } };
  },
});

// ── 60 · redirects from the old site ───────────────────────────────────────────────────────

registerProvisioningStep({
  key: 'redirects',
  order: 60,
  label: 'Import the 301 redirect map',
  blockedOn: ['pages'],
  async run(app, s) {
    const m = s.intake.migration;
    if (!m.redirects.length && !m.sitemapUrls.length) return { status: 'skipped', reason: 'No old site addresses were given.' };
    const result = await app.tenant(orgOf(s), PROVISIONER, async (ctx) => {
      // A reviewed map wins. Otherwise suggest one from the old sitemap: a best-guess redirect beats a dead link.
      const entries = m.redirects.length
        ? m.redirects
        : suggestRedirects({ oldUrls: m.sitemapUrls, pageSlugs: (await listPublishedPages(ctx)).map((p) => p.slug) }).map((r) => ({ from: r.from, to: r.to }));
      return importRedirects(ctx, { entries });
    });
    return {
      status: 'done',
      result: { imported: result.imported, updated: result.updated, unchanged: result.unchanged, rejected: result.rejected.length, rejectedSample: result.rejected.slice(0, 20), suggested: !m.redirects.length },
    };
  },
});

// ── 70 · subdomain live ────────────────────────────────────────────────────────────────────

registerProvisioningStep({
  key: 'subdomain',
  order: 70,
  label: 'Site live on the platform subdomain',
  blockedOn: ['org'],
  async run(app, s) {
    const host = `${s.intake.identity.slug}.${app.config.tenantRootDomain}`;
    clearHostCache();
    const resolved = await resolveHost(app, host);
    if (!resolved || resolved.orgId !== orgOf(s)) throw new Error(`${host} does not resolve to this organisation`);
    return { status: 'done', result: { host, url: `${app.config.scheme}://${host}` } };
  },
});

// ── 80 · custom domain ─────────────────────────────────────────────────────────────────────

/** The web host domains are attached to. One deployment has one. */
export function hostingOf(app: App): HostingPort {
  const key = app.adapters.keys('hosting')[0];
  if (!key) throw new AppError('unavailable', 'No web host is configured for custom domains.');
  return app.adapters.get('hosting', key);
}

/** The sending-domain side of the email provider marketing goes out through. */
export function sendingDomainsOf(app: App): SendingDomainPort {
  const key = app.config.comms.emailAdapter;
  if (!app.adapters.has('sending_domain', key)) throw new AppError('unavailable', 'The email provider is not set up for sending domains.');
  return app.adapters.get('sending_domain', key);
}

registerProvisioningStep({
  key: 'custom_domain',
  order: 80,
  label: 'Custom domain: register, surface DNS records, verify',
  blockedOn: ['subdomain'],
  async run(app, s) {
    const host = s.intake.migration.customDomain;
    if (!host) return { status: 'skipped', reason: 'No custom domain was asked for.' };
    const orgId = orgOf(s);

    const domain = await app.tenant(orgId, PROVISIONER, async (ctx) => (await listDomains(ctx)).find((d) => d.host === host) ?? (await addCustomDomain(ctx, { host })));
    if (domain.verified) return { status: 'done', result: { host, domainId: domain.id } };

    // The provider is called between transactions, with a key that makes a retry the same request.
    const hosting = hostingOf(app);
    const registration = await hosting.addDomain({ host, idempotencyKey: `onboarding:${s.onboardingId}:domain:${host}` });
    const check = registration.verified ? registration : await hosting.checkDomain({ host, providerDomainId: registration.providerDomainId });
    const result = { host, domainId: domain.id, providerDomainId: registration.providerDomainId, records: check.records.length ? check.records : registration.records };
    if (!check.verified) {
      return { status: 'blocked', blockedOn: `Waiting for DNS: the records for ${host} have not been added at the domain registrar yet.`, result };
    }
    // Only the provider's answer gets a domain here; a venue cannot mark its own domain verified.
    await app.tenant(orgId, PROVISIONER, (ctx) => markDomainVerified(ctx, domain.id, registration.providerDomainId));
    return { status: 'done', result };
  },
});

// ── 90 · marketing sending domain ──────────────────────────────────────────────────────────

registerProvisioningStep({
  key: 'sending_domain',
  order: 90,
  label: 'Marketing sending domain: register, surface DNS records, verify',
  blockedOn: ['org'],
  async run(app, s) {
    const c = s.intake.comms;
    const domain = c.sendingDomain;
    if (!domain) return { status: 'skipped', reason: 'No sending domain was given. Marketing email stays off until one is verified.' };
    const orgId = orgOf(s);

    const provider = sendingDomainsOf(app);
    const registration = await provider.createDomain({ domain, idempotencyKey: `onboarding:${s.onboardingId}:sending:${domain}` });

    // The records go on the identity, where the venue reads them (comms.listSendingIdentities).
    const identity = await app.tenant(orgId, PROVISIONER, async (ctx) => {
      const existing = (await listSendingIdentities(ctx)).find((i) => i.channel === 'email' && i.domain === domain);
      if (existing) return { id: existing.id, status: existing.status };
      const created = await addSendingIdentity(
        ctx,
        { channel: 'email', domain, fromLocalPart: c.fromLocalPart, fromName: c.fromName ?? s.intake.identity.tradingName },
        { key: provider.key, providerDomainId: registration.providerDomainId, dnsRecords: registration.records },
      );
      return { id: created.id, status: created.status };
    });
    const result = { domain, identityId: identity.id, providerDomainId: registration.providerDomainId, records: registration.records };
    if (identity.status === 'verified') return { status: 'done', result };

    const check = registration.verified ? registration : await provider.checkDomain({ domain, providerDomainId: registration.providerDomainId });
    if (!check.verified) {
      return { status: 'blocked', blockedOn: `Waiting for DNS: the sending records for ${domain} have not been added yet.`, result };
    }
    await app.tenant(orgId, PROVISIONER, (ctx) => setSendingIdentityStatus(ctx, identity.id, 'verified'));
    return { status: 'done', result };
  },
});

// ── 100 · staff invitations ────────────────────────────────────────────────────────────────

registerProvisioningStep({
  key: 'staff',
  order: 100,
  label: 'Staff accounts and invitations',
  blockedOn: ['org'],
  async run(app, s) {
    const staff = s.intake.team.staff;
    if (!staff.length) return { status: 'skipped', reason: 'No team members were listed.' };
    const ids = venuesOf(s);
    let invited = 0;
    let already = 0;
    // One person per transaction: an invitation that went out stays out if a later one fails.
    for (const person of staff) {
      const venueIds = (person.venueSlugs.length ? person.venueSlugs : Object.keys(ids)).map((slug) => ids[slug]).filter((id): id is string => Boolean(id));
      const isOwner = person.role === 'owner';
      try {
        await app.tenant(orgOf(s), PROVISIONER, (ctx) =>
          inviteStaff(ctx, {
            email: person.email,
            firstName: person.firstName,
            lastName: person.lastName ?? null,
            phone: person.phone ?? null,
            isOwner,
            roles: isOwner ? [] : venueIds.map((venueId) => ({ venueId, role: person.role })),
          }),
        );
        invited++;
      } catch (e) {
        // Already on the team (the owner listed again, or a re-run after a partial failure).
        if (isAppError(e) && e.code === 'conflict') already++;
        else throw e;
      }
    }
    return { status: 'done', result: { invited, already } };
  },
});
