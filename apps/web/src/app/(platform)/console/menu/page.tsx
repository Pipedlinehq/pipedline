import Link from 'next/link';
import { zonedTimeToUtc } from '@ros/core';
import { atLeast, getConsole } from '@/lib/console';
import { read } from '@/lib/console-read';
import { resolveView, type ViewSpec } from '@/lib/console-views';
import { events, menu } from '@ros/modules';
import { ActionForm, Badge, Button, Card, Dialog, EmptyState, LinkButton, PageHeader, SubmitButton, Table, Td, Th, dateTime, money } from '@/ui';
import { BulkSelection, RowBox, SelectAllBox, type BulkActionDef } from '@/components/console/bulk';
import { ConfirmAction, InlineAction } from '@/components/console/confirm';
import { EightySix } from '@/components/console/eighty-six';
import { ChannelBoxes, GroupFields, ItemFields, MenuFields, SectionFields, localInput } from '@/components/console/menu-fields';
import { ReadError } from '@/components/console/states';
import { IndexViews } from '@/components/console/views';
import { bulkAvailability, createGroup, createItem, createMenu, createSection, deleteMenu, deleteSection, setAvailability, setModifierAvailability, updateMenu, updateSection, updateSettings } from './actions';
import { deleteView, renameView, saveView } from '../views-actions';

export const metadata = { title: 'Menu · Pipedline' };

const DAY = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];

/** "on:website" / "off:delivery": the one "where it shows" filter, both ways, for every channel. */
const WHERE_OPTIONS = menu.MENU_CHANNELS.flatMap((c) => [
  { value: `on:${c}`, label: `Shown on ${menu.MENU_CHANNEL_WORDS[c]}` },
  { value: `off:${c}`, label: `Hidden from ${menu.MENU_CHANNEL_WORDS[c]}` },
]);

const SPEC: ViewSpec = {
  page: 'menu',
  path: '/console/menu',
  landing: 'all',
  defaults: [
    { key: 'all', label: 'All', filters: {} },
    { key: 'soldout', label: 'Sold out', filters: { availability: 'off' } },
    { key: 'hidden', label: 'Hidden online', filters: { where: 'off:website' } },
    { key: 'scheduled', label: 'Scheduled', filters: { schedule: 'scheduled' } },
    { key: 'retired', label: 'Retired', filters: { schedule: 'retired' } },
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
    { key: 'where', label: 'Where it shows', kind: 'select', options: WHERE_OPTIONS },
    {
      key: 'schedule',
      label: 'Menu is',
      kind: 'select',
      options: [
        { value: 'live', label: 'Live' },
        { value: 'scheduled', label: 'Scheduled (not live yet)' },
        { value: 'retired', label: 'Retired' },
        { value: 'not_active', label: 'Not active' },
      ],
    },
  ],
};

/** The older "visibility" filter's values (saved views, old links) as the "where" filter says them. */
const LEGACY_WHERE: Record<string, string> = { hidden_online: 'off:website', online: 'on:website', hidden_in_venue: 'off:qr', in_venue: 'on:qr' };
function modernise<T extends Record<string, string | string[] | undefined>>(filters: T): T {
  const v = filters.visibility;
  const legacy = Array.isArray(v) ? v[0] : v;
  if (!legacy || !LEGACY_WHERE[legacy]) return filters;
  const { visibility: _visibility, ...rest } = filters;
  return { ...rest, where: rest.where ?? LEGACY_WHERE[legacy] } as unknown as T;
}

function servedWhen(m: { availableDays: number[]; availableFrom: string | null; availableTo: string | null }): string {
  const days = m.availableDays.length === 7 ? 'Every day' : [1, 2, 3, 4, 5, 6, 0].filter((d) => m.availableDays.includes(d)).map((d) => DAY[d]).join(', ');
  const hours = m.availableFrom && m.availableTo ? `${m.availableFrom.slice(0, 5)}–${m.availableTo.slice(0, 5)}` : 'all day';
  return `${days}, ${hours}`;
}

