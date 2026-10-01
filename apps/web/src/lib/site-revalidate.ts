import 'server-only';
import { revalidateTag } from 'next/cache';
import { website } from '@ros/modules';

/**
 * Where the website module's cache tags meet Next's tag revalidation.
 *
 * The module calls every registered revalidator after a publish, an unpublish, a brand change or
 * a redirect import has committed, with the tags that change touches (`org:<id>`, `page:<id>`,
 * `menu:<venue>`). Whichever surface made the change (a console action, an assistant's tool call
 * on /api/mcp, a platform page, the in-process worker), two things happen here:
 *
 *   1. The organisation's cache generation in this process moves on. The generation is part of
 *      every cache key (site-cache.ts), so the next read cannot be answered by anything stored
 *      before the change. This is what makes "published, then read" exact.
 *   2. Next is told to expire the tag (`expire: 0`), which is what reaches a cache shared with
 *      other instances, and lets Next drop the old entries.
 *
 * Why not the tag alone: Next stamps a revalidation with Date.now() and compares it against
 * performance.timeOrigin + performance.now(). Where the two clocks have drifted apart (seen on
 * this project's own machine, by tens of milliseconds within minutes of start-up), an entry
 * expired a moment ago is judged merely stale and served once more while it is refreshed in the
 * background. One more stale page after a publish is exactly what this cache must not do.
 *
 * Next refuses revalidateTag outside a request (the worker). That is expected and ignored: the
 * generation has already moved on, and cached entries also carry a time limit (site-cache.ts).
 */
const g = globalThis as { __rosSiteGenerations?: Map<string, number>; __rosSiteRevalidation?: () => void };
// On globalThis: the bundler may evaluate this file in more than one chunk of the one process.
const generations = (g.__rosSiteGenerations ??= new Map<string, number>());

const ORG_TAG = /^org:([0-9a-f-]{36})$/;

/** The cache generation of one organisation's site in this process. Part of every cache key for it. */
export function siteGeneration(orgId: string): number {
  return generations.get(orgId) ?? 0;
}

export function bustTags(tags: string[]): void {
  for (const tag of new Set(tags)) {
    const org = ORG_TAG.exec(tag)?.[1];
    if (org) generations.set(org, siteGeneration(org) + 1);
    try {
      revalidateTag(tag, { expire: 0 });
    } catch {
      // Not inside a request.
    }
  }
}

/** Everything cached for one org's sites. Called by console actions that change what a published page shows without publishing. */
export function bustSite(orgId: string): void {
  bustTags([website.cacheTags.org(orgId)]);
}

// Once per process, however many chunks evaluate this file.
g.__rosSiteRevalidation?.();
g.__rosSiteRevalidation = website.onRevalidate(bustTags);
