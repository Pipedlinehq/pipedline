import Link from 'next/link';
import { atLeast, getConsole } from '@/lib/console';
import { read } from '@/lib/console-read';
import { resolveView, type ViewSpec } from '@/lib/console-views';
import { events, menu } from '@ros/modules';
import { ActionForm, Badge, Card, Dialog, EmptyState, LinkButton, PageHeader, SubmitButton, Table, Td, Th, dateTime, money } from '@/ui';
import { BulkSelection, RowBox, SelectAllBox, type BulkActionDef } from '@/components/console/bulk';
import { ConfirmAction, InlineAction } from '@/components/console/confirm';
import { EightySix } from '@/components/console/eighty-six';
import { GroupFields, ItemFields, MenuFields, SectionFields } from '@/components/console/menu-fields';
import { ReadError } from '@/components/console/states';
import { IndexViews } from '@/components/console/views';
import { bulkAvailability, createGroup, createItem, createMenu, createSection, deleteMenu, deleteSection, setAvailability, setModifierAvailability, updateMenu, updateSection } from './actions';
import { deleteView, renameView, saveView } from '../views-actions';

export const metadata = { title: 'Menu · Pipedline' };

const DAY = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];

const SPEC: ViewSpec = {
  page: 'menu',
  path: '/console/menu',
  landing: 'all',
  defaults: [
    { key: 'all', label: 'All', filters: {} },
    { key: 'soldout', label: 'Sold out', filters: { availability: 'off' } },
    { key: 'hidden', label: 'Hidden online', filters: { visibility: 'hidden_online' } },
  ],
  fields: [
    { key: 'q', label: 'Item', kind: 'text', placeholder: 'Barramundi' },
    {
      key: 'availability',
      label: 'On the menu',
      kind: 'select',
      options: [
        { value: 'off', label: "86'd right now" },
        { value: 'on', label: 'Available' },
      ],
    },
    {
      key: 'visibility',
      label: 'Where it shows',
      kind: 'select',
      options: [
        { value: 'hidden_online', label: 'Hidden online (site and ordering)' },
        { value: 'online', label: 'Shown online' },
        { value: 'hidden_in_venue', label: 'Hidden on the QR menu' },
        { value: 'in_venue', label: 'Shown on the QR menu' },
      ],
    },
  ],
};

function servedWhen(m: { availableDays: number[]; availableFrom: string | null; availableTo: string | null }): string {
  const days = m.availableDays.length === 7 ? 'Every day' : [1, 2, 3, 4, 5, 6, 0].filter((d) => m.availableDays.includes(d)).map((d) => DAY[d]).join(', ');
  const hours = m.availableFrom && m.availableTo ? `${m.availableFrom.slice(0, 5)}–${m.availableTo.slice(0, 5)}` : 'all day';
  return `${days}, ${hours}`;
}

const BULK: BulkActionDef[] = [
  { key: 'off', verb: '86', title: '86 {n} {nouns}?', confirmLabel: '86 {nouns}', body: 'The {nouns} come off the website, the QR menu and online ordering at once, until the end of this service. Put {them} back the same way.' },
  { key: 'on', verb: 'Put back on the menu', title: 'Put {n} {nouns} back on the menu?', confirmLabel: 'Put {nouns} back', body: 'The {nouns} go back on everywhere {them} {is} shown.' },
];

/**
 * Menu (docs/CONSOLE_IA.md section 9, wave 1): the whole menu as the console edits it, with saved
 * views ("Sold out", "Hidden online", "All"), filters applied by the menu service, and 86 / put
 * back singly or in bulk.
 */
