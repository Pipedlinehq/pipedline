import { lookup as dnsLookup } from 'node:dns/promises';
import http from 'node:http';
import https from 'node:https';
import { isIP } from 'node:net';
import { AppError } from '@ros/core';

/**
 * Fetching a venue's old menu page: a server-side request to an address a user typed
 * (docs/THREAT_MODEL.md section 6). The rules, each one tested:
 *
 *   - http or https only, the default ports only, no credentials in the address;
 *   - the name is resolved first and EVERY address it resolves to must be on the public internet
 *     (not this machine, a private network, link-local, the cloud metadata service, CGNAT,
 *     documentation or multicast ranges, in IPv4 or IPv6 form, including IPv4 hidden in IPv6);
 *   - the connection is made to the address that was checked (the transport is handed that
 *     address and connects to nothing else), so a name cannot answer one thing to the check and
 *     another to the call;
 *   - redirects are not followed by the transport: each Location is checked again from scratch,
 *     at most three times;
 *   - only text/html, application/xhtml+xml or text/plain; at most 2 MB; at most 10 seconds;
 *   - what comes back is reduced to plain text. Nothing in it is ever run or rendered.
 */

export const FETCH_LIMITS = { maxBytes: 2 * 1024 * 1024, timeoutMs: 10_000, maxRedirects: 3, maxTextChars: 60_000 } as const;
const TEXT_TYPES = ['text/html', 'application/xhtml+xml', 'text/plain'];

function v4Public(a: number, b: number, c: number): boolean {
  if (a === 0 || a === 10 || a === 127) return false; // this network, private, loopback
  if (a === 100 && b >= 64 && b <= 127) return false; // carrier-grade NAT
  if (a === 169 && b === 254) return false; // link-local, cloud metadata
  if (a === 172 && b >= 16 && b <= 31) return false; // private
  if (a === 192 && b === 168) return false; // private
  if (a === 192 && b === 0 && (c === 0 || c === 2)) return false; // protocol assignments, documentation
  if (a === 198 && (b === 18 || b === 19)) return false; // benchmarking
  if (a === 198 && b === 51 && c === 100) return false; // documentation
  if (a === 203 && b === 0 && c === 113) return false; // documentation
  if (a >= 224) return false; // multicast, reserved, broadcast
  return true;
}

