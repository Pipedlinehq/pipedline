'use client';

import type { ordering } from '@ros/modules';

export type PricedCart = ordering.PricedCart;
export type SlotBoard = { asap: { available: boolean; promisedAt: string | null; estimateMinutes: number | null; reason: string | null }; slots: Array<{ start: string; end: string; remainingOrders: number }>; dates: string[]; date: string; timezone: string };

export interface CartLine {
  /** Local key for React and for removing a line; not sent. */
  key: string;
  menuItemId: string;
  name: string;
  qty: number;
  modifierIds: string[];
  /** The chosen options' names, for showing the line before the server has priced it. */
  modifierNames: string[];
  note: string | null;
}

export type ApiError = { message: string; code: string; issues?: Array<{ message: string; lineIndex?: number }> };
export type ApiResult<T> = { ok: true; data: T } | { ok: false; error: ApiError };

/** Call one of the site's own route handlers. Errors come back as the plain words the server wrote. */
export async function api<T>(path: string, init?: { method?: string; body?: unknown }): Promise<ApiResult<T>> {
  try {
    const res = await fetch(path, {
      method: init?.method ?? (init?.body === undefined ? 'GET' : 'POST'),
      headers: init?.body === undefined ? undefined : { 'content-type': 'application/json' },
      body: init?.body === undefined ? undefined : JSON.stringify(init.body),
      cache: 'no-store',
    });
    const json = (await res.json().catch(() => null)) as ({ error?: ApiError } & T) | null;
    if (!res.ok || !json || (json as { error?: ApiError }).error) {
      const err = json?.error;
      return { ok: false, error: { code: err?.code ?? 'internal', message: err?.message ?? 'Something went wrong. Try again.', issues: Array.isArray(err?.issues) ? (err!.issues as ApiError['issues']) : undefined } };
    }
    return { ok: true, data: json as T };
  } catch {
    return { ok: false, error: { code: 'offline', message: 'You seem to be offline. Ordering needs a connection; check it and try again.' } };
  }
}

export const toCartInput = (lines: CartLine[]) => lines.map((l) => ({ menuItemId: l.menuItemId, qty: l.qty, modifierIds: l.modifierIds, note: l.note }));

export function newKey(): string {
  return typeof crypto !== 'undefined' && 'randomUUID' in crypto ? crypto.randomUUID() : `${Date.now()}-${Math.random().toString(36).slice(2)}`;
}

/** The cart lives in this browser only (per venue and channel), until the order is placed. */
export function loadCart(storageKey: string): CartLine[] {
  try {
    const raw = window.localStorage.getItem(storageKey);
    const parsed = raw ? (JSON.parse(raw) as CartLine[]) : [];
    return Array.isArray(parsed) ? parsed.filter((l) => l && typeof l.menuItemId === 'string' && Number.isInteger(l.qty)) : [];
  } catch {
    return [];
  }
}

export function saveCart(storageKey: string, lines: CartLine[]): void {
  try {
    if (lines.length) window.localStorage.setItem(storageKey, JSON.stringify(lines));
    else window.localStorage.removeItem(storageKey);
  } catch {
    // Private browsing: the cart simply is not remembered across reloads.
  }
}
