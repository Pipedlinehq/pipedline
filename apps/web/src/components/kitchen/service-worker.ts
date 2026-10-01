/**
 * The kitchen screen's service worker (served at /kitchen/sw.js, scope /kitchen).
 *
 * What it does, and no more:
 *   - the /kitchen page itself, and the script and style files it loads, are fetched from the
 *     network first and kept in a cache, so the screen can be reopened while the connection is
 *     down and still draw the tickets it last received (those live in the page's own storage);
 *   - /kitchen/api/* is never cached or answered from cache: ticket data and taps always go to
 *     the server, and the page itself queues taps while they cannot;
 *   - nothing outside /kitchen and /_next/static is touched. The console is outside the scope,
 *     and venue sites are on other hosts where this worker is never registered.
 *
 * It never reloads the page: a new version waits in the background and takes over the next time
 * the screen is opened, so a deploy cannot interrupt a service (docs/DEPLOYMENT.md section 7).
 */
export const KITCHEN_SERVICE_WORKER = `
const CACHE = 'ros-kitchen-v1';
const SHELL = '/kitchen';

// Keep the page and every script and style it names, so the screen can be reopened with no connection.
async function precache() {
  const cache = await caches.open(CACHE);
  const res = await fetch(SHELL, { credentials: 'same-origin' });
  if (!res.ok || res.redirected) return;
  const html = await res.clone().text();
  await cache.put(SHELL, res);
  // Every quoted /_next/static/... address in the page (a trailing backslash is the page's own JSON escaping).
  const BACKSLASH = String.fromCharCode(92);
  const assets = [...new Set(html.split('"').filter((p) => p.startsWith('/_next/static/') && !p.includes(' ')).map((p) => (p.endsWith(BACKSLASH) ? p.slice(0, -1) : p)))];
  await Promise.all(assets.map((a) => cache.add(a).catch(() => undefined)));
}

self.addEventListener('install', (event) => {
  event.waitUntil(precache().catch(() => undefined));
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys().then((keys) => Promise.all(keys.filter((k) => k.startsWith('ros-kitchen-') && k !== CACHE).map((k) => caches.delete(k)))).then(() => self.clients.claim()),
  );
});

function cacheable(url, request) {
  if (request.method !== 'GET') return false;
  if (url.origin !== self.location.origin) return false;
  if (url.pathname.startsWith('/kitchen/api/')) return false;
  if (request.mode === 'navigate') return url.pathname === '/kitchen' || url.pathname.startsWith('/kitchen/');
  return url.pathname.startsWith('/_next/static/') || url.pathname === '/kitchen/manifest.webmanifest' || url.pathname === '/kitchen/app-icon';
}

self.addEventListener('fetch', (event) => {
  const request = event.request;
  const url = new URL(request.url);
  if (!cacheable(url, request)) return;
  event.respondWith(
    fetch(request)
      .then((response) => {
        if (response.ok && response.type === 'basic' && !response.redirected) {
          const copy = response.clone();
          caches.open(CACHE).then((c) => c.put(request, copy)).catch(() => undefined);
        }
        return response;
      })
      .catch(async () => {
        const hit = await caches.match(request);
        if (hit) return hit;
        if (request.mode === 'navigate') {
          const shell = await caches.match(SHELL);
          if (shell) return shell;
        }
        return Response.error();
      }),
  );
});
`;
