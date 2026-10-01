import Link from 'next/link';
import { notFound } from 'next/navigation';
import { menu } from '@ros/modules';
import { atLeast, getConsole } from '@/lib/console';
import { read } from '@/lib/console-read';
import { ActionForm, Card, Checkbox, PageHeader, SubmitButton } from '@/ui';
import { ConfirmAction } from '@/components/console/confirm';
import { ItemFields } from '@/components/console/menu-fields';
import { NotForYourRole, ReadError } from '@/components/console/states';
import { deleteItem, setItemGroups, updateItem } from '../../actions';

export const metadata = { title: 'Edit item · Restaurant OS' };

export default async function ItemPage({ params }: { params: Promise<{ itemId: string }> }) {
  const { itemId } = await params;
  const c = await getConsole();
  if (!atLeast(c.role, 'manager')) return <NotForYourRole title="Edit item">Only a manager can change the menu. You can still 86 items from the menu page.</NotForYourRole>;
  const r = await read((ctx) => menu.getMenuEditor(ctx, c.venue.id));
  if (!r.ok) return <ReadError message={r.error} />;
  const v = r.data;
  const sections = v.menus.flatMap((m) => m.sections.map((s) => ({ id: s.id, label: `${m.name} · ${s.name}`, items: s.items })));
  // Only an item at the selected venue can be edited here; anything else is not found.
  const item = sections.flatMap((s) => s.items).find((i) => i.id === itemId);
  if (!item) notFound();

  return (
    <>
      <p className="mb-2 text-sm">
        <Link href="/console/menu" className="text-accent underline-offset-2 hover:underline">
          ← Menu
        </Link>
      </p>
      <PageHeader
        title={item.name}
        description="Changes show on the website, the QR menu and in ordering as soon as they are saved."
        actions={
          <ConfirmAction trigger="Remove item" title={`Remove ${item.name}?`} action={deleteItem} hidden={{ itemId: item.id, backToMenu: 'true' }} confirmLabel="Remove item">
            {item.name} comes off every menu guests can see. Past orders, receipts and sales keep their record of it. To take it off for tonight only, 86 it instead.
          </ConfirmAction>
        }
      />
      <div className="grid gap-6 lg:grid-cols-[minmax(0,2fr)_minmax(0,1fr)]">
        <Card title="Details">
          <ActionForm action={updateItem}>
            <input type="hidden" name="itemId" value={item.id} />
            <ItemFields i={item} sections={sections.map(({ id, label }) => ({ id, label }))} />
            <div className="mt-5 flex justify-end">
              <SubmitButton>Save item</SubmitButton>
            </div>
          </ActionForm>
        </Card>
        <Card title="Choices offered" description="The groups a guest picks from when ordering this item.">
          {v.modifierGroups.length === 0 ? (
            <p className="text-sm text-ink-2">
              No groups of choices exist yet. Create one on the{' '}
              <Link href="/console/menu" className="text-accent underline-offset-2 hover:underline">
                menu page
              </Link>
              .
            </p>
          ) : (
            <ActionForm action={setItemGroups}>
              <input type="hidden" name="itemId" value={item.id} />
              <div className="space-y-2">
                {v.modifierGroups.map((g) => (
                  <Checkbox key={g.id} name="groupIds" value={g.id} label={g.name} hint={g.modifiers.map((m) => m.name).join(', ') || 'No choices yet'} defaultChecked={item.modifierGroupIds.includes(g.id)} />
                ))}
              </div>
              <div className="mt-4 flex justify-end">
                <SubmitButton variant="secondary">Save choices</SubmitButton>
              </div>
            </ActionForm>
          )}
        </Card>
      </div>
    </>
  );
}
