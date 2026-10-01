import Link from 'next/link';
import { website } from '@ros/modules';
import { atLeast, getConsole } from '@/lib/console';
import { moduleOn } from '@/lib/console-modules';
import { read } from '@/lib/console-read';
import { ActionForm, Badge, Card, Dialog, EmptyState, Field, Input, SubmitButton, Table, Td, Th, dateTime } from '@/ui';
import { siteBase } from '@/components/console/site-url';
import { ModuleOff, NotForYourRole, ReadError } from '@/components/console/states';
import { WebsiteFrame, readSite } from '@/components/console/website-frame';
import { createPage } from './actions';

export const metadata = { title: 'Website · Pipedline' };

export default async function WebsitePages({ searchParams }: { searchParams: Promise<{ site?: string }> }) {
  const c = await getConsole();
  if (!atLeast(c.role, 'manager')) return <NotForYourRole title="Website">The website is edited by a manager.</NotForYourRole>;
  if (!(await moduleOn('website'))) return <ModuleOff title="Website" what="The website" canManage />;
  const site = readSite((await searchParams).site, c.venues.length);
  const venueId = site === 'venue' ? c.venue.id : null;
  const r = await read(async (ctx) => ({ pages: await website.listPages(ctx, { venueId }), base: await siteBase(ctx, c.venue.id) }));
  const frame = { current: '/console/website', site, venueName: c.venue.name, orgName: c.org.tradingName, multi: c.venues.length > 1 };

  return (
    <WebsiteFrame
      {...frame}
      title="Website"
      description="Pages are built from sections. Edits are saved as a draft; nothing changes on the site until you publish."
      actions={
        <Dialog trigger="New page" title="New page" triggerVariant="primary">
          <ActionForm action={createPage}>
            <input type="hidden" name="site" value={site} />
            <div className="space-y-4">
              <Field label="Title">
                <Input name="title" required maxLength={120} placeholder="Private dining" />
              </Field>
              <Field label="Address" hint="Lowercase letters, numbers and hyphens: /private-dining.">
                <Input name="slug" required maxLength={60} placeholder="private-dining" />
              </Field>
            </div>
            <div className="mt-4 flex justify-end">
              <SubmitButton>Create draft</SubmitButton>
            </div>
          </ActionForm>
        </Dialog>
      }
    >
      {!r.ok ? (
        <ReadError message={r.error} />
      ) : r.data.pages.length === 0 ? (
        <EmptyState title="No pages yet">{site === 'venue' ? `${c.venue.name} uses the group site's pages until it has its own.` : 'Create the first page.'}</EmptyState>
      ) : (
        <Card padded={false}>
          <Table>
            <thead>
              <tr>
                <Th>Page</Th>
                <Th>Address</Th>
                <Th>Status</Th>
                <Th>Last change</Th>
              </tr>
            </thead>
            <tbody>
              {[...r.data.pages].sort((a, b) => (a.slug === 'home' ? -1 : b.slug === 'home' ? 1 : a.title.localeCompare(b.title))).map((p) => (
                <tr key={p.id}>
                  <Td>
                    <Link href={`/console/website/pages/${p.id}`} className="font-medium text-ink underline-offset-2 hover:underline">
                      {p.title}
                    </Link>
                  </Td>
                  <Td>
                    <span className="font-mono text-xs text-ink-2">/{p.slug === 'home' ? '' : p.slug}</span>
                  </Td>
                  <Td>
                    <span className="flex flex-wrap gap-1">
                      {p.status === 'published' ? <Badge tone="good">Live</Badge> : <Badge>Draft only</Badge>}
                      {p.status === 'published' && p.hasUnpublishedChanges ? <Badge tone="warn">Unpublished changes</Badge> : null}
                    </span>
                  </Td>
                  <Td className="text-ink-2">{dateTime(p.updatedAt, c.venue.timezone)}</Td>
                </tr>
              ))}
            </tbody>
          </Table>
          <p className="px-4 py-3 text-xs text-ink-3">
            The site is at <span className="font-mono">{r.data.base}</span>
          </p>
        </Card>
      )}
    </WebsiteFrame>
  );
}
