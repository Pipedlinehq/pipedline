import { createCipheriv, createDecipheriv, createHash, createHmac, randomBytes, randomInt, timingSafeEqual } from 'node:crypto';

export function sha256(input: string | Buffer): Buffer {
  return createHash('sha256').update(input).digest();
}

export function sha256Hex(input: string | Buffer): string {
  return createHash('sha256').update(input).digest('hex');
}

export function hmacHex(secret: Buffer | string, value: string): string {
  return createHmac('sha256', secret).update(value).digest('hex');
}

export function safeEqual(a: Buffer | string, b: Buffer | string): boolean {
  const ab = Buffer.isBuffer(a) ? a : Buffer.from(a);
  const bb = Buffer.isBuffer(b) ? b : Buffer.from(b);
  return ab.length === bb.length && timingSafeEqual(ab, bb);
}

/** An opaque bearer token: `prefix_<43 url-safe chars>`. Only its hash is ever stored. */
export function newToken(prefix: string): { token: string; hash: Buffer; display: string } {
  const body = randomBytes(32).toString('base64url');
  const token = `${prefix}_${body}`;
  return { token, hash: sha256(token), display: `${prefix}_${body.slice(0, 6)}…` };
}

export function hashToken(token: string): Buffer {
  return sha256(token);
}

/** A numeric one-time code, e.g. for sign-in. */
export function newNumericCode(digits = 6): string {
  let s = '';
  for (let i = 0; i < digits; i++) s += randomInt(0, 10).toString();
  return s;
}

const CODE_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'; // no I, O, 0, 1: read aloud at a counter

/** A short human-typable code. Random, never sequential. */
export function newCode(length = 6, prefix?: string): string {
  let s = '';
  for (let i = 0; i < length; i++) s += CODE_ALPHABET[randomInt(0, CODE_ALPHABET.length)];
  return prefix ? `${prefix}-${s}` : s;
}

export function newSlug(length = 10): string {
  const alphabet = 'abcdefghjkmnpqrstuvwxyz23456789';
  let s = '';
  for (let i = 0; i < length; i++) s += alphabet[randomInt(0, alphabet.length)];
  return s;
}

export interface Sealed {
  ciphertext: Buffer;
  nonce: Buffer;
}

/** AES-256-GCM. The auth tag is appended to the ciphertext. */
export function seal(masterKey: Buffer, plaintext: string, aad: string): Sealed {
  const nonce = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', masterKey, nonce);
  cipher.setAAD(Buffer.from(aad));
  const body = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
  return { ciphertext: Buffer.concat([body, cipher.getAuthTag()]), nonce };
}

export function open(masterKey: Buffer, sealed: Sealed, aad: string): string {
  const tag = sealed.ciphertext.subarray(sealed.ciphertext.length - 16);
  const body = sealed.ciphertext.subarray(0, sealed.ciphertext.length - 16);
  const decipher = createDecipheriv('aes-256-gcm', masterKey, sealed.nonce);
  decipher.setAAD(Buffer.from(aad));
  decipher.setAuthTag(tag);
  return Buffer.concat([decipher.update(body), decipher.final()]).toString('utf8');
}

/** Stable digest of a JSON-able value, key order independent. */
export function digestOf(value: unknown): string {
  return sha256Hex(stableStringify(value));
}

export function stableStringify(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value) ?? 'null';
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(',')}]`;
  const obj = value as Record<string, unknown>;
  return `{${Object.keys(obj)
    .filter((k) => obj[k] !== undefined)
    .sort()
    .map((k) => `${JSON.stringify(k)}:${stableStringify(obj[k])}`)
    .join(',')}}`;
}
