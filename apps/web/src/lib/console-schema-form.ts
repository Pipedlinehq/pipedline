import 'server-only';
import { z } from 'zod';

/**
 * A settings form generated from a module's zod config schema (via its JSON Schema), so every
 * module's options can be changed without a hand-built page per module. Each field's hint is the
 * schema's own `.describe()` text: the words an assistant reads in `plugins_list` are the words a
 * person reads here. The form only proposes values: the service validates the merged config
 * against the real zod schema and says which setting is wrong and why.
 */
export type FieldSpec =
  | { kind: 'boolean'; path: string; label: string; hint?: string; value: boolean }
  | { kind: 'number'; path: string; label: string; hint?: string; value: number | null; min?: number; max?: number; integer: boolean; nullable: boolean; money: boolean }
  | { kind: 'text'; path: string; label: string; hint?: string; value: string | null; nullable: boolean; format?: string; maxLength?: number }
  | { kind: 'select'; path: string; label: string; hint?: string; value: string | null; options: string[]; nullable: boolean; numeric?: boolean }
  | { kind: 'multi'; path: string; label: string; hint?: string; value: string[]; options: string[] }
  | { kind: 'list'; path: string; label: string; hint?: string; value: Array<string | number>; itemType: 'string' | 'number' }
  | { kind: 'group'; path: string; label: string; hint?: string; fields: FieldSpec[] }
  /** A list of same-shaped records (service periods, sitting lengths): a small table with room to add. */
  | { kind: 'rows'; path: string; label: string; hint?: string; columns: RowColumn[]; value: Array<Record<string, unknown>>; max: number }
  | { kind: 'readonly'; path: string; label: string; hint?: string; value: unknown };

/** One column of a `rows` field: a primitive field whose `path` is the record's key. */
export type RowColumn = Extract<FieldSpec, { kind: 'boolean' | 'number' | 'text' | 'select' | 'multi' }> & { required: boolean };

export type JS = {
  type?: string | string[];
  anyOf?: JS[];
  enum?: unknown[];
  const?: unknown;
  items?: JS;
  properties?: Record<string, JS>;
  required?: string[];
  additionalProperties?: unknown;
  minimum?: number;
  maximum?: number;
  maxItems?: number;
  maxLength?: number;
  format?: string;
  description?: string;
};

