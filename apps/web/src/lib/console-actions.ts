import 'server-only';
import { revalidatePath } from 'next/cache';
import { randomUUID } from 'node:crypto';
import type { Ctx } from '@ros/core';
import type { FormState } from '@/ui/client';
import { runAction } from './actions';
import { type ConsoleContext, getConsole, inConsole } from './console';
import { bustSite } from './site-revalidate';

/**
 * Server-action plumbing for the console. Every action:
 *   - runs the service function as the signed-in staff member (the service makes the role check),
 *   - takes the venue from getConsole(), never from the form,
 *   - turns the outcome into a FormState the page can show in place.
 */

/** A FormState that can also carry data back to the page (a key shown once, a pairing code). */
export type DataFormState<T> = ({ ok: true; message?: string; data?: T } | { ok: false; error: string }) | null;

export interface ActOptions<T> {
  /** The sentence shown when it worked. */
  success?: string | ((data: T) => string);
  /** Paths to refresh after a change. Defaults to the whole console. */
  revalidate?: string | string[];
  /**
   * The change alters what the org's published pages show without being a publish (a section
   * kind hidden, the website switched off): expire what the venue site has cached for this org.
   * A publish does not need this; the website module revalidates its own tags.
   */
  bustsSite?: boolean;
}

/** Run a service call in the console's context and answer with a FormState. */
export async function act<T>(fn: (ctx: Ctx, c: ConsoleContext) => Promise<T>, opts: ActOptions<T> = {}): Promise<FormState & { data?: T }> {
  const r = await runAction(() => inConsole(fn));
  if (!r.ok) return { ok: false, error: r.error };
  refresh(opts.revalidate);
  if (opts.bustsSite) bustSite((await getConsole()).session.orgId);
  const message = typeof opts.success === 'function' ? opts.success(r.data) : opts.success;
  return { ok: true, message, data: r.data };
}

/** As act(), for app-level service functions that open their own transactions (refunds). */
export async function actApp<T>(fn: () => Promise<T>, opts: ActOptions<T> = {}): Promise<FormState & { data?: T }> {
  const r = await runAction(fn);
  if (!r.ok) return { ok: false, error: r.error };
  refresh(opts.revalidate);
  const message = typeof opts.success === 'function' ? opts.success(r.data) : opts.success;
  return { ok: true, message, data: r.data };
}

function refresh(paths: string | string[] | undefined): void {
  const list = paths === undefined ? ['/console'] : Array.isArray(paths) ? paths : [paths];
  for (const p of list) revalidatePath(p, p === '/console' ? 'layout' : 'page');
}

// ── Reading form fields. Values are untrusted: the service validates them again. ──

export function text(fd: FormData, name: string): string {
  const v = fd.get(name);
  return typeof v === 'string' ? v.trim() : '';
}

export function optText(fd: FormData, name: string): string | undefined {
  const v = text(fd, name);
  return v === '' ? undefined : v;
}

export function nullableText(fd: FormData, name: string): string | null {
  const v = text(fd, name);
  return v === '' ? null : v;
}

export function int(fd: FormData, name: string): number | undefined {
  const v = text(fd, name);
  if (v === '') return undefined;
  const n = Number(v);
  return Number.isFinite(n) ? Math.trunc(n) : Number.NaN;
}

export function bool(fd: FormData, name: string): boolean {
  const v = fd.get(name);
  return v === 'on' || v === 'true' || v === '1';
}

export function all(fd: FormData, name: string): string[] {
  return fd.getAll(name).filter((v): v is string => typeof v === 'string' && v !== '');
}

/** A dollar amount typed by a person ("12.50", "$12", "12") as integer cents. */
export function cents(fd: FormData, name: string): number | undefined {
  const v = text(fd, name).replace(/[$,\s]/g, '');
  if (v === '') return undefined;
  if (!/^-?\d+(\.\d{1,2})?$/.test(v)) return Number.NaN;
  return Math.round(Number(v) * 100);
}

/** A fresh idempotency key for a money-moving action, made on the server when the form is rendered. */
export function idempotencyKey(): string {
  return randomUUID();
}
