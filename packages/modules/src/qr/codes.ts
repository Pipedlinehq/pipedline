import { z } from 'zod';
import { type Ctx, assertModule, audit, conflict, invalid, newSlug, notFound, parsePatch, requireStaff } from '@ros/core';
import { qrModule } from './module';

/**
 * The codes. A printed code points at /q/<code> on the venue's own host and the destination is
 * resolved on our side, so a venue never reprints because a menu, a domain or a table number
 * changed. Codes are random, never sequential, and reveal a table label and nothing else
 * (docs/THREAT_MODEL.md section 6).
 */

const LABEL = z.string().trim().min(1).max(40);
// A path on the venue's own site. Never a full URL: a code must not redirect off the site.
const PATH = z
  .string()
  .max(300)
  .regex(/^\/(?!\/)[A-Za-z0-9\-._~/?=&%]*$/, 'Use a path on this site, such as /menu.');

export const qrCodeInput = z.object({
  venueId: z.string().uuid(),
  kind: z.enum(['menu', 'table', 'counter', 'campaign']),
  /** The venue's own name for the table or spot: "12", "T4", "Bar". Needed for a table or counter code. */
  label: LABEL.nullish(),
  area: z.string().trim().max(60).nullish(),
  targetPath: PATH.default('/menu'),
  /** A code on a flyer or in a creator's post carries who brought the guest in. */
  campaignId: z.string().trim().max(100).nullish(),
  creatorId: z.string().trim().max(100).nullish(),
  offerId: z.string().uuid().nullish(),
  printBatch: z.string().trim().max(60).nullish(),
});

export interface QrCodeView {
  id: string;
  venueId: string;
  code: string;
  /** What the QR image encodes, relative to the venue's host. */
  path: string;
  kind: 'menu' | 'table' | 'counter' | 'campaign';
  label: string | null;
  area: string | null;
  targetPath: string;
  campaignId: string | null;
  creatorId: string | null;
  offerId: string | null;
  isActive: boolean;
  printBatch: string | null;
  scanCount: number;
  lastScannedAt: Date | null;
  createdAt: Date;
}

const COLS = ['id', 'venue_id', 'code', 'kind', 'label', 'area', 'target_path', 'campaign_id', 'creator_id', 'offer_id', 'is_active', 'print_batch', 'scan_count', 'last_scanned_at', 'created_at'] as const;
type Row = {
  id: string;
  venue_id: string;
  code: string;
  kind: QrCodeView['kind'];
  label: string | null;
  area: string | null;
  target_path: string;
  campaign_id: string | null;
  creator_id: string | null;
  offer_id: string | null;
  is_active: boolean;
  print_batch: string | null;
  scan_count: number;
  last_scanned_at: Date | null;
  created_at: Date;
};

const view = (r: Row): QrCodeView => ({
  id: r.id,
  venueId: r.venue_id,
  code: r.code,
  path: `/q/${r.code}`,
  kind: r.kind,
  label: r.label,
  area: r.area,
  targetPath: r.target_path,
  campaignId: r.campaign_id,
  creatorId: r.creator_id,
  offerId: r.offer_id,
  isActive: r.is_active,
  printBatch: r.print_batch,
  scanCount: r.scan_count,
  lastScannedAt: r.last_scanned_at,
  createdAt: r.created_at,
});

async function insertCode(ctx: Ctx, input: z.infer<typeof qrCodeInput>): Promise<Row> {
  // The code is unique across the whole platform, and another org's codes cannot be seen from
  // here: insert and, on the rare clash, draw again.
  for (let attempt = 0; attempt < 5; attempt++) {
    const row = await ctx.db
      .insertInto('qr_codes')
      .values({
        org_id: ctx.orgId,
        venue_id: input.venueId,
        code: newSlug(10),
        kind: input.kind,
        label: input.label ?? null,
        area: input.area ?? null,
        target_path: input.targetPath,
        campaign_id: input.campaignId ?? null,
        creator_id: input.creatorId ?? null,
        offer_id: input.offerId ?? null,
        print_batch: input.printBatch ?? null,
        created_at: ctx.now(),
      })
      .onConflict((oc) => oc.column('code').doNothing())
      .returning(COLS)
      .executeTakeFirst();
    if (row) return row;
  }
  throw conflict('Could not make a new code. Try again.');
}