export default async function MenuPage({ searchParams }: { searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  const raw = await searchParams;
  const c = await getConsole();
  const canEdit = atLeast(c.role, 'manager');
  // Kitchen, front of house and managers may 86; a read-only role only looks.
  const can86 = c.role !== 'read_only';
  // The old search box's address (?q=, ?show=86) still means what it meant.
  const sp = raw.f !== '1' && (raw.q || raw.show === '86') ? { ...raw, f: '1', ...(raw.show === '86' ? { availability: 'off' } : {}) } : raw;
  const saved = await read((ctx) => events.listConsoleViews(ctx, { venueId: c.venue.id, page: 'menu' }));
  const resolved = resolveView(SPEC, sp, saved.ok ? saved.data : []);
  const f = resolved.filters;
  const filtering = Object.keys(f).length > 0;
  const r = await read((ctx) => menu.getMenuEditor(ctx, c.venue.id, { q: f.q || undefined, availability: (f.availability as 'off') || undefined, visibility: (f.visibility as 'hidden_online') || undefined }).then((v) => ({ v, now: ctx.now() })));
  if (!r.ok) {
    return (
      <>
        <PageHeader title="Menu" />
        <ReadError message={r.error} />
      </>
    );
  }
  const { v, now } = r.data;
  const isOff = (i: { isAvailable: boolean; unavailableUntil: Date | null }) => !i.isAvailable && !(i.unavailableUntil && i.unavailableUntil <= now);
  const allItems = v.menus.flatMap((m) => m.sections.flatMap((s) => s.items));
  const groupName = new Map(v.modifierGroups.map((g) => [g.id, g.name]));

  const body = (
    <>
      {v.menus.length === 0 ? (
        <EmptyState title="No menu yet">{canEdit ? 'Create a menu, add sections, then add items to them.' : 'A manager has not set up a menu for this venue yet.'}</EmptyState>
      ) : filtering && allItems.length === 0 ? (
        <EmptyState title="No items match this view">Try another view, or clear a filter.</EmptyState>
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
                  if (filtering && s.items.length === 0) return null;
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
                      {s.items.length === 0 ? (
                        <p className="px-5 pb-4 text-sm text-ink-3">No items in this section.</p>
                      ) : (
                        <Table label={`${s.name} items`}>
                          <thead>
                            <tr>
                              {can86 ? (
                                <Th className="w-8">
                                  <span className="sr-only">Select</span>
                                </Th>
                              ) : null}
                              <Th>Item</Th>
                              <Th align="right">Price</Th>
                              <Th>Status</Th>
                              <Th align="right">
                                <span className="sr-only">Actions</span>
                              </Th>
                            </tr>
                          </thead>
                          <tbody>
                            {s.items.map((i) => {
                              const off = isOff(i);
                              return (
                                <tr key={i.id} data-testid={`item-row-${i.id}`}>
                                  {can86 ? (
                                    <Td>
                                      <RowBox id={i.id} label={`Select ${i.name}`} name={i.name} />
                                    </Td>
                                  ) : null}
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
                                        !i.isVisibleInVenue ? 'not on the QR menu' : null,
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
    </>
  );

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

      {can86 ? (
        <BulkSelection noun={{ one: 'item', many: 'items' }} actions={BULK} action={bulkAvailability} testId="bulk-menu">
          <IndexViews page="menu" path="/console/menu" resolved={resolved} fields={SPEC.fields} canSave saveAction={saveView} renameAction={renameView} deleteAction={deleteView} aside={<Shown count={allItems.length} selectable />} />
          {body}
        </BulkSelection>
      ) : (
        <>
          <IndexViews page="menu" path="/console/menu" resolved={resolved} fields={SPEC.fields} canSave={false} saveAction={saveView} renameAction={renameView} deleteAction={deleteView} aside={<Shown count={allItems.length} />} />
          {body}
        </>
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
                          {mod.priceDeltaCents ? (
                            <span className="text-xs text-ink-3">
                              {mod.priceDeltaCents > 0 ? '+' : ''}
                              {money(mod.priceDeltaCents)}
                            </span>
                          ) : null}
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

/** The menu is several tables; one "select everything shown" lives in the filter row instead of a header cell. */
function Shown({ count, selectable = false }: { count: number; selectable?: boolean }) {
  return (
    <>
      {count} {count === 1 ? 'item' : 'items'}
      {selectable && count ? (
        <>
          {' · '}
          <label className="inline-flex items-center gap-1.5">
            <SelectAllBox label="Select every item shown" />
            select all shown
          </label>
        </>
      ) : null}
    </>
  );
}
