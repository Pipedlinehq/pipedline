import Link from 'next/link';
import { onboarding } from '@ros/modules';
import { atLeast, getConsole } from '@/lib/console';
import { read } from '@/lib/console-read';
import { NotForYourRole, ReadError } from '@/components/console/states';
import { ActionForm, Badge, Card, EmptyState, Field, Input, LinkButton, PageHeader, SubmitButton, Table, Td, Th, Textarea, dateTime } from '@/ui';
import { startImport } from './actions';

export const metadata = { title: 'Import a menu · Restaurant OS' };

type Tone = 'neutral' | 'good' | 'warn' | 'bad' | 'accent';
const IMPORT_STATUS: Record<string, { label: string; tone: Tone }> = {
  extracting: { label: 'Being read', tone: 'accent' },
  extracted: { label: 'Waiting for you', tone: 'warn' },
  confirmed: { label: 'Finished', tone: 'good' },
  discarded: { label: 'Left out', tone: 'neutral' },
  failed: { label: 'Could not be read', tone: 'bad' },
};

/** Start an import, and the imports already made for this venue. */
export default async function MenuImportPage() {
  const c = await getConsole();
  if (!atLeast(c.role, 'manager')) return <NotForYourRole title="Import a menu">A manager imports a menu and checks each item.</NotForYourRole>;
  const imports = await read((ctx) => onboarding.listMenuImports(ctx, { venueId: c.venue.id }));
  const tz = c.venue.timezone;
  return (
    <>
      <PageHeader
        title="Import a menu"
        description={`Paste ${c.venue.name}’s menu, or give the address of the page it is on. It is read for you and laid out as proposed items. Nothing goes on the menu until you have looked at each item and added it.`}
        actions={<LinkButton href="/console/menu">Back to the menu</LinkButton>}
      />
      <div className="grid gap-6 xl:grid-cols-[minmax(0,2fr)_minmax(0,3fr)]">
        <Card title="Read a menu">
          <ActionForm action={startImport} className="space-y-4">
            <Field label="Paste the menu" hint="Section names, dishes, descriptions and prices, as they appear.">
              <Textarea name="text" rows={10} maxLength={60000} />
            </Field>
            <p className="text-center text-xs text-ink-2">or</p>
            <Field label="The address of the menu page" hint="A public https:// page. A PDF or a photo cannot be read yet.">
              <Input name="url" type="url" placeholder="https://" />
            </Field>
            <SubmitButton pendingLabel="Starting…">Read this menu</SubmitButton>
          </ActionForm>
        </Card>
        <Card title="Imports" padded={false}>
          {!imports.ok ? (
            <div className="p-5">
              <ReadError message={imports.error} />
            </div>
          ) : imports.data.length === 0 ? (
            <div className="p-5">
              <EmptyState title="No imports yet">A menu you read appears here with how many of its items are still waiting for you.</EmptyState>
            </div>
          ) : (
            <Table>
              <thead>
                <tr>
                  <Th>Started</Th>
                  <Th>From</Th>
                  <Th>Items</Th>
                  <Th>Status</Th>
                </tr>
              </thead>
              <tbody>
                {imports.data.map((i) => {
                  const s = IMPORT_STATUS[i.status] ?? IMPORT_STATUS.extracting!;
                  return (
                    <tr key={i.id} data-testid={`import-${i.id}`}>
                      <Td className="whitespace-nowrap">
                        <Link href={`/console/menu/import/${i.id}`} className="font-medium text-accent underline-offset-2 hover:underline">
                          {dateTime(i.createdAt, tz)}
                        </Link>
                      </Td>
                      <Td className="max-w-56 break-words">{i.source.kind === 'url' ? i.source.url : 'Pasted text'}</Td>
                      <Td>
                        {i.counts.proposed} waiting, {i.counts.confirmed} added, {i.counts.discarded} left out
                      </Td>
                      <Td>
                        <Badge tone={s.tone}>{s.label}</Badge>
                      </Td>
                    </tr>
                  );
                })}
              </tbody>
            </Table>
          )}
        </Card>
      </div>
    </>
  );
}
