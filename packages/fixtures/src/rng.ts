/** Seeded randomness, so every fixture run produces the same data. */
export interface Rng {
  next(): number;
  int(min: number, max: number): number;
  pick<T>(items: readonly T[]): T;
  weighted<T>(items: ReadonlyArray<readonly [T, number]>): T;
  chance(p: number): boolean;
  uuid(): string;
}

export function createRng(seed: number): Rng {
  let a = seed >>> 0;
  const next = () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
  const hex = (n: number) => Array.from({ length: n }, () => Math.floor(next() * 16).toString(16)).join('');
  return {
    next,
    int: (min, max) => min + Math.floor(next() * (max - min + 1)),
    pick: (items) => items[Math.floor(next() * items.length)]!,
    weighted(items) {
      const total = items.reduce((s, [, w]) => s + w, 0);
      let r = next() * total;
      for (const [item, w] of items) {
        r -= w;
        if (r <= 0) return item;
      }
      return items[items.length - 1]![0];
    },
    chance: (p) => next() < p,
    uuid: () => `${hex(8)}-${hex(4)}-4${hex(3)}-${'89ab'[Math.floor(next() * 4)]}${hex(3)}-${hex(12)}`,
  };
}
