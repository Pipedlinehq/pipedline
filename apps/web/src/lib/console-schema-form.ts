import 'server-only';
import { z } from 'zod';

/**
 * A settings form generated from a module's zod config schema (via its JSON Schema), so every
 * module's options can be changed without a hand-built page per module. The form only proposes
 * values: setModule validates the merged config against the real zod schema.
 */
export type FieldSpec =
  | { kind: 'boolean'; path: string; label: string; hint?: string; value: boolean }
  | { kind: 'number'; path: string; label: string; hint?: string; value: number | null; min?: number; max?: number; integer: boolean; nullable: boolean; money: boolean }
  | { kind: 'text'; path: string; label: string; hint?: string; value: string | null; nullable: boolean; format?: string }
  | { kind: 'select'; path: string; label: string; hint?: string; value: string | null; options: string[]; nullable: boolean }
  | { kind: 'multi'; path: string; label: string; hint?: string; value: string[]; options: string[] }
  | { kind: 'list'; path: string; label: string; hint?: string; value: Array<string | number>; itemType: 'string' | 'number' }
  | { kind: 'group'; path: string; label: string; fields: FieldSpec[] }
  | { kind: 'readonly'; path: string; label: string; hint?: string; value: unknown };

type JS = {
  type?: string | string[];
  anyOf?: JS[];
  enum?: unknown[];
  items?: JS;
  properties?: Record<string, JS>;
  additionalProperties?: unknown;
  minimum?: number;
  maximum?: number;
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

function rangeHint(s: JS, money: boolean): string | undefined {
  const fmt = (n: number) => (money ? `$${(n / 100).toLocaleString('en-AU')}` : n.toLocaleString('en-AU'));
  const big = (n: number | undefined) => n === undefined || n >= 1e12;
  if (s.minimum !== undefined && !big(s.maximum)) return `From ${fmt(s.minimum)} to ${fmt(s.maximum!)}.`;
  if (s.minimum !== undefined && s.minimum > 0) return `At least ${fmt(s.minimum)}.`;
  return undefined;
}

function specFor(key: string, path: string, raw: JS, value: unknown): FieldSpec {
  const label = humanLabel(key);
  const { schema: s, nullable } = unwrapNullable(raw);
  const type = Array.isArray(s.type) ? undefined : s.type;
  if (type === 'boolean') return { kind: 'boolean', path, label, value: value === true };
  if (type === 'integer' || type === 'number') {
    const money = key.endsWith('_cents') || key.endsWith('Cents');
    return {
      kind: 'number',
      path,
      label,
      hint: rangeHint(s, money),
      value: typeof value === 'number' ? value : null,
      min: s.minimum,
      max: s.maximum !== undefined && s.maximum < 1e12 ? s.maximum : undefined,
      integer: type === 'integer',
      nullable,
      money,
    };
  }
  if (type === 'string' && s.enum) return { kind: 'select', path, label, value: typeof value === 'string' ? value : null, options: s.enum.map(String), nullable };
  if (type === 'string') return { kind: 'text', path, label, value: typeof value === 'string' ? value : null, nullable, format: s.format };
  if (type === 'array' && s.items && !nullable) {
    const item = unwrapNullable(s.items).schema;
    if (item.type === 'string' && item.enum) return { kind: 'multi', path, label, value: Array.isArray(value) ? value.map(String) : [], options: item.enum.map(String) };
    if (item.type === 'string' || item.type === 'integer' || item.type === 'number') {
      return { kind: 'list', path, label, hint: 'Separate with commas.', value: Array.isArray(value) ? (value as Array<string | number>) : [], itemType: item.type === 'string' ? 'string' : 'number' };
    }
  }
  if (type === 'object' && s.properties && !s.additionalProperties && !nullable) {
    const v = (value && typeof value === 'object' ? value : {}) as Record<string, unknown>;
    return { kind: 'group', path, label, fields: Object.entries(s.properties).map(([k, sub]) => specFor(k, `${path}.${k}`, sub, v[k])) };
  }
  return { kind: 'readonly', path, label, hint: 'Changed through its own screen or by support; shown here for reference.', value };
}

/** The form fields for a config schema, filled with the current values. */
export function formSpec(schema: z.ZodType, current: unknown): FieldSpec[] {
  let js: JS;
  try {
    js = z.toJSONSchema(schema, { io: 'input', unrepresentable: 'any' }) as JS;
  } catch {
    return [{ kind: 'readonly', path: 'cfg', label: 'Settings', value: current }];
  }
  const v = (current && typeof current === 'object' ? current : {}) as Record<string, unknown>;
  return Object.entries(js.properties ?? {}).map(([k, sub]) => specFor(k, `cfg.${k}`, sub, v[k]));
}

/**
 * Read the submitted form back into a partial config, following the same spec. Only editable
 * top-level keys are returned, so a read-only value is left as stored.
 */
export function readForm(fields: FieldSpec[], fd: FormData): { config: Record<string, unknown>; errors: string[] } {
  const errors: string[] = [];
  const read = (f: FieldSpec): unknown => {
    const raw = fd.get(f.path);
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
        return str === '' ? (f.nullable ? null : undefined) : str;
      case 'multi':
        return fd.getAll(f.path).filter((x): x is string => typeof x === 'string' && f.options.includes(x));
      case 'list': {
        const parts = str.split(',').map((p) => p.trim()).filter(Boolean);
        if (f.itemType === 'string') return parts;
        const nums = parts.map(Number);
        if (nums.some((n) => !Number.isFinite(n))) errors.push(`${f.label}: use numbers separated by commas.`);
        return nums;
      }
      case 'group':
        return Object.fromEntries(f.fields.filter((x) => x.kind !== 'readonly').map((x) => [x.path.split('.').at(-1)!, read(x)]));
      case 'readonly':
        return undefined;
    }
  };
  const config: Record<string, unknown> = {};
  for (const f of fields) {
    if (f.kind === 'readonly') continue;
    const v = read(f);
    if (v !== undefined) config[f.path.slice('cfg.'.length)] = v;
  }
  return { config, errors };
}
