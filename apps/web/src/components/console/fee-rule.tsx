'use client';

import { useState } from 'react';

/**
 * What the guest pays for delivery. One control for the venue's rule and for a zone's own rule
 * (a zone may also just follow the venue). Only the inputs the chosen rule uses are shown; the
 * server reads the same names and ignores the rest.
 */
export type FeeRuleValue =
  | { kind: 'pass_through' }
  | { kind: 'flat'; cents: number }
  | { kind: 'subsidised'; venue_pays_up_to_cents: number }
  | { kind: 'free_above'; threshold_cents: number; otherwise: { kind: 'pass_through' } | { kind: 'flat'; cents: number } | { kind: 'subsidised'; venue_pays_up_to_cents: number } };

const control = 'block h-10 w-full rounded-md border border-line-strong bg-surface px-3 text-sm text-ink';
const dollars = (cents: number | undefined) => (cents === undefined ? '' : (cents / 100).toFixed(2));

const KINDS: Array<[string, string]> = [
  ['pass_through', 'The guest pays what the courier charges'],
  ['flat', 'A flat fee'],
  ['subsidised', 'We pay part of the courier’s fee'],
];

export function FeeRuleFields({ value, allowInherit = false, prefix = 'fee' }: { value: FeeRuleValue | null; allowInherit?: boolean; prefix?: string }) {
  const base = value?.kind === 'free_above' ? value.otherwise : value;
  const [kind, setKind] = useState<string>(value === null ? (allowInherit ? 'inherit' : 'pass_through') : (base?.kind ?? 'pass_through'));
  const [freeAbove, setFreeAbove] = useState(value?.kind === 'free_above');
  return (
    <fieldset className="space-y-3">
      <legend className="mb-1 text-sm font-medium text-ink">What the guest pays for delivery</legend>
      <label className="block">
        <span className="sr-only">Delivery fee rule</span>
        <select name={`${prefix}Kind`} value={kind} onChange={(e) => setKind(e.currentTarget.value)} className={control}>
          {allowInherit ? <option value="inherit">The same as the venue’s rule</option> : null}
          {KINDS.map(([k, label]) => (
            <option key={k} value={k}>
              {label}
            </option>
          ))}
        </select>
      </label>
      {kind === 'flat' ? (
        <label className="block">
          <span className="mb-1 block text-sm font-medium text-ink">Flat fee ($)</span>
          <input name={`${prefix}Flat`} inputMode="decimal" required defaultValue={dollars(base?.kind === 'flat' ? base.cents : undefined)} className={`${control} max-w-40`} />
        </label>
      ) : null}
      {kind === 'subsidised' ? (
        <label className="block">
          <span className="mb-1 block text-sm font-medium text-ink">We pay up to ($)</span>
          <input name={`${prefix}Subsidy`} inputMode="decimal" required defaultValue={dollars(base?.kind === 'subsidised' ? base.venue_pays_up_to_cents : undefined)} className={`${control} max-w-40`} />
          <span className="mt-1 block text-xs text-ink-3">The guest pays whatever the courier charges above this.</span>
        </label>
      ) : null}
      {kind !== 'inherit' ? (
        <>
          <label className="flex items-start gap-3 text-sm">
            <input type="checkbox" name={`${prefix}FreeAbove`} checked={freeAbove} onChange={(e) => setFreeAbove(e.currentTarget.checked)} className="mt-0.5 size-4 accent-ink" />
            <span className="text-ink">Free delivery on larger orders</span>
          </label>
          {freeAbove ? (
            <label className="block">
              <span className="mb-1 block text-sm font-medium text-ink">Free at or above ($)</span>
              <input name={`${prefix}Threshold`} inputMode="decimal" required defaultValue={dollars(value?.kind === 'free_above' ? value.threshold_cents : undefined)} className={`${control} max-w-40`} />
              <span className="mt-1 block text-xs text-ink-3">Counted after discounts. Below it, the rule above applies.</span>
            </label>
          ) : null}
        </>
      ) : null}
    </fieldset>
  );
}
