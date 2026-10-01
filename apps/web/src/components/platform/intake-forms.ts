/**
 * How each intake section is edited in the platform wizard. The section's zod schema in
 * onboarding/intake.ts is the contract and is what validates; this only says which fields get a
 * plain form control and where each value goes. Every section can also be edited as JSON, which
 * is how the nested parts (a second venue, the floor plan, the team list) are entered for now.
 */

export type FieldKind = 'text' | 'email' | 'url' | 'textarea' | 'checkbox' | 'select' | 'checkboxes' | 'color' | 'lines' | 'number' | 'hours';

export interface FieldDef {
  name: string;
  label: string;
  kind: FieldKind;
  /** Where the value lives in the section's answers. Numbers index arrays. */
  path: Array<string | number>;
  options?: Array<{ value: string; label: string }>;
  hint?: string;
}

const DAYS = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
const TIMEZONES = ['Australia/Sydney', 'Australia/Melbourne', 'Australia/Brisbane', 'Australia/Adelaide', 'Australia/Perth', 'Australia/Hobart', 'Australia/Darwin', 'Pacific/Auckland'];
const SKELETONS = ['hero-photo', 'editorial', 'menu-forward', 'minimal', 'split-panel', 'single-scroll'];
const SERVICES = ['dine-in', 'pickup', 'delivery', 'catering', 'functions'];

const v0 = (k: string): Array<string | number> => ['venues', 0, k];

export const SECTION_FIELDS: Partial<Record<string, FieldDef[]>> = {
  identity: [
    { name: 'legalName', label: 'Legal entity name', kind: 'text', path: ['legalName'] },
    { name: 'tradingName', label: 'Trading name', kind: 'text', path: ['tradingName'] },
    { name: 'slug', label: 'Site address (subdomain)', kind: 'text', path: ['slug'], hint: '3 to 40 lowercase letters, numbers or hyphens. The site goes live at <slug>.<platform domain>.' },
    { name: 'abn', label: 'ABN', kind: 'text', path: ['abn'] },
    { name: 'registeredAddress', label: 'Registered address', kind: 'text', path: ['registeredAddress'] },
    { name: 'gstRegistered', label: 'Registered for GST', kind: 'checkbox', path: ['gstRegistered'] },
    { name: 'pcFirst', label: 'Primary contact: first name', kind: 'text', path: ['primaryContact', 'firstName'] },
    { name: 'pcLast', label: 'Primary contact: last name', kind: 'text', path: ['primaryContact', 'lastName'] },
    { name: 'pcRole', label: 'Primary contact: role', kind: 'text', path: ['primaryContact', 'role'] },
    { name: 'pcMobile', label: 'Primary contact: mobile', kind: 'text', path: ['primaryContact', 'mobile'] },
    { name: 'pcEmail', label: 'Primary contact: email (becomes the owner)', kind: 'email', path: ['primaryContact', 'email'] },
  ],
  brand: [
    { name: 'skeleton', label: 'Layout skeleton', kind: 'select', path: ['skeleton'], options: SKELETONS.map((s) => ({ value: s, label: s })) },
    { name: 'primary', label: 'Primary colour', kind: 'color', path: ['tokens', 'colour', 'primary'] },
    { name: 'accent', label: 'Accent colour', kind: 'color', path: ['tokens', 'colour', 'accent'] },
    { name: 'toneOfVoice', label: 'Tone of voice (3–4 sentences in their voice)', kind: 'textarea', path: ['toneOfVoice'] },
    { name: 'logoSvg', label: 'Logo (SVG) address', kind: 'url', path: ['logo', 'svgUrl'] },
    { name: 'hero', label: 'Hero photograph address', kind: 'url', path: ['photography', 'hero'] },
  ],
  venues: [
    { name: 'name', label: 'Venue name', kind: 'text', path: v0('name') },
    { name: 'addressLine1', label: 'Street address', kind: 'text', path: v0('addressLine1') },
    { name: 'suburb', label: 'Suburb', kind: 'text', path: v0('suburb') },
    { name: 'state', label: 'State', kind: 'text', path: v0('state') },
    { name: 'postcode', label: 'Postcode', kind: 'text', path: v0('postcode') },
    { name: 'phone', label: 'Phone', kind: 'text', path: v0('phone') },
    { name: 'email', label: 'Public email', kind: 'email', path: v0('email') },
    { name: 'timezone', label: 'Time zone', kind: 'select', path: v0('timezone'), options: TIMEZONES.map((t) => ({ value: t, label: t })) },
    { name: 'capacity', label: 'Capacity (seats)', kind: 'number', path: v0('capacity') },
    { name: 'hours', label: 'Trading hours', kind: 'hours', path: v0('hours'), hint: 'One window for the days ticked. Split shifts and other services: use the JSON editor.' },
  ],
  services: [{ name: 'services', label: 'Services offered', kind: 'checkboxes', path: ['services'], options: SERVICES.map((s) => ({ value: s, label: s })) }],
  content: [
    { name: 'tagline', label: 'Tagline', kind: 'text', path: ['tagline'] },
    { name: 'about', label: 'About / story', kind: 'textarea', path: ['about'] },
  ],
  comms: [
    { name: 'sendingDomain', label: 'Marketing sending domain', kind: 'text', path: ['sendingDomain'], hint: 'e.g. mail.bellatrattoria.com.au. Start this on day one: DNS has lead time.' },
    { name: 'fromName', label: 'From name', kind: 'text', path: ['fromName'] },
    { name: 'smsSenderId', label: 'SMS sender id', kind: 'text', path: ['smsSenderId'] },
    { name: 'replyToEmail', label: 'Reply-to address', kind: 'email', path: ['replyToEmail'] },
  ],
  migration: [
    { name: 'existingSiteUrl', label: 'Current site address', kind: 'url', path: ['existingSiteUrl'] },
    { name: 'customDomain', label: 'Custom domain to move to', kind: 'text', path: ['customDomain'] },
    { name: 'sitemapUrls', label: 'Old site addresses, one per line (for the 301 map)', kind: 'lines', path: ['sitemapUrls'] },
  ],
};

