import { z } from 'zod';
import { type App, type Principal, invalid, json, notFound } from '@ros/core';
import { hourExceptionInput, tradingHoursInput } from '../tenancy/hours';
import { socialLinks } from '../website/module';
import { httpsUrl, imageUrl, plainText } from '../website/safe';
import { SKELETON_KEYS } from '../website/skeletons';
import { DEFAULT_BRAND_TOKENS, brandTokensPartial, brandTokensSchema, mergeTokens } from '../website/tokens';
import { redirectEntry } from '../website/redirects';
import { requirePlatformAdmin } from './platform';

/**
 * The brand intake (docs/ONBOARDING.md section 2) as a versioned schema, one zod object per
 * section. No owner completes this in one sitting, so a section can be saved half-filled: what
 * is there must be valid, what is not there is reported as missing. Provisioning runs off the
 * whole thing once every required section is complete.
 */
export const INTAKE_VERSION = 1;

export const SERVICES = ['dine-in', 'pickup', 'delivery', 'catering', 'functions'] as const;
export type Service = (typeof SERVICES)[number];

const ORG_SLUG = /^[a-z0-9](?:[a-z0-9-]{1,38}[a-z0-9])$/;
const VENUE_SLUG = /^[a-z0-9](?:[a-z0-9-]{0,38}[a-z0-9])?$/;
const DOMAIN = /^(?=.{4,253}$)([a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,}$/;

const email = z.string().trim().toLowerCase().email('Enter an email address.');
const phone = z.string().trim().regex(/^\+?[0-9 ()-]{6,20}$/, 'Enter a phone number.');
const domain = z.string().trim().toLowerCase().regex(DOMAIN, 'Enter a domain such as bellastrattoria.com.au.');
const longText = (max: number) => plainText(max, { multiline: true });
const timezone = z.string().refine((tz) => {
  try {
    new Intl.DateTimeFormat('en-AU', { timeZone: tz });
    return true;
  } catch {
    return false;
  }
}, 'Choose a time zone such as Australia/Sydney.');

const identity = z.object({
  legalName: plainText(200),
  tradingName: plainText(200),
  /** The platform subdomain the site goes live on: <slug>.<platform domain>. */
  slug: z.string().trim().toLowerCase().regex(ORG_SLUG, 'Use 3 to 40 lowercase letters, numbers or hyphens.'),
  abn: z
    .string()
    .trim()
    .regex(/^[0-9 ]{9,14}$/, 'An ABN is 11 digits.')
    .nullish(),
  acn: z
    .string()
    .trim()
    .regex(/^[0-9 ]{9,11}$/, 'An ACN is 9 digits.')
    .nullish(),
  registeredAddress: plainText(300).nullish(),
  gstRegistered: z.boolean().default(true),
  /** Becomes the org's owner. */
  primaryContact: z.object({
    firstName: plainText(80),
    lastName: plainText(80).nullish(),
    role: plainText(80).nullish(),
    mobile: phone.nullish(),
    email,
  }),
  billingContact: z.object({ name: plainText(120), email }).nullish(),
});

const brand = z
  .object({
    /** Any subset of the brand tokens; the rest are the platform defaults. */
    tokens: brandTokensPartial.default({}),
    skeleton: z.enum(SKELETON_KEYS),
    logo: z.object({ svgUrl: imageUrl.nullish(), rasterUrl: imageUrl.nullish(), markUrl: imageUrl.nullish() }).default({}),
    /** Three or four sentences in their own voice, used to steer generated copy. */
    toneOfVoice: longText(1500).nullish(),
    adjectives: z.array(plainText(40)).max(8).default([]),
    photography: z
      .object({
        hero: imageUrl.nullish(),
        food: z.array(imageUrl).max(24).default([]),
        room: z.array(imageUrl).max(24).default([]),
        team: z.array(imageUrl).max(24).default([]),
      })
      .default({ food: [], room: [], team: [] }),
  })
  .superRefine((b, issue) => {
    const merged = brandTokensSchema.safeParse(mergeTokens(DEFAULT_BRAND_TOKENS, b.tokens));
    if (!merged.success) for (const i of merged.error.issues) issue.addIssue({ code: 'custom', path: ['tokens', ...i.path], message: i.message });
  });

const venue = z.object({
  /** Short name used in addresses. Defaults to "main" for the first venue and to the name for the rest. */
  slug: z.string().trim().toLowerCase().regex(VENUE_SLUG).optional(),
  name: plainText(200),
  addressLine1: plainText(200),
  addressLine2: plainText(200).nullish(),
  suburb: plainText(80),
  state: plainText(40),
  postcode: z.string().trim().regex(/^[0-9A-Za-z -]{3,10}$/, 'Enter a postcode.'),
  lat: z.number().min(-90).max(90).nullish(),
  lng: z.number().min(-180).max(180).nullish(),
  phone: phone.nullish(),
  email: email.nullish(),
  timezone: timezone.default('Australia/Sydney'),
  /** Trading hours per day per service type. */
  hours: tradingHoursInput.min(1, 'Give the trading hours.'),
  /** Holidays and one-off closures. */
  exceptions: z.array(hourExceptionInput).max(60).default([]),
  capacity: z.number().int().positive().nullish(),
  cuisineTags: z.array(plainText(40)).max(10).default([]),
  priceBand: z.number().int().min(1).max(4).nullish(),
  licensed: z.boolean().nullish(),
  parking: plainText(300).nullish(),
  accessibility: plainText(300).nullish(),
  dietaryPolicy: longText(1000).nullish(),
  /** This venue's services, when they differ from the org-wide answer. */
  services: z.array(z.enum(SERVICES)).min(1).optional(),
});

const venues = z.object({ venues: z.array(venue).min(1, 'Add at least one venue.').max(20) });

/** What drives module enablement: the answer here is which modules get switched on. */
const services = z.object({ services: z.array(z.enum(SERVICES)).min(1, 'Choose at least one service.') });

const operations = z.object({
  /** Kitchen prep minutes by course, e.g. { mains: 18 }. */
  prepMinutes: z.record(z.string().max(40), z.number().int().min(0).max(240)).default({}),
  pacing: z
    .object({ coversPerSlot: z.number().int().positive().nullish(), ordersPerSlot: z.number().int().positive().nullish(), slotMinutes: z.number().int().min(5).max(120).nullish() })
    .default({}),
  stations: z
    .array(z.object({ name: plainText(60), sections: z.array(plainText(60)).max(30).default([]) }))
    .max(20)
    .default([]),
  existingPos: plainText(80).nullish(),
  existingBookingSystem: plainText(80).nullish(),
  existingEsp: z.object({ name: plainText(80), listSize: z.number().int().min(0).nullish(), consentProvenance: longText(1000).nullish() }).nullish(),
});

/** Where the menu comes from. The import itself (extraction, item-by-item confirmation) is its own flow. */
const menu = z.object({
  source: z.enum(['none', 'text', 'url', 'file']).default('none'),
  sourceUrl: httpsUrl.nullish(),
  sourceText: longText(40_000).nullish(),
  /** A media-library or storage reference for an uploaded PDF or image. */
  sourceFileRef: z.string().max(500).nullish(),
  notes: longText(2000).nullish(),
});

const floorPlan = z.object({
  areas: z
    .array(
      z.object({
        name: plainText(60),
        tables: z
          .array(
            z.object({
              /** The venue's own label for the table. */
              label: plainText(20),
              minSeats: z.number().int().min(1).max(50),
              maxSeats: z.number().int().min(1).max(50),
              shape: z.enum(['round', 'square', 'rectangle', 'booth', 'bar']).nullish(),
            }),
          )
          .max(200)
          .default([]),
      }),
    )
    .max(20)
    .default([]),
  /** Table combinations the room actually supports, as lists of labels. */
  combinations: z.array(z.array(plainText(20)).min(2).max(10)).max(100).default([]),
});

const hhmm = z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/, 'Use a 24-hour time such as 20:00.');

