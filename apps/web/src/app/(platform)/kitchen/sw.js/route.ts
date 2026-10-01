import { KITCHEN_SERVICE_WORKER } from '@/components/kitchen/service-worker';

export const dynamic = 'force-static';

/**
 * The kitchen screen's service worker, scoped to /kitchen and nothing else (the header below
 * lets a script at /kitchen/sw.js claim the /kitchen scope). It never sees console pages, and
 * venue sites live on other hosts, where it is not registered at all.
 */
export function GET(): Response {
  return new Response(KITCHEN_SERVICE_WORKER, {
    headers: {
      'content-type': 'text/javascript; charset=utf-8',
      'cache-control': 'no-cache',
      'service-worker-allowed': '/kitchen',
    },
  });
}
