import Link from 'next/link';
import { atLeast, getConsole } from '@/lib/console';
import { read } from '@/lib/console-read';
import { menu } from '@ros/modules';
import { ActionForm, Badge, Card, Dialog, EmptyState, LinkButton, PageHeader, SubmitButton, Table, Td, Th, dateTime, money } from '@/ui';
import { ConfirmAction, InlineAction } from '@/components/console/confirm';
import { EightySix } from '@/components/console/eighty-six';
import { GroupFields, ItemFields, MenuFields, SectionFields } from '@/components/console/menu-fields';
import { ReadError } from '@/components/console/states';
import { createGroup, createItem, createMenu, createSection, deleteMenu, deleteSection, setAvailability, setModifierAvailability, updateMenu, updateSection } from './actions';

export const metadata = { title: 'Menu · Pipedline' };

const DAY = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];

function servedWhen(m: { availableDays: number[]; availableFrom: string | null; availableTo: string | null }): string {
  const days = m.availableDays.length === 7 ? 'Every day' : [1, 2, 3, 4, 5, 6, 0].filter((d) => m.availableDays.includes(d)).map((d) => DAY[d]).join(', ');
  const hours = m.availableFrom && m.availableTo ? `${m.availableFrom.slice(0, 5)}–${m.availableTo.slice(0, 5)}` : 'all day';
  return `${days}, ${hours}`;
}