/** Plain words for option keys whose generated label would read badly. */
const LABELS: Record<string, string> = {
  smsQuietHours: 'No marketing SMS between (venue time)',
  start: 'From',
  end: 'Until',
  dailyMarketingEmailCap: 'Most marketing emails a day',
  dailyMarketingSmsCap: 'Most marketing SMS a day',
  replyToEmail: 'Replies go to',
  senderAddressLine: 'Sender address (shown at the foot of marketing)',
  asap_enabled: 'Offer "as soon as possible"',
  max_items_per_slot: 'Most items per slot',
  max_orders_per_slot: 'Most orders per slot',
  cutoff_before_close_minutes: 'Stop taking orders this many minutes before close',
  lead_time_minutes: 'Lead time (minutes)',
  max_days_ahead: 'Days ahead a guest may order',
  tip_presets: 'Tip presets (%)',
  max_tip_percent: 'Largest tip (%)',
  min_order_cents: 'Minimum order',
  kitchen_routing: 'Send new orders to',
  manager_sms: 'Manager mobile for alerts',
  alert_repeat_seconds: 'Repeat the new-order alert every (seconds)',
  auto_accept: 'Accept paid orders automatically',
  payment_hold_minutes: 'Hold an unpaid checkout for (minutes)',
  stage: 'What guests can do from the table',
  require_table: 'Table codes must name a table',
  session_idle_minutes: 'Close an idle table session after (minutes)',
  receipt_email_prompt: 'Offer an emailed receipt',
  loyalty_prompt: 'Invite guests to join loyalty',
  earnHere: 'Guests earn points here',
  earnChannels: 'Channels that earn points',
  earnLookbackHours: 'Claim a past sale up to (hours)',
  redeemHere: 'Guests can redeem rewards here',
  redemptionExpiryMinutes: 'A redemption code lasts (minutes)',
  lateSaleGraceMinutes: 'Match a sale that arrives late by up to (minutes)',
  matchByAmount: 'Match till sales to redemptions by amount',
  allowStaffForceConfirm: 'Staff may force-confirm a redemption',
  identifyBy: 'Find a member by',
  counterEnrolment: 'Staff may enrol guests at the counter',
  ownerAdjustmentAbovePoints: 'Adjustments above this many points need an owner',
  acceptHere: 'Accept offer codes here',
  matchTillDiscounts: 'Match till discounts to offer codes',
  staffRedeem: 'Staff may redeem codes at the counter',
  bulkIssueMax: 'Most codes issued at once',
  paymentGraceMinutes: 'Grace period for payment (minutes)',
  enabledBlocks: 'Blocks available on pages',
  navItems: 'Navigation links',
  bookingCtaTarget: 'Booking button link',
  orderCtaTarget: 'Order button link',
  socialLinks: 'Social links',
  googleBusiness: 'Google Business profile',
  googleAnalyticsId: 'Google Analytics ID',
  metaPixelId: 'Meta pixel ID',
  googleSiteVerification: 'Google site verification token',
  agent_access_enabled: 'Assistants may connect to this venue',
  allowed_scopes: 'Permissions assistants may use (patterns)',
  guest_level_reads_enabled: 'Assistants may read individual guests',
  max_keys_per_staff: 'Most keys per person',
  key_max_lifetime_days: 'Longest a key may last (days)',
  write_confirmation_ttl_minutes: 'A confirmation question stays open for (minutes)',
  enabled_plugs: 'Connected services offered to assistants',
  criota_share_enabled: 'Share campaign outcomes (totals only) with Criota',
  criota_min_cohort: 'Smallest group of guests a shared figure may describe',
  hosted_agents: 'Hosted agents switched on',
  autonomy_level_per_agent: 'How far each hosted agent may go',
  ops_order_waiting_minutes: 'Report a paid order nobody accepted after (minutes)',
  ops_quiet_min_usual_sales: 'Report a quiet service when there are usually at least this many sales',
  // Bookings
  service_periods: 'Services guests can book',
  last_booking_before_close_minutes: 'Last booking before a service ends (minutes)',
  slot_minutes: 'Gap between bookable times (minutes)',
  max_covers_per_slot: 'Most covers starting in one time slot',
  max_covers_per_service: 'Most covers across one service',
  max_covers_seated: 'Most covers seated at the same time',
  max_party_size_online: 'Largest party that may book online',
  sitting_minutes: 'Typical sitting length by party size',
  booking_window_days: 'Days ahead guests may book',
  cutoff_minutes: 'Cut-off before a bookable time (minutes)',
  auto_confirm: 'Confirm bookings automatically',
  phone_number: 'Ask guests for a phone number',
  booking_note: 'Note shown to guests when they book',
  send_reminders: 'Remind confirmed guests',
  reminder_hours_before: 'Reminder goes out (hours before)',
  name: 'Name',
  days: 'Days',
  starts_at: 'Starts',
  ends_at: 'Ends',
  last_booking_at: 'Last booking',
  up_to_party_size: 'Up to a party of',
  minutes: 'Minutes',
  // Guests' assistants
  visible_menus: 'Menus guests\' assistants may show',
  offer_bookings: 'Assistants may book a table',
  offer_ordering: 'Assistants may start a pickup order',
  assistant_note: 'Note shown to guests\' assistants',
};

export function humanLabel(key: string): string {
  if (LABELS[key]) return LABELS[key]!;
  const words = key
    .replace(/_cents$/, '')
    .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
    .replace(/[_-]+/g, ' ')
    .trim()
    .toLowerCase();
  return words.charAt(0).toUpperCase() + words.slice(1);
}

function unwrapNullable(s: JS): { schema: JS; nullable: boolean } {
  if (s.anyOf) {
    const rest = s.anyOf.filter((x) => x.type !== 'null');
    if (rest.length === 1 && rest.length < s.anyOf.length) return { schema: { ...rest[0]!, ...(s.description ? { description: s.description } : {}) }, nullable: true };
  }
  if (Array.isArray(s.type)) {
    const types = s.type.filter((t) => t !== 'null');
    if (types.length === 1) return { schema: { ...s, type: types[0] }, nullable: s.type.includes('null') };
  }
  return { schema: s, nullable: false };
}

