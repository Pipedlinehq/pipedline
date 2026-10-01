import { type Ctx, hookList } from '@ros/core';

/**
 * Cache tags (docs/modules/website.md section 4). Tenant pages are rendered statically and
 * revalidated by tag, so a change busts exactly that tenant and nothing else.
 */
export const cacheTags = {
  org: (orgId: string) => `org:${orgId}`,
  page: (pageId: string) => `page:${pageId}`,
  menu: (venueId: string) => `menu:${venueId}`,
};

export type Revalidator = (tags: string[]) => void | Promise<void>;
const revalidators = hookList<Revalidator>('website.revalidators');

/**
 * The web app registers how a tag is revalidated (Next's revalidateTag) once at start-up. Every
 * publish then busts the cache whichever surface caused it: the console, an assistant's tool
 * or provisioning. Returns a function that removes the registration.
 */
export function onRevalidate(fn: Revalidator): () => void {
  revalidators.add(fn);
  return () => revalidators.remove(fn);
}

/** Bust these tags once the transaction has committed, and never if it rolls back. */
export function revalidateAfterCommit(ctx: Ctx, tags: string[]): void {
  if (!tags.length) return;
  ctx.afterCommit(async () => {
    for (const fn of revalidators.all()) await fn(tags);
  });
}
