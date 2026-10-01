import { z } from 'zod';
import { defineTool, notFound } from '@ros/core';
import { type BlockCopyPreview, listPageCopy, previewBlockCopy, updateBlockCopy } from './pages';

const quote = (s: string | null) => (s === null ? 'nothing' : `"${s.length > 240 ? `${s.slice(0, 240)}…` : s}"`);

/** The wording on the venue's published pages, so an assistant knows what it can change and what it says now. */
export const pageCopyTool = defineTool({
  name: 'page_copy',
  module: 'website',
  title: 'Read the wording on the website',
  description:
    'The text on the venue\'s published web pages, section by section: headings, body copy and button labels, each with the section id needed to change it. Does not include the menu, hours or contact details, which come from the venue\'s records.',
  effect: 'read',
  scope: 'website:read',
  venueScoped: true,
  input: z.object({ page: z.string().max(60).optional().describe('A page address such as "home" or "about". Leave out for every page.') }),
  output: z.object({
    pages: z.array(
      z.object({
        page: z.string(),
        title: z.string(),
        sections: z.array(z.object({ section_id: z.string(), kind: z.string(), text: z.record(z.string(), z.string().nullable()) })),
      }),
    ),
  }),
  async run({ ctx, venueId }, input) {
    const pages = await listPageCopy(ctx, { venueId, slug: input.page });
    return { pages: pages.map((p) => ({ page: p.slug, title: p.title, sections: p.blocks.map((b) => ({ section_id: b.blockId, kind: b.type, text: b.text })) })) };
  },
});

function question(p: BlockCopyPreview): string {
  const where = `On the "${p.pageTitle}" page, in the ${p.blockType} section`;
  if (!p.changes.length) return `${where}, nothing would change: the wording is already as given.`;
  const lines = p.changes.map((c) => `${c.field}: from ${quote(c.before)} to ${quote(c.after)}`);
  return `${where}, change the ${lines.join('; and the ')}? This goes live on the website straight away.`;
}

export const pageUpdateCopyTool = defineTool({
  name: 'page_update_copy',
  module: 'website',
  title: 'Change wording on the website',
  description:
    'Change the text of one section on one published page (a heading, body copy or a button label) and publish it. Text only: links, images, the menu and hours are changed elsewhere. Read the current wording with page_copy first.',
  effect: 'write',
  scope: 'website:write',
  minRole: 'manager',
  venueScoped: true,
  input: z.object({
    page: z.string().max(60).describe('The page address, e.g. "home"'),
    section_id: z.string().max(40).describe('The section id from page_copy'),
    changes: z.record(z.string(), z.string().max(4000).nullable()).describe('Field name to new text, e.g. {"heading": "Open for lunch"}. null clears an optional field.'),
  }),
  output: z.object({
    page: z.string(),
    section_id: z.string(),
    changed: z.array(z.object({ field: z.string(), before: z.string().nullable(), after: z.string().nullable() })),
    published_at: z.string(),
  }),
  async propose({ ctx, venueId }, input) {
    const page = (await listPageCopy(ctx, { venueId, slug: input.page }))[0];
    if (!page) throw notFound('That page is not published on the website.');
    const args = { pageId: page.pageId, blockId: input.section_id, changes: input.changes };
    const preview = await previewBlockCopy(ctx, args);
    return {
      question: question(preview),
      commit: async () => {
        const r = await updateBlockCopy(ctx, args, 'assistant');
        return { page: r.slug, section_id: r.blockId, changed: r.changes, published_at: r.publishedAt.toISOString() };
      },
    };
  },
});