/** A union of literals (`z.union([z.literal(15), z.literal(30)])`) is a choice; zod writes it as anyOf of consts. */
function literalChoices(s: JS): unknown[] | null {
  if (s.enum) return s.enum;
  if (s.anyOf && s.anyOf.length && s.anyOf.every((x) => x.const !== undefined)) return s.anyOf.map((x) => x.const);
  return null;
}

function rangeHint(s: JS, money: boolean): string | undefined {
  const fmt = (n: number) => (money ? `$${(n / 100).toLocaleString('en-AU')}` : n.toLocaleString('en-AU'));
  const big = (n: number | undefined) => n === undefined || n >= 1e12;
  if (s.minimum !== undefined && !big(s.maximum)) return `From ${fmt(s.minimum)} to ${fmt(s.maximum!)}.`;
  if (s.minimum !== undefined && s.minimum > 0) return `At least ${fmt(s.minimum)}.`;
  return undefined;
}

const joinHints = (...parts: Array<string | undefined>) => parts.filter(Boolean).join(' ') || undefined;

const PRIMITIVE_KINDS = new Set(['boolean', 'number', 'text', 'select', 'multi']);

function specFor(key: string, path: string, raw: JS, value: unknown): FieldSpec {
  const label = humanLabel(key);
  const { schema: s, nullable } = unwrapNullable(raw);
  const description = raw.description ?? s.description;
  const type = Array.isArray(s.type) ? undefined : s.type;
  const choices = literalChoices(s);
  if (type === 'boolean') return { kind: 'boolean', path, label, hint: description, value: value === true };
  if (choices && choices.every((c) => typeof c === 'number')) {
    return { kind: 'select', path, label, hint: description, value: typeof value === 'number' ? String(value) : null, options: choices.map(String), nullable, numeric: true };
  }
  if (type === 'integer' || type === 'number') {
    const money = key.endsWith('_cents') || key.endsWith('Cents');
    return {
      kind: 'number',
      path,
      label,
      hint: joinHints(description, rangeHint(s, money)),
      value: typeof value === 'number' ? value : null,
      min: s.minimum,
      max: s.maximum !== undefined && s.maximum < 1e12 ? s.maximum : undefined,
      integer: type === 'integer',
      nullable,
      money,
    };
  }
  if (type === 'string' && choices) return { kind: 'select', path, label, hint: description, value: typeof value === 'string' ? value : null, options: choices.map(String), nullable };
  if (type === 'string') return { kind: 'text', path, label, hint: description, value: typeof value === 'string' ? value : null, nullable, format: s.format, maxLength: s.maxLength };
  if (type === 'array' && s.items && !nullable) {
    const item = unwrapNullable(s.items).schema;
    const itemChoices = literalChoices(item);
    if (item.type === 'string' && itemChoices) return { kind: 'multi', path, label, hint: description, value: Array.isArray(value) ? value.map(String) : [], options: itemChoices.map(String) };
    if (item.type === 'string' || item.type === 'integer' || item.type === 'number') {
      return { kind: 'list', path, label, hint: joinHints(description, 'Separate with commas.'), value: Array.isArray(value) ? (value as Array<string | number>) : [], itemType: item.type === 'string' ? 'string' : 'number' };
    }
    if (item.type === 'object' && item.properties) {
      const required = new Set(item.required ?? []);
      const columns: RowColumn[] = [];
      for (const [k, sub] of Object.entries(item.properties)) {
        const col = specFor(k, k, sub, undefined);
        if (!PRIMITIVE_KINDS.has(col.kind)) return { kind: 'readonly', path, label, hint: description, value };
        columns.push({ ...(col as Extract<FieldSpec, { kind: 'boolean' | 'number' | 'text' | 'select' | 'multi' }>), required: required.has(k) && !('nullable' in col && col.nullable) });
      }
      const rows = Array.isArray(value) ? (value.filter((r) => r && typeof r === 'object') as Array<Record<string, unknown>>) : [];
      return { kind: 'rows', path, label, hint: description, columns, value: rows, max: Math.min(s.maxItems ?? 20, 40) };
    }
  }
  if (type === 'object' && s.properties && !s.additionalProperties && !nullable) {
    const v = (value && typeof value === 'object' ? value : {}) as Record<string, unknown>;
    return { kind: 'group', path, label, hint: description, fields: Object.entries(s.properties).map(([k, sub]) => specFor(k, `${path}.${k}`, sub, v[k])) };
  }
  return { kind: 'readonly', path, label, hint: joinHints(description, 'Changed through its own screen or by support; shown here for reference.'), value };
}

