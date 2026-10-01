import Link from 'next/link';
import { notFound } from 'next/navigation';
import { menu } from '@ros/modules';
import { atLeast, getConsole } from '@/lib/console';
import { read } from '@/lib/console-read';
import { ActionForm, Card, PageHeader, SubmitButton, money } from '@/ui';
import { ConfirmAction } from '@/components/console/confirm';
import { GroupFields, ModifierFields } from '@/components/console/menu-fields';
import { NotForYourRole, ReadError } from '@/components/console/states';
import { createModifier, deleteGroup, deleteModifier, updateGroup, updateModifier } from '../../actions';

export const metadata = { title: 'Edit choices · Pipedline' };

export default async function GroupPage({ params }: { params: Promise<{ groupId: string }> }) {
  const { groupId } = await params;
  const c = await getConsole();
  if (!atLeast(c.role, 'manager')) return <NotForYourRole title="Edit choices">Only a manager can change the menu.</NotForYourRole>;
  const r = await read((ctx) => menu.getMenuEditor(ctx, c.venue.id));
  if (!r.ok) return <ReadError message={r.error} />;
  const g = r.data.modifierGroups.find((x) => x.id === groupId);
  if (!g) notFound();
  const usedBy = r.data.menus.flatMap((m) => m.sections.flatMap((s) => s.items)).filter((i) => i.modifierGroupIds.includes(g.id));

  return (
    <>
      <p className="mb-2 text-sm">
        <Link href="/console/menu" className="text-accent underline-offset-2 hover:underline">
          ← Menu
        </Link>
      </p>
      <PageHeader
        title={g.name}
        description={usedBy.length ? `Offered with ${usedBy.map((i) => i.name).join(', ')}.` : 'Not offered with any item yet.'}
        actions={
          <ConfirmAction trigger="Remove group" title={`Remove ${g.name}?`} action={deleteGroup} hidden={{ groupId: g.id, backToMenu: 'true' }} confirmLabel="Remove group">
            {g.name} and its {g.modifiers.length} choices are taken off {usedBy.length} {usedBy.length === 1 ? 'item' : 'items'}. Guests stop being asked this question.
          </ConfirmAction>
        }
      />
      <div className="grid gap-6 lg:grid-cols-2">
        <Card title="The question">
          <ActionForm action={updateGroup}>
            <input type="hidden" name="groupId" value={g.id} />
            <GroupFields g={g} />
            <div className="mt-4 flex justify-end">
              <SubmitButton>Save</SubmitButton>
            </div>
          </ActionForm>
        </Card>
        <Card title="Add a choice">
          <ActionForm action={createModifier} resetOnSuccess>
            <input type="hidden" name="groupId" value={g.id} />
            <ModifierFields />
            <div className="mt-4 flex justify-end">
              <SubmitButton>Add choice</SubmitButton>
            </div>
          </ActionForm>
        </Card>
      </div>
      <div className="mt-6">
        <Card title="Choices" padded={false}>
          {g.modifiers.length === 0 ? (
            <p className="px-5 py-6 text-sm text-ink-2">No choices yet.</p>
          ) : (
            <ul className="divide-y divide-line">
              {g.modifiers.map((m) => (
                <li key={m.id} className="px-5 py-4">
                  <div className="mb-2 flex items-center justify-between gap-2">
                    <p className="text-sm font-medium text-ink">
                      {m.name} <span className="text-xs font-normal text-ink-3">{m.priceDeltaCents ? money(m.priceDeltaCents) : 'no charge'}</span>
                    </p>
                    <ConfirmAction trigger="Remove" title={`Remove ${m.name}?`} action={deleteModifier} hidden={{ modifierId: m.id, groupId: g.id }} confirmLabel="Remove choice" triggerVariant="ghost">
                      Guests stop being offered {m.name}. To take it off for today only, 86 it on the menu page.
                    </ConfirmAction>
                  </div>
                  <ActionForm action={updateModifier}>
                    <input type="hidden" name="modifierId" value={m.id} />
                    <input type="hidden" name="groupId" value={g.id} />
                    <ModifierFields m={m} />
                    <div className="mt-3 flex justify-end">
                      <SubmitButton size="sm" variant="secondary">
                        Save
                      </SubmitButton>
                    </div>
                  </ActionForm>
                </li>
              ))}
            </ul>
          )}
        </Card>
      </div>
    </>
  );
}
