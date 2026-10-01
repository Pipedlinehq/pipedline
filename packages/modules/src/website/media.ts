import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import { type App, type Ctx, type Principal, audit, invalid, notFound, requireStaff } from '@ros/core';
import { assertWebsite } from './module';
import { plainText } from './safe';

/** The largest image we accept. Big enough for a full-bleed hero photograph, small enough to refuse a video. */
export const MAX_IMAGE_BYTES = 8 * 1024 * 1024;
/** How many images one org may hold. */
export const MAX_MEDIA_PER_ORG = 2000;

export type ImageType = 'image/jpeg' | 'image/png' | 'image/gif' | 'image/webp' | 'image/avif';
const EXTENSION: Record<ImageType, string> = { 'image/jpeg': 'jpg', 'image/png': 'png', 'image/gif': 'gif', 'image/webp': 'webp', 'image/avif': 'avif' };

export interface SniffedImage {
  contentType: ImageType;
  width: number | null;
  height: number | null;
}

function jpegSize(b: Buffer): { width: number; height: number } | null {
  let i = 2;
  while (i + 9 < b.length) {
    if (b[i] !== 0xff) return null;
    const marker = b[i + 1]!;
    // Start-of-frame markers carry the dimensions (all SOFn except the DHT, JPG and DAC markers).
    if (marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc) {
      return { height: b.readUInt16BE(i + 5), width: b.readUInt16BE(i + 7) };
    }
    i += 2 + b.readUInt16BE(i + 2);
  }
  return null;
}

function webpSize(b: Buffer): { width: number; height: number } | null {
  if (b.length < 30) return null;
  const chunk = b.toString('latin1', 12, 16);
  if (chunk === 'VP8X') return { width: 1 + b.readUIntLE(24, 3), height: 1 + b.readUIntLE(27, 3) };
  if (chunk === 'VP8 ') return { width: b.readUInt16LE(26) & 0x3fff, height: b.readUInt16LE(28) & 0x3fff };
  if (chunk === 'VP8L') {
    const bits = b.readUInt32LE(21);
    return { width: (bits & 0x3fff) + 1, height: ((bits >> 14) & 0x3fff) + 1 };
  }
  return null;
}

/**
 * What the bytes actually are, from their signature. The declared content type and the file
 * name are claims by the uploader; this is the evidence. Returns null for anything that is not
 * one of the raster image formats we serve. SVG is deliberately not among them: it is a
 * document that can carry script.
 */
export function sniffImage(body: Buffer): SniffedImage | null {
  if (body.length >= 3 && body[0] === 0xff && body[1] === 0xd8 && body[2] === 0xff) {
    const size = jpegSize(body);
    return { contentType: 'image/jpeg', width: size?.width ?? null, height: size?.height ?? null };
  }
  if (body.length >= 24 && body.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) {
    return { contentType: 'image/png', width: body.readUInt32BE(16), height: body.readUInt32BE(20) };
  }
  if (body.length >= 10 && (body.toString('latin1', 0, 6) === 'GIF87a' || body.toString('latin1', 0, 6) === 'GIF89a')) {
    return { contentType: 'image/gif', width: body.readUInt16LE(6), height: body.readUInt16LE(8) };
  }
  if (body.length >= 16 && body.toString('latin1', 0, 4) === 'RIFF' && body.toString('latin1', 8, 12) === 'WEBP') {
    const size = webpSize(body);
    return { contentType: 'image/webp', width: size?.width ?? null, height: size?.height ?? null };
  }
  if (body.length >= 12 && body.toString('latin1', 4, 8) === 'ftyp' && ['avif', 'avis'].includes(body.toString('latin1', 8, 12))) {
    return { contentType: 'image/avif', width: null, height: null };
  }
  return null;
}

export interface MediaView {
  id: string;
  url: string;
  alt: string | null;
  width: number | null;
  height: number | null;
  bytes: number | null;
  contentType: string | null;
  createdAt: Date;
}

const COLS = ['id', 'url', 'alt', 'width', 'height', 'bytes', 'content_type', 'created_at'] as const;
const view = (r: { id: string; url: string; alt: string | null; width: number | null; height: number | null; bytes: number | null; content_type: string | null; created_at: Date }): MediaView => ({
  id: r.id,
  url: r.url,
  alt: r.alt,
  width: r.width,
  height: r.height,
  bytes: r.bytes,
  contentType: r.content_type,
  createdAt: r.created_at,
});

export const uploadMediaInput = z.object({
  /** What the browser said the file is. Checked against the bytes, never trusted on its own. */
  contentType: z.string().max(100),
  alt: plainText(200).nullish(),
});

/**
 * Add an image to the org's media library. Images only, up to MAX_IMAGE_BYTES, and the bytes
 * must be what they claim to be. The storage call happens between two transactions, never
 * inside one; the stored object's name is ours, not the uploader's.
 */