/** The form fields for a config schema, filled with the current values. */
export function formSpec(schema: z.ZodType, current: unknown): FieldSpec[] {
  let js: JS;
  try {
    js = z.toJSONSchema(schema, { io: 'input', unrepresentable: 'any' }) as JS;
  } catch {
    return [{ kind: 'readonly', path: 'cfg', label: 'Settings', value: current }];
  }
  return formSpecFromJson(js, current);
}

/** As formSpec, from the JSON Schema a catalogue entry carries (tenancy.listPlugins' `settingsSchema`). */
export function formSpecFromJson(js: JS, current: unknown): FieldSpec[] {
  const v = (current && typeof current === 'object' ? current : {}) as Record<string, unknown>;
  return Object.entries(js.properties ?? {}).map(([k, sub]) => specFor(k, `cfg.${k}`, sub, v[k]));
}

/**
 * Read the submitted form back into a partial config, following the same spec. Only editable
 * top-level keys are returned, so a read-only value is left as stored.
 */
export function readForm(fields: FieldSpec[], fd: FormData): { config: Record<string, unknown>; errors: string[] } {
  const errors: string[] = [];
  /** `current` is the stored value, used only to keep a multi-choice in its stored order: a re-saved form must not read as a change. */
  const readAt = (f: FieldSpec, name: string, current?: unknown): unknown => {
    const raw = fd.get(name);
    const str = typeof raw === 'string' ? raw.trim() : '';
    switch (f.kind) {
      case 'boolean':
        return raw === 'on';
      case 'number': {
        if (str === '') {
          if (f.nullable) return null;
          errors.push(`${f.label}: enter a number.`);
          return undefined;
        }
        const n = Number(str.replace(/[$,\s]/g, ''));
        if (!Number.isFinite(n)) {
          errors.push(`${f.label}: "${str}" is not a number.`);
          return undefined;
        }
        return f.money ? Math.round(n * 100) : f.integer ? Math.trunc(n) : n;
      }
      case 'text':
        return str === '' ? (f.nullable ? null : '') : str;
      case 'select':
        if (str === '') return f.nullable ? null : undefined;
        return f.numeric ? Number(str) : str;
      case 'multi': {
        const chosen = fd.getAll(name).filter((x): x is string => typeof x === 'string' && f.options.includes(x));
        const ref = Array.isArray(current) ? current.map(String) : f.value;
        return [...ref.filter((x) => chosen.includes(x)), ...chosen.filter((x) => !ref.includes(x))];
      }
      case 'list': {
        const parts = str.split(',').map((p) => p.trim()).filter(Boolean);
        if (f.itemType === 'string') return parts;
        const nums = parts.map(Number);
        if (nums.some((n) => !Number.isFinite(n))) errors.push(`${f.label}: use numbers separated by commas.`);
        return nums;
      }
      case 'group':
        return Object.fromEntries(f.fields.filter((x) => x.kind !== 'readonly').map((x) => [x.path.split('.').at(-1)!, readAt(x, x.path, x.kind === 'multi' ? x.value : undefined)]));
      case 'rows': {
        const rows: Array<Record<string, unknown>> = [];
        for (let i = 0; i < f.max; i++) {
          const prefix = `${name}.${i}.`;
          // A row that was left blank is no row. A row with anything in it is read whole, so a missing required cell is said by the schema.
          const touched = f.columns.some((col) => (col.kind === 'multi' ? fd.getAll(prefix + col.path).length > 0 : col.kind === 'boolean' ? false : String(fd.get(prefix + col.path) ?? '').trim() !== ''));
          if (!touched) continue;
          const row: Record<string, unknown> = {};
          for (const col of f.columns) {
            const v = readAt(col, prefix + col.path, f.value[i]?.[col.path]);
            if (v !== undefined) row[col.path] = v;
          }
          rows.push(row);
        }
        return rows;
      }
      case 'readonly':
        return undefined;
    }
  };
  const config: Record<string, unknown> = {};
  for (const f of fields) {
    if (f.kind === 'readonly') continue;
    const v = readAt(f, f.path, f.kind === 'multi' ? f.value : undefined);
    if (v !== undefined) config[f.path.slice('cfg.'.length)] = v;
  }
  return { config, errors };
}
