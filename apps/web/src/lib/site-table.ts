import 'server-only';
import { z } from 'zod';
import type { qr } from '@ros/modules';
import { readCookie } from './cookies';

/**
 * The table a guest scanned, kept in a host-only cookie so the menu and the order page know
 * which table they are at. It is display context only: every order sends the code, and the
 * server resolves the table, the stage and the alcohol rule again (ordering's TableOrdering).
 * Editing this cookie changes nothing but what the editor sees.
 */
export const TABLE_COOKIE = 'ros_table';
export const TABLE_COOKIE_HOURS = 6;

const tableContext = z.object({
  code: z.string().regex(/^[a-z0-9]{6,40}$/),
  venueId: z.string().uuid(),
  kind: z.enum(['menu', 'table', 'counter', 'campaign']),
  label: z.string().max(60).nullable(),
  area: z.string().max(60).nullable(),
  stage: z.enum(['view', 'order']),
  canOrder: z.boolean(),
  excludeAlcohol: z.boolean(),
  showPrices: z.boolean(),
  tipping: z.object({ enabled: z.boolean(), presets: z.array(z.number().int().min(0).max(100)).max(6) }),
  prompts: z.object({ receiptEmail: z.boolean(), loyalty: z.boolean() }),
});
export type TableContext = z.infer<typeof tableContext>;

export function tableFromResolution(r: qr.QrResolution): TableContext {
  return {
    code: r.code,
    venueId: r.venueId,
    kind: r.kind,
    label: r.table?.label ?? null,
    area: r.table?.area ?? null,
    stage: r.stage,
    canOrder: r.canOrder,
    excludeAlcohol: r.excludeAlcohol,
    showPrices: r.showPrices,
    tipping: r.tipping,
    prompts: r.prompts,
  };
}

export function encodeTable(t: TableContext): string {
  return Buffer.from(JSON.stringify(t)).toString('base64url');
}

/** The scanned table, when it is at this venue. */
export async function readTable(venue: unknown): Promise<TableContext | null> {
  const venueId = z.string().uuid().safeParse(venue).data;
  if (!venueId) return null;
  const raw = await readCookie(TABLE_COOKIE);
  if (!raw) return null;
  try {
    const parsed = tableContext.safeParse(JSON.parse(Buffer.from(raw, 'base64url').toString('utf8')));
    return parsed.success && parsed.data.venueId === venueId ? parsed.data : null;
  } catch {
    return null;
  }
}