export const DAY_OPTIONS = DAYS.map((d, i) => ({ value: String(i), label: d }));

export function getAt(data: unknown, path: Array<string | number>): unknown {
  let v: unknown = data;
  for (const k of path) {
    if (v === null || typeof v !== 'object') return undefined;
    v = (v as Record<string | number, unknown>)[k];
  }
  return v;
}

function setAt(data: Record<string, unknown>, path: Array<string | number>, value: unknown): void {
  let o: Record<string | number, unknown> = data;
  for (const [i, k] of path.entries()) {
    const last = i === path.length - 1;
    if (last) {
      if (value === undefined) delete o[k];
      else o[k] = value;
      return;
    }
    const nextIsIndex = typeof path[i + 1] === 'number';
    if (o[k] === null || typeof o[k] !== 'object') o[k] = nextIsIndex ? [] : {};
    o = o[k] as Record<string | number, unknown>;
  }
}

/** Remove objects left empty by blank fields, so an untouched part reads as missing rather than wrong. */
function prune(v: unknown): unknown {
  if (Array.isArray(v)) return v.map(prune).filter((x) => x !== undefined);
  if (v && typeof v === 'object') {
    const out: Record<string, unknown> = {};
    for (const [k, x] of Object.entries(v)) {
      const p = prune(x);
      if (p !== undefined) out[k] = p;
    }
    return Object.keys(out).length ? out : undefined;
  }
  return v;
}

export interface HoursValue {
  days: number[];
  opensAt: string;
  closesAt: string;
  serviceType: string;
}

export function hoursFrom(v: unknown): HoursValue {
  const rows = Array.isArray(v) ? (v as Array<{ dayOfWeek?: number; opensAt?: string; closesAt?: string; serviceType?: string }>) : [];
  return {
    days: [...new Set(rows.map((r) => Number(r.dayOfWeek)).filter((d) => d >= 0 && d <= 6))],
    opensAt: rows[0]?.opensAt?.slice(0, 5) ?? '',
    closesAt: rows[0]?.closesAt?.slice(0, 5) ?? '',
    serviceType: rows[0]?.serviceType ?? 'all',
  };
}

/** The section's answers from the submitted form, on top of what was saved before (fields not on the form are kept). */
export function sectionFromForm(section: string, form: FormData, previous: unknown): Record<string, unknown> {
  const fields = SECTION_FIELDS[section] ?? [];
  const data = structuredClone((previous && typeof previous === 'object' ? previous : {}) as Record<string, unknown>);
  for (const f of fields) {
    const raw = form.get(f.name);
    const text = typeof raw === 'string' ? raw.trim() : '';
    switch (f.kind) {
      case 'checkbox':
        setAt(data, f.path, form.get(f.name) === 'on');
        break;
      case 'checkboxes': {
        const all = form.getAll(f.name).map(String);
        setAt(data, f.path, all.length ? all : undefined);
        break;
      }
      case 'lines': {
        const lines = text.split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
        setAt(data, f.path, lines.length ? lines : undefined);
        break;
      }
      case 'number':
        setAt(data, f.path, text ? Number(text) : undefined);
        break;
      case 'color':
        setAt(data, f.path, text ? text.toUpperCase() : undefined);
        break;
      case 'hours': {
        const days = form.getAll(`${f.name}_day`).map(Number);
        const opensAt = String(form.get(`${f.name}_opens`) ?? '').trim();
        const closesAt = String(form.get(`${f.name}_closes`) ?? '').trim();
        const serviceType = String(form.get(`${f.name}_service`) ?? '').trim() || 'all';
        setAt(data, f.path, days.length && opensAt && closesAt ? days.map((dayOfWeek) => ({ dayOfWeek, opensAt, closesAt, serviceType })) : undefined);
        break;
      }
      default:
        setAt(data, f.path, text || undefined);
    }
  }
  return (prune(data) as Record<string, unknown> | undefined) ?? {};
}