const comms = z.object({
  /** The org's own marketing sending domain. Start this on day one: DNS has lead time. */
  sendingDomain: domain.nullish(),
  fromName: plainText(100).nullish(),
  fromLocalPart: z
    .string()
    .regex(/^[a-z0-9._-]{1,64}$/i)
    .default('hello'),
  smsSenderId: z
    .string()
    .regex(/^[A-Za-z0-9]{3,11}$/, 'A sender id is 3 to 11 letters or numbers.')
    .nullish(),
  /** Registration details for the SMS sender id. */
  smsRegistrationNote: longText(1000).nullish(),
  quietHours: z.object({ start: hhmm, end: hhmm }).nullish(),
  replyToEmail: email.nullish(),
  unsubscribeCopy: plainText(300).nullish(),
  /** Where any imported list's consent came from. A list with no provenance is quarantined. */
  listConsentProvenance: longText(1000).nullish(),
});

const integrations = z.object({
  square: z.object({ merchantId: z.string().max(100).nullish(), locationIds: z.array(z.string().max(100)).max(50).default([]) }).default({ locationIds: [] }),
  payoutAccountReady: z.boolean().nullish(),
  googleBusinessProfileUrl: httpsUrl.nullish(),
  socialLinks: socialLinks.default(socialLinks.parse({})),
  reviewLinks: z.array(httpsUrl).max(10).default([]),
});

