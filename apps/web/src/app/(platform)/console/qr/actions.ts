'use server';

import { qr } from '@ros/modules';
import { act, nullableText, optText, text } from '@/lib/console-actions';
import type { FormState } from '@/ui/client';

const PATHS = ['/console/qr', '/console/qr/print'];
const ok = (r: FormState & { data?: unknown }): FormState => (r && r.ok ? { ok: true, message: r.message } : r);

/**
 * "1-14", "T1-T6, B1-B4, Bar": ranges expand, keeping any letter prefix. Everything else is
 * taken as a label as typed. The QR service validates each label again.
 */
function expandLabels(raw: string): string[] {
  const out: string[] = [];
  for (const part of raw.split(/[,\n]/).map((p) => p.trim()).filter(Boolean)) {
    const m = part.match(/^([A-Za-z]*)(\d+)\s*[-–]\s*\1?(\d+)$/);
    if (m) {
      const [, prefix, a, b] = m;
      const lo = Number(a);
      const hi = Number(b);
      if (hi >= lo && hi - lo < 300) {
        for (let n = lo; n <= hi; n++) out.push(`${prefix}${n}`);
        continue;
      }
    }
    out.push(part);
  }
  return out;
}

export async function createTableCodes(_: FormState, fd: FormData): Promise<FormState> {
  const labels = expandLabels(text(fd, 'labels'));
  if (!labels.length) return { ok: false, error: 'List the tables, such as 1-14 or T1-T6, Bar.' };
  return ok(
    await act((ctx, c) => qr.createTableCodes(ctx, { venueId: c.venue.id, labels, area: nullableText(fd, 'area'), printBatch: nullableText(fd, 'printBatch') }), {
      success: (codes) => `${codes.length} table ${codes.length === 1 ? 'code' : 'codes'} ready. Tables that already had a code keep it.`,
      revalidate: PATHS,
    }),
  );
}

export async function createCode(_: FormState, fd: FormData): Promise<FormState> {
  const kind = text(fd, 'kind') as 'menu' | 'table' | 'counter' | 'campaign';
  return ok(
    await act(
      (ctx, c) =>
        qr.createQrCode(ctx, {
          venueId: c.venue.id,
          kind,
          label: nullableText(fd, 'label'),
          area: nullableText(fd, 'area'),
          targetPath: optText(fd, 'targetPath') ?? '/menu',
          campaignId: nullableText(fd, 'campaignId'),
          creatorId: nullableText(fd, 'creatorId'),
          printBatch: nullableText(fd, 'printBatch'),
        }),
      { success: (code) => `Code ${code.code} created.`, revalidate: PATHS },
    ),
  );
}

export async function updateCode(_: FormState, fd: FormData): Promise<FormState> {
  return ok(
    await act(
      (ctx) =>
        qr.updateQrCode(ctx, text(fd, 'codeId'), {
          label: nullableText(fd, 'label'),
          area: nullableText(fd, 'area'),
          targetPath: optText(fd, 'targetPath') ?? '/menu',
          campaignId: nullableText(fd, 'campaignId'),
          creatorId: nullableText(fd, 'creatorId'),
          printBatch: nullableText(fd, 'printBatch'),
        }),
      { success: 'Saved. The printed code stays the same.', revalidate: PATHS },
    ),
  );
}

export async function deactivateCode(_: FormState, fd: FormData): Promise<FormState> {
  return ok(await act((ctx) => qr.deactivateQrCode(ctx, text(fd, 'codeId')), { success: 'Switched off. Scanning it now shows that it is no longer in use.', revalidate: PATHS }));
}

export async function reactivateCode(_: FormState, fd: FormData): Promise<FormState> {
  return ok(await act((ctx) => qr.updateQrCode(ctx, text(fd, 'codeId'), { isActive: true }), { success: 'Switched back on.', revalidate: PATHS }));
}
