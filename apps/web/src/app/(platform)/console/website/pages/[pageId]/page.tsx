import Link from 'next/link';
import { website } from '@ros/modules';
import { atLeast, getConsole } from '@/lib/console';
import { moduleOn } from '@/lib/console-modules';
import { read } from '@/lib/console-read';
import { ActionForm, Badge, Card, Field, Input, PageHeader, Select, SubmitButton, Textarea, dateTime } from '@/ui';
import { BlockFields } from '@/components/console/block-fields';
import { BLOCK_LABELS } from '@/components/console/block-form';
import { ConfirmAction, InlineAction } from '@/components/console/confirm';
import { siteBase } from '@/components/console/site-url';
import { ModuleOff, NotForYourRole, ReadError } from '@/components/console/states';
import { addBlock, deletePage, discardDraft, moveBlock, publishPage, removeBlock, saveBlock, savePageMeta, unpublishPage } from '../../actions';

export const metadata = { title: 'Edit page · Pipedline' };

export default async function PageEditor({ params }: { params: Promise<{ pageId: string }> }) {
  const { pageId } = await params;
  const c = await getConsole();
  if (!atLeast(c.role, 'manager')) return <NotForYourRole title="Website">The website is edited by a manager.</NotForYourRole>;
  if (!(await moduleOn('website'))) return <ModuleOff title="Website" what="The website" canManage />;
  const r = await read(async (ctx) => ({
    page: await website.getPageForEdit(ctx, { pageId }),
    media: await website.listMedia(ctx, { limit: 60 }),
    base: await siteBase(ctx, c.venue.id),
  }));
  if (!r.ok) {
    return (
      <>
        <PageHeader title="Website" />
        <ReadError message={r.error} />
      </>
    );
  }
  const { page, media, base } = r.data;
  const content = page.draft ?? page.published ?? { title: page.title, blocks: [], seoTitle: null, seoDescription: null, ogImageUrl: null };
  const live = page.status === 'published';
  const hidden = { pageId: page.id };
  const mediaUrls = media.map((m) => m.url);
  const address = `${base}/${page.slug === 'home' ? '' : page.slug}`;

  return (
    <>
      <p className="mb-2 text-sm">
        <Link href={`/console/website${page.venueId ? '?site=venue' : ''}`} className="text-accent underline-offset-2 hover:underline">
          ← Pages
        </Link>
      </p>
      <PageHeader
        title={content.title}
        description={
          <>
            <span className="font-mono text-xs">{address}</span>
            <span className="ml-2 inline-flex gap-1 align-middle">
              {live ? <Badge tone="good">Live</Badge> : <Badge>Draft only</Badge>}
              {live && page.draft ? <Badge tone="warn">Unpublished changes</Badge> : null}
            </span>
            {page.publishedAt ? <span className="ml-2 text-xs text-ink-3">published {dateTime(page.publishedAt, c.venue.timezone)}</span> : null}
          </>
        }
        actions={
          <>
            {/* Always mounted, so its confirmation stays on screen after the page re-renders as published. */}
            <ConfirmAction trigger={page.draft || !live ? 'Publish' : 'Publish again'} title={`Publish ${content.title}?`} action={publishPage} hidden={hidden} confirmLabel="Publish now" variant="primary" triggerVariant={page.draft || !live ? 'primary' : 'secondary'} triggerSize="md" testId="publish-page">
              {live ? 'The live page is replaced by this draft' : 'The page goes live'} at {address} straight away. Anyone visiting the site sees it.
            </ConfirmAction>
            {live && page.draft ? (
              <ConfirmAction trigger="Discard draft" title="Throw away the draft?" action={discardDraft} hidden={hidden} confirmLabel="Discard draft" triggerSize="md">
                Every unpublished change to this page is lost. The live page stays as it is.
              </ConfirmAction>
            ) : null}
            {live && page.slug !== 'home' ? (
              <ConfirmAction trigger="Take off the site" title="Take this page off the site?" action={unpublishPage} hidden={hidden} confirmLabel="Take it down" triggerSize="md">
                {address} stops showing this page; visitors get a not-found page instead. The content is kept as a draft.
              </ConfirmAction>
            ) : null}
            {page.slug !== 'home' ? (
              <ConfirmAction trigger="Delete" title={`Delete ${content.title}?`} action={deletePage} hidden={hidden} confirmLabel="Delete page" triggerSize="md" triggerVariant="ghost">
                The page and its draft are deleted for good{live ? `, and ${address} stops working. Add a redirect if people link to it` : ''}.
              </ConfirmAction>
            ) : null}
          </>
        }
      />

      <div className="grid gap-6 xl:grid-cols-[minmax(0,2fr)_minmax(0,1fr)]">
        <div className="space-y-4" data-testid="blocks">
          {content.blocks.length === 0 ? (
            <Card>
              <p className="text-sm text-ink-2">This page has no sections yet. Add one on the right; a page needs at least one before it can be published.</p>
            </Card>
          ) : (
            content.blocks.map((b, i) => (
              <Card
                key={b.id}
                title={BLOCK_LABELS[b.type]}
                description={`Section ${i + 1} of ${content.blocks.length}`}
                actions={
                  <>
                    {i > 0 ? <InlineAction action={moveBlock} hidden={{ ...hidden, blockId: b.id, direction: 'up' }} label="↑" pendingLabel="…" /> : null}
                    {i < content.blocks.length - 1 ? <InlineAction action={moveBlock} hidden={{ ...hidden, blockId: b.id, direction: 'down' }} label="↓" pendingLabel="…" /> : null}
                    <ConfirmAction trigger="Remove" title="Remove this section?" action={removeBlock} hidden={{ ...hidden, blockId: b.id }} confirmLabel="Remove section" triggerVariant="ghost">
                      The section is taken out of the draft. The live page keeps it until you publish.
                    </ConfirmAction>
                  </>
                }
              >
                <ActionForm action={saveBlock}>
                  <input type="hidden" name="pageId" value={page.id} />
                  <input type="hidden" name="blockId" value={b.id} />
                  <input type="hidden" name="type" value={b.type} />
                  <BlockFields block={b} mediaUrls={mediaUrls} />
                  <div className="mt-4 flex justify-end">
                    <SubmitButton variant="secondary">Save section</SubmitButton>
                  </div>
                </ActionForm>
              </Card>
            ))
          )}
        </div>

        <div className="space-y-4">
          <Card title="Add a section">
            <ActionForm action={addBlock}>
              <input type="hidden" name="pageId" value={page.id} />
              <Field label="Kind">
                <Select name="type" defaultValue="about">
                  {website.BLOCK_TYPES.map((t) => (
                    <option key={t} value={t}>
                      {BLOCK_LABELS[t]}
                    </option>
                  ))}
                </Select>
              </Field>
              <div className="mt-3 flex justify-end">
                <SubmitButton variant="secondary">Add to the end</SubmitButton>
              </div>
            </ActionForm>
          </Card>
          <Card title="Page details" description="The title, and what search engines and link previews show.">
            <ActionForm action={savePageMeta}>
              <input type="hidden" name="pageId" value={page.id} />
              <div className="space-y-3">
                <Field label="Title">
                  <Input name="title" required maxLength={120} defaultValue={content.title} />
                </Field>
                <Field label="Search title" hint="Up to 70 characters. Optional.">
                  <Input name="seoTitle" maxLength={70} defaultValue={content.seoTitle ?? ''} />
                </Field>
                <Field label="Search description" hint="Up to 200 characters. Optional.">
                  <Textarea name="seoDescription" maxLength={200} defaultValue={content.seoDescription ?? ''} />
                </Field>
                <Field label="Link preview image" hint="Optional.">
                  <Input name="ogImageUrl" defaultValue={content.ogImageUrl ?? ''} />
                </Field>
              </div>
              <div className="mt-4 flex justify-end">
                <SubmitButton variant="secondary">Save details</SubmitButton>
              </div>
            </ActionForm>
          </Card>
        </div>
      </div>
    </>
  );
}