/** "Scheduled · goes live Sat 10 Oct 2026, 8:00 am", "Retired · since …", "Live · retires …". */
function ScheduleBadge({ schedule, liveFrom, liveUntil, tz }: { schedule: menu.ScheduleState; liveFrom: Date | null; liveUntil: Date | null; tz: string }) {
  if (schedule === 'not_active') return <Badge>Not active</Badge>;
  if (schedule === 'scheduled')
    return (
      <span className="inline-flex flex-wrap items-center gap-1.5">
        <Badge tone="accent">Scheduled</Badge>
        <span className="text-xs text-ink-3">goes live {dateTime(liveFrom, tz)}</span>
      </span>
    );
  if (schedule === 'retired')
    return (
      <span className="inline-flex flex-wrap items-center gap-1.5">
        <Badge tone="warn">Retired</Badge>
        <span className="text-xs text-ink-3">since {dateTime(liveUntil, tz)}</span>
      </span>
    );
  if (liveUntil)
    return (
      <span className="inline-flex flex-wrap items-center gap-1.5">
        <Badge tone="good">Live</Badge>
        <span className="text-xs text-ink-3">retires {dateTime(liveUntil, tz)}</span>
      </span>
    );
  return null;
}

const CHANNEL_CHOICE = { label: 'Where', options: menu.MENU_CHANNELS.map((c) => ({ value: c, label: menu.MENU_CHANNEL_WORDS[c] })) };

const BULK_86: BulkActionDef[] = [
  { key: 'off', verb: '86', title: '86 {n} {nouns}?', confirmLabel: '86 {nouns}', body: 'The {nouns} come off the website, the QR menu, online ordering and assistants at once, until the end of this service. Put {them} back the same way.' },
  { key: 'on', verb: 'Put back on the menu', title: 'Put {n} {nouns} back on the menu?', confirmLabel: 'Put {nouns} back', body: 'The {nouns} go back on everywhere {them} {is} shown.' },
];
const BULK_WHERE: BulkActionDef[] = [
  { key: 'show', verb: 'Show on…', title: 'Show {n} {nouns} on a channel?', confirmLabel: 'Show {nouns}', body: 'The {nouns} appear on the channel you pick. Where else {them} {is} shown does not change.', choice: CHANNEL_CHOICE },
  { key: 'hide', verb: 'Hide from…', title: 'Hide {n} {nouns} from a channel?', confirmLabel: 'Hide {nouns}', body: 'The {nouns} come off the channel you pick. Where else {them} {is} shown does not change.', choice: CHANNEL_CHOICE },
];

/**
 * Menu (docs/CONSOLE_IA.md section 9, waves 1 and 2): the whole menu as the console edits it, with
 * saved views ("Sold out", "Hidden online", "Scheduled", "Retired", "All"), filters applied by the
 * menu service, 86 / put back and show on / hide from singly or in bulk, and a preview of the
 * schedule states as of a date and time in the venue's own zone.
 */
