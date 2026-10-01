import { website } from '@ros/modules';
import { atLeast, getConsole } from '@/lib/console';
import { moduleOn } from '@/lib/console-modules';
import { read } from '@/lib/console-read';
import { ActionForm, Card, Checkbox, EmptyState, Field, SubmitButton, Table, Td, Textarea, Th } from '@/ui';
import { ConfirmAction } from '@/components/console/confirm';
import { ModuleOff, NotForYourRole, ReadError } from '@/components/console/states';
import { WebsiteFrame } from '@/components/console/website-frame';
import { importRedirects, removeRedirect } from '../actions';

export const metadata = { title: 'Redirects · Restaurant OS' };

export default async function RedirectsPage() {
  const c = await getConsole();
  if (!atLeast(c.role, 'manager')) return <NotForYourRole title="Website">The website is edited by a manager.</NotForYourRole>;
  if (!(await moduleOn('website'))) return <ModuleOff title="Website" what="The website" canManage />;
  const r = await read((ctx) => website.listRedirects(ctx));
  const frame = { current: '/console/website/redirects', site: 'org' as const, venueName: c.venue.name, orgName: c.org.tradingName, multi: c.venues.length > 1 };

  return (
    <WebsiteFrame {...frame} title="Redirects" description="Old addresses sent to a page on this site, so links from an old website and search results keep working.">
      <div className="grid gap-6 xl:grid-cols-[minmax(0,2fr)_minmax(0,1fr)]">
        <Card padded={false}>
          {!r.ok ? (
            <div className="p-5">
              <ReadError message={r.error} />
            </div>
          ) : r.data.length === 0 ? (
            <div className="p-5">
              <EmptyState title="No redirects">Paste a list from the old site to add some.</EmptyState>
            </div>
          ) : (
            <Table>
              <thead>
                <tr>
                  <Th>Old address</Th>
                  <Th>Goes to</Th>
                  <Th align="right">Used</Th>
                  <Th>
                    <span className="sr-only">Remove</span>
                  </Th>
                </tr>
              </thead>
              <tbody>
                {r.data.map((x) => (
                  <tr key={x.id}>
                    <Td className="break-all font-mono text-xs">{x.from}</Td>
                    <Td className="break-all font-mono text-xs">
                      {x.to}
                      {x.statusCode === 302 ? <span className="ml-1 font-sans text-ink-3">(temporary)</span> : null}
                    </Td>
                    <Td numeric>{x.hits.toLocaleString('en-AU')}</Td>
                    <Td align="right">
                      <ConfirmAction trigger="Remove" title="Remove this redirect?" action={removeRedirect} hidden={{ redirectId: x.id }} confirmLabel="Remove redirect" triggerVariant="ghost">
                        Visitors following links to {x.from} get a not-found page instead of {x.to}.
                      </ConfirmAction>
                    </Td>
                  </tr>
                ))}
              </tbody>
            </Table>
          )}
        </Card>
        <Card title="Add redirects" description="One per line: the old address, then the page here. Add 302 at the end for a temporary one.">
          <ActionForm action={importRedirects}>
            <Field label="Redirects">
              <Textarea name="entries" required rows={8} className="font-mono text-xs" placeholder={'/menu.html /menu\nhttps://old-site.example/about-us/ /about'} />
            </Field>
            <Checkbox name="replace" label="Replace every existing redirect" hint="Leave unticked to add to the list." className="mt-3" />
            <div className="mt-4 flex justify-end">
              <SubmitButton>Add</SubmitButton>
            </div>
          </ActionForm>
        </Card>
      </div>
    </WebsiteFrame>
  );
}