export async function createQrCode(ctx: Ctx, raw: z.input<typeof qrCodeInput>): Promise<QrCodeView> {
  const input = qrCodeInput.parse(raw);
  requireStaff(ctx, { venueId: input.venueId, minRole: 'manager' });
  await assertModule(ctx, input.venueId, qrModule);
  if ((input.kind === 'table' || input.kind === 'counter') && !input.label) throw invalid('Give the table or counter a label, such as "12" or "Bar".');
  const row = await insertCode(ctx, input);
  await audit(ctx, { action: 'qr.code_created', entityType: 'qr_code', entityId: row.id, venueId: row.venue_id, after: { kind: row.kind, label: row.label } });
  return view(row);
}

export const tableCodesInput = z.object({
  venueId: z.string().uuid(),
  labels: z.array(LABEL).min(1).max(300),
  area: z.string().trim().max(60).nullish(),
  printBatch: z.string().trim().max(60).nullish(),
});

/** One code per table, for a print run. A table that already has an active code keeps it. */
export async function createTableCodes(ctx: Ctx, raw: z.input<typeof tableCodesInput>): Promise<QrCodeView[]> {
  const input = tableCodesInput.parse(raw);
  requireStaff(ctx, { venueId: input.venueId, minRole: 'manager' });
  await assertModule(ctx, input.venueId, qrModule);
  const existing = await ctx.db.selectFrom('qr_codes').select(COLS).where('venue_id', '=', input.venueId).where('kind', '=', 'table').where('is_active', '=', true).execute();
  const out: QrCodeView[] = [];
  let created = 0;
  for (const label of [...new Set(input.labels)]) {
    const has = existing.find((e) => e.label === label);
    if (has) {
      out.push(view(has));
      continue;
    }
    out.push(view(await insertCode(ctx, { venueId: input.venueId, kind: 'table', label, area: input.area ?? null, targetPath: '/menu', printBatch: input.printBatch ?? null })));
    created++;
  }
  await audit(ctx, { action: 'qr.table_codes_created', entityType: 'venue', entityId: input.venueId, venueId: input.venueId, after: { created, printBatch: input.printBatch ?? null } });
  return out;
}

export const updateQrCodeInput = qrCodeInput.omit({ venueId: true, kind: true }).partial().extend({ isActive: z.boolean().optional() });

async function load(ctx: Ctx, id: string): Promise<Row> {
  const row = await ctx.db.selectFrom('qr_codes').select(COLS).where('id', '=', z.string().uuid().parse(id)).executeTakeFirst();
  if (!row) throw notFound('QR code not found');
  return row;
}

/** Change where a code leads or what it is called, or switch it off. The printed code stays the same. */
export async function updateQrCode(ctx: Ctx, id: string, raw: z.input<typeof updateQrCodeInput>): Promise<QrCodeView> {
  const input = parsePatch(updateQrCodeInput, raw);
  const before = await load(ctx, id);
  requireStaff(ctx, { venueId: before.venue_id, minRole: 'manager' });
  await assertModule(ctx, before.venue_id, qrModule);
  const row = await ctx.db
    .updateTable('qr_codes')
    .set({
      ...(input.label !== undefined ? { label: input.label } : {}),
      ...(input.area !== undefined ? { area: input.area } : {}),
      ...(input.targetPath !== undefined ? { target_path: input.targetPath } : {}),
      ...(input.campaignId !== undefined ? { campaign_id: input.campaignId } : {}),
      ...(input.creatorId !== undefined ? { creator_id: input.creatorId } : {}),
      ...(input.offerId !== undefined ? { offer_id: input.offerId } : {}),
      ...(input.printBatch !== undefined ? { print_batch: input.printBatch } : {}),
      ...(input.isActive !== undefined ? { is_active: input.isActive } : {}),
    })
    .where('id', '=', before.id)
    .returning(COLS)
    .executeTakeFirstOrThrow();
  await audit(ctx, { action: 'qr.code_updated', entityType: 'qr_code', entityId: row.id, venueId: row.venue_id, before: view(before), after: view(row) });
  return view(row);
}

/** Switch a code off. It stops resolving at once; orders already placed with it keep their table. */
export const deactivateQrCode = (ctx: Ctx, id: string): Promise<QrCodeView> => updateQrCode(ctx, id, { isActive: false });

export async function listQrCodes(ctx: Ctx, args: { venueId: string; kind?: QrCodeView['kind']; includeInactive?: boolean }): Promise<QrCodeView[]> {
  const venueId = z.string().uuid().parse(args.venueId);
  requireStaff(ctx, { venueId, minRole: 'read_only' });
  await assertModule(ctx, venueId, qrModule);
  let q = ctx.db.selectFrom('qr_codes').select(COLS).where('venue_id', '=', venueId).orderBy('kind').orderBy('label').orderBy('created_at');
  if (args.kind) q = q.where('kind', '=', args.kind);
  if (!args.includeInactive) q = q.where('is_active', '=', true);
  return (await q.execute()).map(view);
}