const content = z.object({
  tagline: plainText(240).nullish(),
  /** The about/story copy. The default pages are written from this. */
  about: longText(4000),
  faq: z
    .array(z.object({ question: plainText(200), answer: longText(1500) }))
    .max(30)
    .default([]),
  testimonials: z
    .array(z.object({ quote: longText(600), author: plainText(80), source: plainText(80).nullish() }))
    .max(12)
    .default([]),
  policies: z
    .object({
      cancellation: longText(5000).nullish(),
      deposit: longText(5000).nullish(),
      allergenDisclaimer: longText(5000).nullish(),
      privacy: longText(20_000).nullish(),
      terms: longText(20_000).nullish(),
    })
    .default({}),
});

const migration = z.object({
  existingSiteUrl: z
    .string()
    .max(2000)
    .regex(/^https?:\/\/[^\s<>"']+$/i, 'Enter the address of the current site.')
    .nullish(),
  /** Every address on the old site (its sitemap), for the 301 map. */
  sitemapUrls: z.array(z.string().max(2000)).max(5000).default([]),
  /** A reviewed redirect map. When absent, one is suggested from sitemapUrls. */
  redirects: z.array(redirectEntry).max(5000).default([]),
  /** The custom domain the site moves to once the venue hands over DNS. */
  customDomain: domain.nullish(),
  customerList: z.object({ count: z.number().int().min(0), consentProvenance: longText(1000).nullish() }).nullish(),
  hasHistoricalTransactions: z.boolean().nullish(),
});

const criota = z.object({
  participates: z.boolean().default(false),
  /** Venue slugs that take part. Empty means every venue. */
  venueSlugs: z.array(z.string().regex(VENUE_SLUG)).max(20).default([]),
  defaultOfferTemplate: longText(1000).nullish(),
  attributionCodes: z
    .array(z.string().regex(/^[A-Za-z0-9_-]{2,40}$/))
    .max(20)
    .default([]),
});

/** Not a heading in docs/ONBOARDING.md section 2, but provisioning needs to know who to invite. */
const team = z.object({
  staff: z
    .array(
      z.object({
        email,
        firstName: plainText(80),
        lastName: plainText(80).nullish(),
        phone: phone.nullish(),
        role: z.enum(['owner', 'manager', 'host', 'kitchen', 'front_of_house', 'read_only']),
        /** Venue slugs. Empty means every venue. */
        venueSlugs: z.array(z.string().regex(VENUE_SLUG)).max(20).default([]),
      }),
    )
    .max(100)
    .default([]),
});

export interface IntakeSectionDef {
  key: string;
  label: string;
  /** A required section must be complete before provisioning can start. */
  required: boolean;
  schema: z.ZodType;
}

export const intakeSections = { identity, brand, venues, services, operations, menu, floorPlan, comms, integrations, content, migration, criota, team };
export type IntakeSectionKey = keyof typeof intakeSections;

export const INTAKE_SECTIONS: ReadonlyArray<IntakeSectionDef & { key: IntakeSectionKey }> = [
  { key: 'identity', label: 'Identity and legal', required: true, schema: identity },
  { key: 'brand', label: 'Brand', required: true, schema: brand },
  { key: 'venues', label: 'Venues', required: true, schema: venues },
  { key: 'services', label: 'Service configuration', required: true, schema: services },
  { key: 'operations', label: 'Operations', required: false, schema: operations },
  { key: 'menu', label: 'Menu', required: false, schema: menu },
  { key: 'floorPlan', label: 'Floor plan', required: false, schema: floorPlan },
  { key: 'comms', label: 'Comms', required: false, schema: comms },
  { key: 'integrations', label: 'Integrations and payments', required: false, schema: integrations },
  { key: 'content', label: 'Content and policies', required: true, schema: content },
  { key: 'migration', label: 'Migration', required: false, schema: migration },
  { key: 'criota', label: 'Criota', required: false, schema: criota },
  { key: 'team', label: 'Team', required: false, schema: team },
];

/**
 * Who opened the onboarding. A platform one is provisioned from a finished intake. A self-serve
 * one (docs/PIPEDLINE.md section 1) starts from a name and an owner: the address, the hours, the
 * services and the copy are not known yet and are filled in afterwards, so its venue is a draft.
 */
export type OnboardingOrigin = 'platform' | 'self_serve';

const draftVenue = venue.partial({ addressLine1: true, suburb: true, state: true, postcode: true }).extend({ hours: tradingHoursInput.default([]) });

/** The sections as a self-serve start may leave them. Everything else is the same schema. */
const draftSections = {
  ...intakeSections,
  venues: z.object({ venues: z.array(draftVenue).min(1, 'Add at least one venue.').max(20) }),
  services: z.object({ services: z.array(z.enum(SERVICES)).default([]) }),
  content: content.partial({ about: true }),
};

/** What provisioning works from. A finished platform intake always has the fields a draft may lack. */
export type Intake = { [K in IntakeSectionKey]: z.infer<(typeof draftSections)[K]> };

export type SectionStatus = 'empty' | 'in_progress' | 'complete';

export interface SectionAssessment {
  status: SectionStatus;
  /** Fields still to fill in, as dotted paths (e.g. "primaryContact.email", "venues.0.hours"). */
  missing: string[];
  /** Values that are present and wrong. A save carrying any of these is refused. */
  invalid: Array<{ path: string; message: string }>;
}

function valueAt(data: unknown, path: PropertyKey[]): unknown {
  let v: unknown = data;
  for (const key of path) {
    if (v === null || typeof v !== 'object') return undefined;
    v = (v as Record<PropertyKey, unknown>)[key];
  }
  return v;
}

const isBlank = (v: unknown) => v === undefined || v === null || v === '' || (Array.isArray(v) && v.length === 0);
const isEmptySection = (data: unknown) => data === undefined || data === null || (typeof data === 'object' && !Array.isArray(data) && Object.keys(data as object).length === 0);

/**
 * How far along one section is. A problem with a value that is simply not there yet is
 * "missing"; a problem with a value that is there is "invalid".
 */
export function assessSection(key: IntakeSectionKey, data: unknown): SectionAssessment {
  const def = INTAKE_SECTIONS.find((s) => s.key === key)!;
  if (isEmptySection(data)) return { status: 'empty', missing: [], invalid: [] };
  const parsed = def.schema.safeParse(data);
  if (parsed.success) return { status: 'complete', missing: [], invalid: [] };
  const missing = new Set<string>();
  const bad: SectionAssessment['invalid'] = [];
  for (const issue of parsed.error.issues) {
    const path = issue.path.map(String).join('.');
    if (issue.code !== 'custom' && isBlank(valueAt(data, issue.path))) missing.add(path);
    else bad.push({ path, message: issue.message });
  }
  return { status: 'in_progress', missing: [...missing], invalid: bad };
}

export interface IntakeProgress {
  /** True when provisioning can start: every required section is complete and no optional one is half-filled. */
  complete: boolean;
  percentComplete: number;
  sections: Array<{ key: IntakeSectionKey; label: string; required: boolean; status: SectionStatus; missing: string[] }>;
  /** What still stands between this intake and provisioning, section by section. */
  stillNeeded: Array<{ section: IntakeSectionKey; label: string; missing: string[] }>;
}

export function intakeProgress(raw: unknown): IntakeProgress {
  const data = (raw ?? {}) as Record<string, unknown>;
  const sections = INTAKE_SECTIONS.map((def) => {
    const a = assessSection(def.key, data[def.key]);
    return { key: def.key, label: def.label, required: def.required, status: a.status, missing: [...a.missing, ...a.invalid.map((i) => i.path)] };
  });
  const stillNeeded = sections
    .filter((s) => (s.required ? s.status !== 'complete' : s.status === 'in_progress'))
    .map((s) => ({ section: s.key, label: s.label, missing: s.missing }));
  const required = sections.filter((s) => s.required);
  return {
    complete: stillNeeded.length === 0,
    percentComplete: Math.round((required.filter((s) => s.status === 'complete').length / required.length) * 100),
    sections,
    stillNeeded,
  };
}

/**
 * The whole intake, validated, with every default filled in. A platform intake throws when it is
 * not complete; a self-serve one is held to the draft shape only.
 */
export function parseIntake(raw: unknown, origin: OnboardingOrigin = 'platform'): Intake {
  if (origin === 'self_serve') {
    const data = (raw ?? {}) as Record<string, unknown>;
    const out: Record<string, unknown> = {};
    for (const def of INTAKE_SECTIONS) {
      const parsed = draftSections[def.key].safeParse(data[def.key] ?? {});
      if (!parsed.success) {
        const first = parsed.error.issues[0];
        throw invalid(`${def.label}: ${first?.message ?? 'not valid'}`, { issues: parsed.error.issues });
      }
      out[def.key] = parsed.data;
    }
    return out as Intake;
  }
  const progress = intakeProgress(raw);
  if (!progress.complete) {
    throw invalid(`The intake is not finished: ${progress.stillNeeded.map((s) => s.label).join(', ')}.`, { stillNeeded: progress.stillNeeded });
  }
  const data = (raw ?? {}) as Record<string, unknown>;
  const out: Record<string, unknown> = {};
  for (const def of INTAKE_SECTIONS) out[def.key] = def.schema.parse(data[def.key] ?? {});
  return out as Intake;
}

const slugify = (name: string) =>
  name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 40)
    .replace(/-+$/g, '') || 'venue';

/** The slug each intake venue gets, in order: its own, else "main" for the first and its name for the rest. */
export function intakeVenueSlugs(intake: Pick<Intake, 'venues'>): string[] {
  const used = new Set<string>();
  return intake.venues.venues.map((v, i) => {
    const base = v.slug ?? (i === 0 ? 'main' : slugify(v.name));
    let slug = base;
    for (let n = 2; used.has(slug); n++) slug = `${base.slice(0, 37)}-${n}`;
    used.add(slug);
    return slug;
  });
}

// ── Saving and reading (platform side) ─────────────────────────────────────────────────────

const MAX_SECTION_BYTES = 600_000;

export interface IntakeView extends IntakeProgress {
  onboardingId: string;
  orgId: string | null;
  status: string;
  version: number;
  /** Each section's saved answers, exactly as saved. */
  data: Partial<Record<IntakeSectionKey, unknown>>;
}

function toView(row: { id: string; org_id: string | null; status: string; intake: unknown; intake_version: number }): IntakeView {
  const data = (row.intake ?? {}) as Record<string, unknown>;
  return { onboardingId: row.id, orgId: row.org_id, status: row.status, version: row.intake_version, data, ...intakeProgress(data) };
}

const UUID = z.string().uuid();

async function loadOnboarding(app: App, onboardingId: string) {
  if (!UUID.safeParse(onboardingId).success) throw notFound('Onboarding not found');
  // Onboardings are platform records until the org exists, and the intake is filled in by us
  // or with us; tenant transactions never read another org's, and cannot read one with no org.
  const row = await app.db.selectFrom('onboardings').select(['id', 'org_id', 'status', 'intake', 'intake_version']).where('id', '=', onboardingId).executeTakeFirst();
  if (!row) throw notFound('Onboarding not found');
  return row;
}

export const startOnboardingInput = z.object({
  tradingName: plainText(200),
  contactEmail: email.optional(),
  contactFirstName: plainText(80).optional(),
  /** When the venue was sold. Defaults to now; time-to-live is measured from here. */
  soldAt: z.date().optional(),
});

/** Open an onboarding at "sold". The org does not exist yet: provisioning creates it from the finished intake. */
export async function startOnboarding(app: App, actor: Principal, raw: z.input<typeof startOnboardingInput>): Promise<IntakeView> {
  await requirePlatformAdmin(app, actor);
  const input = startOnboardingInput.parse(raw);
  const intake = {
    identity: {
      tradingName: input.tradingName,
      ...(input.contactEmail || input.contactFirstName ? { primaryContact: { ...(input.contactEmail ? { email: input.contactEmail } : {}), ...(input.contactFirstName ? { firstName: input.contactFirstName } : {}) } } : {}),
    },
  };
  const row = await app.db
    .insertInto('onboardings')
    .values({ org_id: null, status: 'intake', intake: json(intake), intake_progress: json(progressRecord(intake, app.clock())), intake_version: INTAKE_VERSION, sold_at: input.soldAt ?? app.clock() })
    .returning(['id', 'org_id', 'status', 'intake', 'intake_version'])
    .executeTakeFirstOrThrow();
  return toView(row);
}

function progressRecord(intake: Record<string, unknown>, now: Date): Record<string, { status: SectionStatus; missing: string[]; at: string }> {
  const out: Record<string, { status: SectionStatus; missing: string[]; at: string }> = {};
  for (const s of intakeProgress(intake).sections) out[s.key] = { status: s.status, missing: s.missing, at: now.toISOString() };
  return out;
}

export const saveIntakeSectionInput = z.object({
  onboardingId: z.string(),
  section: z.enum(INTAKE_SECTIONS.map((s) => s.key) as [IntakeSectionKey, ...IntakeSectionKey[]]),
  data: z.unknown(),
});

/**
 * Save one section, finished or not. Everything present must be valid (a bad email, markup in
 * a text field, an unreadable colour pair are refused with the reason); anything absent is
 * recorded as still missing. Returns the whole intake's progress.
 */
export async function saveIntakeSection(app: App, actor: Principal, raw: z.input<typeof saveIntakeSectionInput>): Promise<IntakeView> {
  await requirePlatformAdmin(app, actor);
  const input = saveIntakeSectionInput.parse(raw);
  const row = await loadOnboarding(app, input.onboardingId);
  if (input.data === null || typeof input.data !== 'object' || Array.isArray(input.data)) throw invalid('A section is saved as a set of answers.');
  if (JSON.stringify(input.data).length > MAX_SECTION_BYTES) throw invalid('That is too much to save in one section.');
  if (input.section === 'identity' && row.org_id) {
    const before = ((row.intake ?? {}) as Record<string, { slug?: string }>).identity?.slug;
    if ((input.data as { slug?: string }).slug !== before) throw invalid('The site address cannot be changed here once the organisation has been created.');
  }

  const assessment = assessSection(input.section, input.data);
  if (assessment.invalid.length) {
    const first = assessment.invalid[0]!;
    throw invalid(`${first.path ? `${first.path}: ` : ''}${first.message}`, { issues: assessment.invalid });
  }

  const intake = { ...((row.intake ?? {}) as Record<string, unknown>), [input.section]: input.data };
  const updated = await app.db
    .updateTable('onboardings')
    .set({ intake: json(intake), intake_progress: json(progressRecord(intake, app.clock())), intake_version: INTAKE_VERSION })
    .where('id', '=', row.id)
    .returning(['id', 'org_id', 'status', 'intake', 'intake_version'])
    .executeTakeFirstOrThrow();
  return toView(updated);
}

/** The intake as the wizard shows it: every section's answers, its progress, and what is still missing. */
export async function getIntake(app: App, actor: Principal, input: { onboardingId: string }): Promise<IntakeView> {
  await requirePlatformAdmin(app, actor);
  return toView(await loadOnboarding(app, input.onboardingId));
}
