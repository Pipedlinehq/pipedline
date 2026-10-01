/** Money is integer minor units (cents) with an explicit currency. Never a float. */

export function formatMoney(cents: number, currency = 'AUD'): string {
  return new Intl.NumberFormat('en-AU', { style: 'currency', currency }).format(cents / 100);
}

/** Tax contained in a tax-inclusive amount. rateBp: 1000 = 10%. */
export function taxIncluded(totalCents: number, rateBp: number): number {
  return Math.round((totalCents * rateBp) / (10_000 + rateBp));
}

/** Tax to add to a tax-exclusive amount. */
export function taxOn(netCents: number, rateBp: number): number {
  return Math.round((netCents * rateBp) / 10_000);
}

export function percentOf(cents: number, percent: number): number {
  return Math.round((cents * percent) / 100);
}

/** Split an amount N ways so the parts total exactly; the remainder goes to the first parts. */
export function splitEvenly(cents: number, ways: number): number[] {
  const base = Math.floor(cents / ways);
  const rem = cents - base * ways;
  return Array.from({ length: ways }, (_, i) => base + (i < rem ? 1 : 0));
}