export default async function MenuPage({ searchParams }: { searchParams: Promise<{ q?: string; show?: string }> }) {
  const { q = '', show } = await searchParams;
  const c = await getConsole();
  const canEdit = atLeast(c.role, 'manager');
  // Kitchen, front of house and managers may 86; a read-only role only looks.
  const can86 = c.role !== 'read_only';
  const r = await read((ctx) => menu.getMenuEditor(ctx, c.venue.id).then((v) => ({ v, now: ctx.now() })));
  if (!r.ok) {
    return (
      <>
        <PageHeader title="Menu" />
        <ReadError message={r.error} />
      </>
    );
  }
  const { v, now } = r.data;
  const needle = q.trim().toLowerCase();
  const offOnly = show === '86';
  const isOff = (i: { isAvailable: boolean; unavailableUntil: Date | null }) => !i.isAvailable && !(i.unavailableUntil && i.unavailableUntil <= now);
  const allItems = v.menus.flatMap((m) => m.sections.flatMap((s) => s.items));
  const offCount = allItems.filter(isOff).length;
  const keep = (i: { name: string; isAvailable: boolean; unavailableUntil: Date | null }) => (!needle || i.name.toLowerCase().includes(needle)) && (!offOnly || isOff(i));
  const groupName = new Map(v.modifierGroups.map((g) => [g.id, g.name]));

  return (
    <>
      <PageHeader
        title="Menu"
        description={
          can86
            ? '86 an item and it comes off the website, the QR menu and online ordering at once. Put it back the same way.'
            : 'The menu as guests see it, with what is off right now.'
        }
        actions={
          canEdit ? (
            <>
              <LinkButton href="/console/menu/import">Import a menu</LinkButton>
              <Dialog trigger="New menu" title="New menu" triggerVariant="primary">
              <ActionForm action={createMenu} resetOnSuccess>
                <MenuFields />
                <div className="mt-4 flex justify-end">
                  <SubmitButton>Create menu</SubmitButton>
                </div>
              </ActionForm>
            </Dialog>
            </>
          ) : null
        }
      />

      <form method="get" role="search" className="mb-6 flex flex-wrap items-end gap-3 rounded-lg border border-line bg-surface px-4 py-3">
        <label className="flex flex-col gap-1 text-xs font-medium text-ink-2">
          Find an item
          <input name="q" defaultValue={q} className="h-9 w-64 max-w-full rounded-md border border-line-strong bg-surface px-2 text-sm text-ink" />
        </label>
        <label className="flex items-center gap-2 pb-2 text-sm text-ink">
          <input type="checkbox" name="show" value="86" defaultChecked={offOnly} className="size-4 accent-ink" />
          Only what is off ({offCount})
        </label>
        <button type="submit" className="h-9 rounded-md border border-line-strong bg-surface px-3 text-sm font-medium text-ink hover:bg-sunken">
          Show
        </button>
      </form>

      {v.menus.length === 0 ? (
        <EmptyState title="No menu yet">{canEdit ? 'Create a menu, add sections, then add items to them.' : 'A manager has not set up a menu for this venue yet.'}</EmptyState>
      ) : (
        <div className="space-y-6">
          {v.menus.map((m) => (
            <Card
              key={m.id}
              title={m.name}
              description={`${servedWhen(m)}${m.isActive ? '' : ' · not active'}`}
              padded={false}
              actions={
                canEdit ? (
                  <>
                    <Dialog trigger="Add section" title={`Add a section to ${m.name}`}>
                      <ActionForm action={createSection} resetOnSuccess>
                        <input type="hidden" name="menuId" value={m.id} />
                        <SectionFields />
                        <div className="mt-4 flex justify-end">
                          <SubmitButton>Add section</SubmitButton>
                        </div>
                      </ActionForm>
                    </Dialog>
                    <Dialog trigger="Edit" title={`Edit ${m.name}`} triggerVariant="ghost">
                      <ActionForm action={updateMenu}>
                        <input type="hidden" name="menuId" value={m.id} />
                        <MenuFields m={m} />
                        <div className="mt-4 flex justify-end">
                          <SubmitButton>Save</SubmitButton>
                        </div>
                      </ActionForm>
                    </Dialog>
                    <ConfirmAction trigger="Remove" title={`Remove ${m.name}?`} action={deleteMenu} hidden={{ menuId: m.id }} confirmLabel="Remove menu" triggerVariant="ghost">
                      {m.name} and every section and item in it come off the website, the QR menu and ordering. Past orders keep their record of what was sold.
                    </ConfirmAction>
                  </>
                ) : m.isActive ? null : (
                  <Badge>Not active</Badge>
                )
              }
            >
              {m.sections.length === 0 ? (
                <p className="px-5 py-6 text-sm text-ink-2">No sections in this menu yet.</p>
              ) : (
                m.sections.map((s) => {
                  const items = s.items.filter(keep);
                  if ((needle || offOnly) && items.length === 0) return null;
                  return (
                    <section key={s.id} className="border-t border-line first:border-t-0" aria-labelledby={`sec-${s.id}`}>
                      <div className="flex flex-wrap items-center justify-between gap-2 px-5 pb-1 pt-4">
                        <h3 id={`sec-${s.id}`} className="text-sm font-semibold text-ink">
                          {s.name} {s.isVisible ? null : <Badge>Hidden</Badge>}
                        </h3>
                        {canEdit ? (
                          <div className="flex flex-wrap gap-2">
                            <Dialog trigger="Add item" title={`Add an item to ${s.name}`}>
                              <ActionForm action={createItem} resetOnSuccess>
                                <input type="hidden" name="sectionId" value={s.id} />
                                <ItemFields />
                                <div className="mt-4 flex justify-end">
                                  <SubmitButton>Add item</SubmitButton>
                                </div>
                              </ActionForm>
                            </Dialog>
                            <Dialog trigger="Edit section" title={`Edit ${s.name}`} triggerVariant="ghost">
                              <ActionForm action={updateSection}>
                                <input type="hidden" name="sectionId" value={s.id} />
                                <SectionFields s={s} />
                                <div className="mt-4 flex justify-end">
                                  <SubmitButton>Save</SubmitButton>
                                </div>
                              </ActionForm>
                            </Dialog>
                            <ConfirmAction trigger="Remove" title={`Remove ${s.name}?`} action={deleteSection} hidden={{ sectionId: s.id }} confirmLabel="Remove section" triggerVariant="ghost">
                              {s.name} and its {s.items.length} {s.items.length === 1 ? 'item' : 'items'} come off every menu guests can see.
                            </ConfirmAction>
                          </div>
                        ) : null}
                      </div>
                      {items.length === 0 ? (
                        <p className="px-5 pb-4 text-sm text-ink-3">No items in this section.</p>
                      ) : (
                        <Table>
                          <thead>
                            <tr>
                              <Th>Item</Th>
                              <Th align="right">Price</Th>
                              <Th>Status</Th>
                              <Th align="right">
                                <span className="sr-only">Actions</span>
                              </Th>
                            </tr>
                          </thead>
                          <tbody>
                            {items.map((i) => {
                              const off = isOff(i);
                              return (
                                <tr key={i.id} data-testid={`item-row-${i.id}`}>
                                  <Td>
                                    {canEdit ? (
                                      <Link href={`/console/menu/items/${i.id}`} className="font-medium text-ink underline-offset-2 hover:underline">
                                        {i.name}
                                      </Link>
                                    ) : (
                                      <span className="font-medium">{i.name}</span>
                                    )}
                                    <span className="mt-0.5 block text-xs text-ink-3">
                                      {[
                                        i.allergens.length ? `Allergens: ${i.allergens.join(', ')}` : null,
                                        i.dietaryTags.length ? i.dietaryTags.join(', ') : null,
                                        i.modifierGroupIds.length ? `Choices: ${i.modifierGroupIds.map((g) => groupName.get(g) ?? '').filter(Boolean).join(', ')}` : null,
                                        !i.isVisibleOnline ? 'not shown online' : null,
                                      ]
                                        .filter(Boolean)
                                        .join(' · ')}
                                    </span>
                                  </Td>
                                  <Td numeric>{money(i.priceCents)}</Td>
                                  <Td>
                                    {off ? (
                                      <span className="flex flex-col items-start gap-0.5">
                                        <Badge tone="bad">86&apos;d</Badge>
                                        <span className="text-xs text-ink-3">{i.unavailableUntil ? `back ${dateTime(i.unavailableUntil, c.venue.timezone, { date: false })}` : 'until put back'}</span>
                                      </span>
                                    ) : (
                                      <Badge tone="good">Available</Badge>
                                    )}
                                  </Td>
                                  <Td align="right">{can86 ? <EightySix action={setAvailability} itemId={i.id} name={i.name} available={!off} /> : null}</Td>
                                </tr>
                              );
                            })}
                          </tbody>
                        </Table>
                      )}
                    </section>
                  );
                })
              )}
            </Card>
          ))}
        </div>
      )}

      <div className="mt-8">
        <Card
          title="Choices"
          description="Modifier groups offered with items: cooking temperature, sides, milk. Take one choice off without taking off the dish."
          padded={false}
          actions={
            canEdit ? (
              <Dialog trigger="New group" title="New group of choices">
                <ActionForm action={createGroup} resetOnSuccess>
                  <GroupFields />
                  <div className="mt-4 flex justify-end">
                    <SubmitButton>Create group</SubmitButton>
                  </div>
                </ActionForm>
              </Dialog>
            ) : null
          }
        >
          {v.modifierGroups.length === 0 ? (
            <p className="px-5 py-6 text-sm text-ink-2">No groups of choices yet.</p>
          ) : (
            <ul className="divide-y divide-line">
              {v.modifierGroups.map((g) => (
                <li key={g.id} className="px-5 py-4">
                  <div className="flex flex-wrap items-baseline justify-between gap-2">
                    <p className="text-sm font-semibold text-ink">
                      {canEdit ? (
                        <Link href={`/console/menu/groups/${g.id}`} className="underline-offset-2 hover:underline">
                          {g.name}
                        </Link>
                      ) : (
                        g.name
                      )}
                    </p>
                    <p className="text-xs text-ink-3">
                      {g.selectionType === 'single' ? 'Pick one' : `Pick ${g.minSelections}–${g.maxSelections}`}
                      {g.isRequired ? ' · required' : ' · optional'}
                    </p>
                  </div>
                  {g.modifiers.length ? (
                    <ul className="mt-2 flex flex-wrap gap-2">
                      {g.modifiers.map((mod) => (
                        <li key={mod.id} className="flex items-center gap-2 rounded-md border border-line px-2 py-1 text-sm">
                          <span className={mod.isAvailable ? 'text-ink' : 'text-ink-3 line-through'}>{mod.name}</span>
                          {mod.priceDeltaCents ? <span className="text-xs text-ink-3">{mod.priceDeltaCents > 0 ? '+' : ''}{money(mod.priceDeltaCents)}</span> : null}
                          {can86 ? (
                            <InlineAction
                              action={setModifierAvailability}
                              hidden={{ modifierId: mod.id, available: mod.isAvailable ? 'false' : 'true' }}
                              label={mod.isAvailable ? '86' : 'Bring back'}
                              pendingLabel="…"
                              variant={mod.isAvailable ? 'secondary' : 'primary'}
                            />
                          ) : mod.isAvailable ? null : (
                            <Badge tone="bad">Off</Badge>
                          )}
                        </li>
                      ))}
                    </ul>
                  ) : (
                    <p className="mt-1 text-sm text-ink-3">No choices in this group yet.</p>
                  )}
                </li>
              ))}
            </ul>
          )}
        </Card>
      </div>
    </>
  );
}