function v6Groups(address: string): number[] | null {
  let text = address.split('%')[0]!;
  const dotted = /(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(text);
  if (dotted) {
    const [a, b, c, d] = dotted.slice(1).map(Number) as [number, number, number, number];
    if ([a, b, c, d].some((n) => n > 255)) return null;
    text = `${text.slice(0, dotted.index)}${((a << 8) | b).toString(16)}:${((c << 8) | d).toString(16)}`;
  }
  const halves = text.split('::');
  if (halves.length > 2) return null;
  const parse = (s: string) => (s ? s.split(':').map((g) => (/^[0-9a-fA-F]{1,4}$/.test(g) ? parseInt(g, 16) : NaN)) : []);
  const head = parse(halves[0]!);
  const tail = halves.length === 2 ? parse(halves[1]!) : [];
  if ([...head, ...tail].some(Number.isNaN)) return null;
  if (halves.length === 1) return head.length === 8 ? head : null;
  const gap = 8 - head.length - tail.length;
  return gap < 1 ? null : [...head, ...new Array<number>(gap).fill(0), ...tail];
}

/** Whether an address is on the public internet (ported from Criota's mcpOauthCore). Unreadable is not public. */
export function isPublicAddress(address: string): boolean {
  const kind = isIP(address);
  if (kind === 4) {
    const [a, b, c] = address.split('.').map(Number) as [number, number, number];
    return v4Public(a, b, c);
  }
  if (kind !== 6) return false;
  const g = v6Groups(address);
  if (!g) return false;
  const embedded = (hi: number, lo: number) => v4Public(hi >> 8, hi & 0xff, lo >> 8);
  if (g.slice(0, 5).every((x) => x === 0)) {
    if (g[5] === 0xffff) return embedded(g[6]!, g[7]!); // IPv4-mapped
    return false; // ::, ::1, IPv4-compatible
  }
  if (g[0] === 0x64 && g[1] === 0xff9b) return embedded(g[6]!, g[7]!); // NAT64
  if (g[0] === 0x2002) return embedded(g[1]!, g[2]!); // 6to4
  if ((g[0]! & 0xfe00) === 0xfc00) return false; // unique local
  if ((g[0]! & 0xffc0) === 0xfe80) return false; // link-local
  if ((g[0]! & 0xff00) === 0xff00) return false; // multicast
  if (g[0] === 0x2001 && g[1] === 0x0db8) return false; // documentation
  if (g[0] === 0x2001 && g[1] === 0) return false; // Teredo
  return (g[0]! & 0xe000) === 0x2000; // global unicast
}

export interface ResolvedAddress {
  address: string;
  family: 4 | 6;
}

/** One HTTP exchange with exactly the address given. The body is read up to `maxBytes`, then refused. */
export interface RawResponse {
  status: number;
  headers: Record<string, string | undefined>;
  body: Buffer;
}

export interface FetchDeps {
  /** Name → addresses. Injected in tests. */
  resolve(hostname: string): Promise<ResolvedAddress[]>;
  /** Connect to `address` (and nothing else) and ask for `url`. Never follows a redirect. */
  transport(url: URL, address: ResolvedAddress, limits: { maxBytes: number; timeoutMs: number }): Promise<RawResponse>;
  /** Whether an address may be fetched from. Always isPublicAddress outside tests of the transport itself. */
  allowAddress?(address: string): boolean;
}

export class FetchRefused extends AppError {
  constructor(message: string) {
    super('invalid', message);
  }
}

/** The address rules that need no network. */
export function checkFetchUrl(raw: string): URL {
  let u: URL;
  try {
    u = new URL(raw);
  } catch {
    throw new FetchRefused('That is not a web address.');
  }
  if (u.protocol !== 'http:' && u.protocol !== 'https:') throw new FetchRefused('Only http and https addresses can be read.');
  if (u.username || u.password) throw new FetchRefused('That address carries a password; give the plain page address.');
  if (u.port && !((u.protocol === 'http:' && u.port === '80') || (u.protocol === 'https:' && u.port === '443'))) throw new FetchRefused('Only addresses on the standard web ports can be read.');
  return u;
}

async function pickAddress(u: URL, deps: FetchDeps): Promise<ResolvedAddress> {
  const allow = deps.allowAddress ?? isPublicAddress;
  const host = u.hostname.replace(/^\[|\]$/g, '');
  const literal = isIP(host);
  const addresses: ResolvedAddress[] = literal ? [{ address: host, family: literal as 4 | 6 }] : await deps.resolve(host).catch(() => []);
  if (!addresses.length) throw new FetchRefused(`${u.hostname} could not be found.`);
  // Every address must pass: a name with one public and one private answer is refused.
  if (addresses.some((a) => !allow(a.address))) throw new FetchRefused(`${u.hostname} is not on the public internet, so it cannot be read.`);
  return addresses[0]!;
}

export interface FetchedPage {
  finalUrl: string;
  contentType: string;
  text: string;
}

/** Fetch one menu page by the rules above, and reduce it to text. */
export async function fetchMenuPage(rawUrl: string, deps: FetchDeps = nodeFetchDeps): Promise<FetchedPage> {
  let url = checkFetchUrl(rawUrl);
  // A wall-clock budget for network time, not business time: performance.now(), never the app clock.
  const deadline = performance.now() + FETCH_LIMITS.timeoutMs;
  for (let hop = 0; ; hop++) {
    const address = await pickAddress(url, deps);
    const left = deadline - performance.now();
    if (left <= 0) throw new FetchRefused('The page took too long to answer.');
    const res = await deps.transport(url, address, { maxBytes: FETCH_LIMITS.maxBytes, timeoutMs: left });
    if (res.status >= 300 && res.status < 400) {
      const location = res.headers.location;
      if (!location) throw new FetchRefused('The page redirected without saying where.');
      if (hop >= FETCH_LIMITS.maxRedirects) throw new FetchRefused('The page redirected too many times.');
      // Checked again from scratch: scheme, port, credentials, and where the new name resolves.
      url = checkFetchUrl(new URL(location, url).toString());
      continue;
    }
    if (res.status < 200 || res.status >= 300) throw new FetchRefused(`The page answered with an error (${res.status}).`);
    const type = (res.headers['content-type'] ?? '').split(';')[0]!.trim().toLowerCase();
    if (!TEXT_TYPES.includes(type)) throw new FetchRefused('That address is not a web page or text. Paste the menu text instead.');
    if (res.body.length > FETCH_LIMITS.maxBytes) throw new FetchRefused('That page is too large to read.');
    const raw = res.body.toString('utf8');
    const text = (type === 'text/plain' ? raw : htmlToText(raw)).slice(0, FETCH_LIMITS.maxTextChars);
    if (!text.trim()) throw new FetchRefused('There is no text on that page. Paste the menu text instead.');
    return { finalUrl: url.toString(), contentType: type, text };
  }
}

const ENTITIES: Record<string, string> = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ', ndash: '–', mdash: '—', hellip: '…', rsquo: '’', lsquo: '‘', rdquo: '”', ldquo: '“', eacute: 'é', egrave: 'è', agrave: 'à', ccedil: 'ç' };

/** HTML reduced to its visible text: scripts, styles and markup gone, blocks on their own lines. */
export function htmlToText(html: string): string {
  return html
    .replace(/<!--[\s\S]*?-->/g, ' ')
    .replace(/<(script|style|noscript|template|svg|iframe|object|head)\b[\s\S]*?<\/\1\s*>/gi, ' ')
    .replace(/<(br|\/p|\/div|\/li|\/h[1-6]|\/tr|\/section|\/article|\/dt|\/dd)\b[^>]*>/gi, '\n')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (m, e: string) => {
      if (e[0] === '#') {
        const n = e[1] === 'x' || e[1] === 'X' ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10);
        return Number.isFinite(n) && n > 31 && n < 0x110000 ? String.fromCodePoint(n) : ' ';
      }
      return ENTITIES[e.toLowerCase()] ?? m;
    })
    .replace(/[ \t\f\v\r]+/g, ' ')
    .replace(/ *\n */g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

/** The real network: DNS, then node's own http(s) client connected to the address that was checked. */
export const nodeFetchDeps: FetchDeps = {
  async resolve(hostname) {
    const list = await dnsLookup(hostname, { all: true, verbatim: true });
    return list.map((a) => ({ address: a.address, family: a.family === 6 ? 6 : 4 }));
  },
  transport(url, address, limits) {
    return new Promise<RawResponse>((resolve, reject) => {
      const client = url.protocol === 'https:' ? https : http;
      const req = client.request(
        url,
        {
          method: 'GET',
          headers: { 'user-agent': 'RestaurantOS-MenuImport/1.0', accept: 'text/html, text/plain;q=0.9' },
          // The connection goes to the address that was checked, and nowhere else.
          lookup: ((_host: string, opts: { all?: boolean }, cb: (...args: unknown[]) => void) =>
            opts?.all ? cb(null, [{ address: address.address, family: address.family }]) : cb(null, address.address, address.family)) as unknown as http.RequestOptions['lookup'],
          timeout: limits.timeoutMs,
        },
        (res) => {
          const declared = Number(res.headers['content-length'] ?? 0);
          if (declared > limits.maxBytes) {
            res.destroy();
            reject(new FetchRefused('That page is too large to read.'));
            return;
          }
          const chunks: Buffer[] = [];
          let size = 0;
          res.on('data', (c: Buffer) => {
            size += c.length;
            if (size > limits.maxBytes) {
              res.destroy();
              reject(new FetchRefused('That page is too large to read.'));
              return;
            }
            chunks.push(c);
          });
          res.on('end', () => {
            const headers: Record<string, string | undefined> = {};
            for (const [k, v] of Object.entries(res.headers)) headers[k] = Array.isArray(v) ? v.join(', ') : v;
            resolve({ status: res.statusCode ?? 0, headers, body: Buffer.concat(chunks) });
          });
          res.on('error', reject);
        },
      );
      req.setTimeout(limits.timeoutMs, () => req.destroy(new FetchRefused('The page took too long to answer.')));
      req.on('error', (e) => reject(e instanceof FetchRefused ? e : new FetchRefused('The page could not be reached.')));
      req.end();
    });
  },
};