export default async function MenuPage({ searchParams }: { searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  const raw = await searchParams;
  const c = await getConsole();
  const tz = c.venue.timezone;
  const canEdit = atLeast(c.role, 'manager');
  // Kitchen, front of house and managers may 86; a read-only role only looks.
  const can86 = c.role !== 'read_only';
  // The old search box's address (?q=, ?show=86) and the old "visibility" filter still mean what they meant.
  const sp = modernise(raw.f !== '1' && (raw.q || raw.show === '86') ? { ...raw, f: '1', ...(raw.show === '86' ? { availability: 'off' } : {}) } : raw);
  const saved = await read((ctx) => events.listConsoleViews(ctx, { venueId: c.venue.id, page: 'menu' }));
  const resolved = resolveView(SPEC, sp, saved.ok ? saved.data.map((v) => ({ ...v, filters: modernise(v.filters) })) : []);
  const f = resolved.filters;
  const filtering = Object.keys(f).length > 0;
  // "Preview as of": a venue-local date and time; states (scheduled, live, retired, 86'd) are worked out for then.
  const asOfRaw = typeof raw.asOf === 'string' && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}/.test(raw.asOf) ? raw.asOf.slice(0, 16) : null;
  const asOf = asOfRaw ? zonedTimeToUtc(asOfRaw.slice(0, 10), asOfRaw.slice(11), tz) : null;
  const [whereOn, whereChannel] = f.where ? (f.where.split(':') as [string, menu.MenuChannel]) : [null, null];
  const r = await read((ctx) =>
    menu
      .getMenuEditor(ctx, c.venue.id, {
        q: f.q || undefined,
        availability: (f.availability as 'off') || undefined,
        shownOn: whereOn === 'on' ? whereChannel! : undefined,
        hiddenFrom: whereOn === 'off' ? whereChannel! : undefined,
        schedule: (f.schedule as 'scheduled') || undefined,
        asOf: asOf ?? undefined,
      })
      .then((v) => ({ v, now: ctx.now() })),
  );
  if (!r.ok) {
    return (
      <>
        <PageHeader title="Menu" />
        <ReadError message={r.error} />
      </>
    );
  }
  const { v, now } = r.data;
  const at = asOf ?? now;
  const isOff = (i: { isAvailable: boolean; unavailableUntil: Date | null }) => !menu.itemAvailableAt({ is_available: i.isAvailable, unavailable_until: i.unavailableUntil }, at);
  const allItems = v.menus.flatMap((m) => m.sections.flatMap((s) => s.items));
  const groupName = new Map(v.modifierGroups.map((g) => [g.id, g.name]));
  const bulk = [...(can86 ? BULK_86 : []), ...(canEdit ? BULK_WHERE : [])];
  // Rows carry a checkbox only inside <BulkSelection>: never in a preview, where nothing can be changed.
  const selectable = bulk.length > 0 && !asOf;

  /** "Not on Delivery, QR menu" and "Delivery $21.00": the parts of an item's small print that come from this pass. */
  const whereWords = (i: (typeof allItems)[number]): string[] => {
    const hidden = menu.MENU_CHANNELS.filter((ch) => !i.shownOn.includes(ch));
    const prices = menu.MENU_CHANNELS.filter((ch) => i.channelPrices[ch] !== undefined).map((ch) => `${menu.MENU_CHANNEL_WORDS[ch]} ${money(i.channelPrices[ch]!)}`);
    return [hidden.length === menu.MENU_CHANNELS.length ? 'shown nowhere' : hidden.length ? `not on ${hidden.map((ch) => menu.MENU_CHANNEL_WORDS[ch]).join(', ')}` : null, ...prices].filter((x): x is string => Boolean(x));
  };

  const body = (
    <>
      {v.menus.length === 0 ? (
        <EmptyState title={filtering ? 'No menu matches this view' : 'No menu yet'}>{filtering ? 'Try another view, or clear a filter.' : canEdit ? 'Create a menu, add sections, then add items to them.' : 'A manager has not set up a menu for this venue yet.'}</EmptyState>
      ) : filtering && allItems.length === 0 && !f.schedule ? (
        <EmptyState title="No items match this view">Try another view, or clear a filter.</EmptyState>
      ) : (
        <div className="space-y-6">
          {v.menus.map((m) => (
            <Card
              key={m.id}
              title={m.name}
              description={
                <span className="inline-flex flex-wrap items-center gap-2" data-testid={`menu-state-${m.id}`} data-schedule={m.schedule}>
                  <span>{servedWhen(m)}</span>
                  <ScheduleBadge schedule={m.schedule} liveFrom={m.liveFrom} liveUntil={m.liveUntil} tz={tz} />
                </span>
              }
              padded={false}
              actions={
                canEdit ? (
                  <>
                    <Dialog trigger="Add section" title={`Add a section to ${m.name}`}>
                      <ActionForm action={createSection} resetOnSuccess>
                        <input type="hidden" name="menuId" value={m.id} />
                        <SectionFields timeZone={tz} venueDefault={v.settings.newItemsShownOn} />
                        <div className="mt-4 flex justify-end">
                          <SubmitButton>Add section</SubmitButton>
                        </div>
                      </ActionForm>
                    </Dialog>
                    <Dialog trigger="Edit" title={`Edit ${m.name}`} triggerVariant="ghost">
                      <ActionForm action={updateMenu}>
                        <input type="hidden" name="menuId" value={m.id} />
                        <MenuFields m={m} timeZone={tz} />
                        <div className="mt-4 flex justify-end">
                          <SubmitButton>Save</SubmitButton>
                        </div>
                      </ActionForm>
                    </Dialog>
                    <ConfirmAction trigger="Remove" title={`Remove ${m.name}?`} action={deleteMenu} hidden={{ menuId: m.id }} confirmLabel="Remove menu" triggerVariant="ghost">
                      {m.name} and every section and item in it come off the website, the QR menu and ordering. Past orders keep their record of what was sold.
                    </ConfirmAction>
                  </>
                ) : null
              }
            >
              {m.sections.length === 0 ? (
                <p className="px-5 py-6 text-sm text-ink-2">No sections in this menu yet.</p>
              ) : (
                m.sections.map((s) => {
                  if (filtering && s.items.length === 0 && !f.schedule) return null;
                  return (
                    <section key={s.id} className="border-t border-line first:border-t-0" aria-labelledby={`sec-${s.id}`} data-testid={`section-${s.id}`} data-schedule={s.schedule}>
                      <div className="flex flex-wrap items-center justify-between gap-2 px-5 pb-1 pt-4">
                        <h3 id={`sec-${s.id}`} className="flex flex-wrap items-center gap-2 text-sm font-semibold text-ink">
                          {s.name} {s.isVisible ? null : <Badge>Hidden</Badge>}
                          <ScheduleBadge schedule={s.schedule} liveFrom={s.liveFrom} liveUntil={s.liveUntil} tz={tz} />
                        </h3>
                        {canEdit ? (
                          <div className="flex flex-wrap gap-2">
                            <Dialog trigger="Add item" title={`Add an item to ${s.name}`}>
                              <ActionForm action={createItem} resetOnSuccess>
                                <input type="hidden" name="sectionId" value={s.id} />
                                <ItemFields defaultChannels={s.shownOn ?? v.settings.newItemsShownOn} />
                                <div className="mt-4 flex justify-end">
                                  <SubmitButton>Add item</SubmitButton>
                                </div>
                              </ActionForm>
                            </Dialog>
                            <Dialog trigger="Edit section" title={`Edit ${s.name}`} triggerVariant="ghost">
                              <ActionForm action={updateSection}>
                                <input type="hidden" name="sectionId" value={s.id} />
                                <SectionFields s={s} timeZone={tz} venueDefault={v.settings.newItemsShownOn} />
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
                              {selectable ? (
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
                                <tr key={i.id} data-testid={`item-row-${i.id}`} data-shown-on={i.shownOn.join(' ')}>
                                  {selectable ? (
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
                                    <span className="mt-0.5 block text-xs text-ink-3" data-testid={`item-where-${i.id}`}>
                                      {[
                                        i.allergens.length ? `Allergens: ${i.allergens.join(', ')}` : null,
                                        i.dietaryTags.length ? i.dietaryTags.join(', ') : null,
                                        i.modifierGroupIds.length ? `Choices: ${i.modifierGroupIds.map((g) => groupName.get(g) ?? '').filter(Boolean).join(', ')}` : null,
                                        ...whereWords(i),
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
                                        <span className="text-xs text-ink-3" data-testid={`item-back-${i.id}`}>
                                          {menu.backWords(i.unavailableUntil, at, tz)}
                                        </span>
                                      </span>
                                    ) : (
                                      <Badge tone="good">Available</Badge>
                                    )}
                                  </Td>
                                  <Td align="right">{can86 && !asOf ? <EightySix action={setAvailability} itemId={i.id} name={i.name} available={!off} /> : null}</Td>
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

  const asOfForm = (
    <form method="get" action="/console/menu" className="flex flex-wrap items-end gap-2" data-testid="as-of">
      {Object.entries(resolved.query ? Object.fromEntries(new URLSearchParams(resolved.query)) : {}).map(([k, val]) => (
        <input key={k} type="hidden" name={k} value={val} />
      ))}
      <label className="block">
        <span className="mb-1 block text-xs font-medium text-ink-2">Preview as of ({tz.replace(/_/g, ' ')})</span>
        <input name="asOf" type="datetime-local" defaultValue={asOf ? localInput(asOf, tz) : ''} className="h-8 rounded-md border border-line-strong bg-surface px-2 text-xs text-ink" />
      </label>
      <Button type="submit" variant="secondary" size="sm">
        Preview
      </Button>
      {asOf ? (
        <Link href={resolved.query ? `/console/menu?${resolved.query}` : '/console/menu'} className="text-xs text-accent underline-offset-2 hover:underline">
          Back to now
        </Link>
      ) : null}
    </form>
  );

  const asOfNote = asOf ? (
    <p className="mb-4 rounded-md border border-line bg-sunken px-3 py-2 text-sm text-ink-2" data-testid="as-of-note">
      Showing what is live, scheduled, retired and sold out as of <strong>{dateTime(asOf, tz)}</strong>. Nothing can be changed from this view.
    </p>
  ) : null;

  return (
    <>
      <PageHeader
        title="Menu"
        description={
          can86
            ? '86 an item and it comes off the website, the QR menu, online ordering and assistants at once; it comes back on its own at the time you pick. A menu can be scheduled to go live and to retire.'
            : 'The menu as guests see it, with what is off right now and what is scheduled.'
        }
        actions={
          canEdit ? (
            <>
              <Dialog trigger="Where new items show" title="Where new items show" triggerVariant="ghost">
                <ActionForm action={updateSettings}>
                  <ChannelBoxes checked={v.settings.newItemsShownOn} legend="A new item goes on" hint="Unless its section, or the item itself, says otherwise. Nothing already on the menu changes." />
                  <div className="mt-4 flex justify-end">
                    <SubmitButton>Save</SubmitButton>
                  </div>
                </ActionForm>
              </Dialog>
              <LinkButton href="/console/menu/import">Import a menu</LinkButton>
              <Dialog trigger="New menu" title="New menu" triggerVariant="primary">
                <ActionForm action={createMenu} resetOnSuccess>
                  <MenuFields timeZone={tz} />
                  <div className="mt-4 flex justify-end">
                    <SubmitButton>Create menu</SubmitButton>
                  </div>
                </ActionForm>
              </Dialog>
            </>
          ) : null
        }
      />

      {selectable ? (
        <BulkSelection noun={{ one: 'item', many: 'items' }} actions={bulk} action={bulkAvailability} testId="bulk-menu">
          <IndexViews page="menu" path="/console/menu" resolved={resolved} fields={SPEC.fields} canSave saveAction={saveView} renameAction={renameView} deleteAction={deleteView} aside={<Shown count={allItems.length} selectable />} />
          {asOfForm}
          <div className="mt-4">{asOfNote}</div>
          {body}
        </BulkSelection>
      ) : (
        <>
          <IndexViews page="menu" path="/console/menu" resolved={resolved} fields={SPEC.fields} canSave={canEdit} saveAction={saveView} renameAction={renameView} deleteAction={deleteView} aside={<Shown count={allItems.length} />} />
          {asOfForm}
          <div className="mt-4">{asOfNote}</div>
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