export async function uploadMedia(
  app: App,
  orgId: string,
  principal: Principal,
  raw: { contentType: string; body: Buffer; alt?: string | null },
): Promise<MediaView> {
  const parsed = uploadMediaInput.safeParse({ contentType: raw.contentType, alt: raw.alt });
  if (!parsed.success) throw invalid(parsed.error.issues[0]?.message ?? 'That upload is not valid.', { issues: parsed.error.issues });
  const body = raw.body;
  if (!Buffer.isBuffer(body) || body.length === 0) throw invalid('That file is empty.');
  if (body.length > MAX_IMAGE_BYTES) throw invalid(`Images can be up to ${Math.round(MAX_IMAGE_BYTES / (1024 * 1024))} MB.`);
  const sniffed = sniffImage(body);
  if (!sniffed) throw invalid('That file is not an image we can use. Upload a JPEG, PNG, WebP, AVIF or GIF.');
  const declared = parsed.data.contentType.split(';')[0]!.trim().toLowerCase();
  if (!declared.startsWith('image/')) throw invalid('Only images can be uploaded here.');

  await app.tenant(orgId, principal, async (ctx) => {
    requireStaff(ctx, { minRole: 'manager' });
    await assertWebsite(ctx, null);
    const held = await ctx.db.selectFrom('media').select((eb) => eb.fn.countAll<number>().as('n')).executeTakeFirstOrThrow();
    if (Number(held.n) >= MAX_MEDIA_PER_ORG) throw invalid('The media library is full. Remove some images first.');
  });

  // The content type stored and served is the one the bytes prove, whatever was declared.
  const stored = await app.adapters.storage.put({ orgId, key: `media/${randomUUID()}.${EXTENSION[sniffed.contentType]}`, body, contentType: sniffed.contentType });

  return app.tenant(orgId, principal, async (ctx) => {
    requireStaff(ctx, { minRole: 'manager' });
    const row = await ctx.db
      .insertInto('media')
      .values({
        org_id: ctx.orgId,
        kind: 'image',
        storage_key: stored.storageKey,
        url: stored.url,
        alt: parsed.data.alt ?? null,
        width: sniffed.width,
        height: sniffed.height,
        bytes: body.length,
        content_type: sniffed.contentType,
      })
      .returning(COLS)
      .executeTakeFirstOrThrow();
    await audit(ctx, { action: 'media.uploaded', entityType: 'media', entityId: row.id, after: { bytes: body.length, contentType: sniffed.contentType } });
    return view(row);
  });
}

/** The org's images, newest first. */
export async function listMedia(ctx: Ctx, input: { limit?: number; before?: Date } = {}): Promise<MediaView[]> {
  requireStaff(ctx);
  await assertWebsite(ctx, null);
  let q = ctx.db
    .selectFrom('media')
    .select(COLS)
    .orderBy('created_at', 'desc')
    .orderBy('id')
    .limit(Math.min(Math.max(input.limit ?? 60, 1), 200));
  if (input.before) q = q.where('created_at', '<', input.before);
  return (await q.execute()).map(view);
}

export async function setMediaAlt(ctx: Ctx, input: { mediaId: string; alt: string | null }): Promise<MediaView> {
  requireStaff(ctx, { minRole: 'manager' });
  await assertWebsite(ctx, null);
  if (!z.string().uuid().safeParse(input.mediaId).success) throw notFound('Image not found');
  const alt = input.alt === null ? null : plainText(200).parse(input.alt);
  const row = await ctx.db.updateTable('media').set({ alt }).where('id', '=', input.mediaId).returning(COLS).executeTakeFirst();
  if (!row) throw notFound('Image not found');
  await audit(ctx, { action: 'media.alt_set', entityType: 'media', entityId: row.id, after: { alt } });
  return view(row);
}

/** Remove an image from the library and from storage. Pages that still point at it show nothing in its place. */
export async function removeMedia(app: App, orgId: string, principal: Principal, input: { mediaId: string }): Promise<void> {
  if (!z.string().uuid().safeParse(input.mediaId).success) throw notFound('Image not found');
  const storageKey = await app.tenant(orgId, principal, async (ctx) => {
    requireStaff(ctx, { minRole: 'manager' });
    await assertWebsite(ctx, null);
    const row = await ctx.db.deleteFrom('media').where('id', '=', input.mediaId).returning(['id', 'storage_key']).executeTakeFirst();
    if (!row) throw notFound('Image not found');
    await audit(ctx, { action: 'media.removed', entityType: 'media', entityId: row.id });
    return row.storage_key;
  });
  try {
    await app.adapters.storage.remove({ orgId, storageKey });
  } catch (e) {
    // The library row is gone, so the image is no longer offered; the orphaned object is swept later.
    app.log.warn('media object could not be removed', { orgId, error: (e as Error).message });
  }
}
