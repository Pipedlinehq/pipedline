import { onboarding } from '@ros/modules';
import { atLeast, getConsole } from '@/lib/console';
import { read } from '@/lib/console-read';
import { ConfirmAction } from '@/components/console/confirm';
import { NotHere } from '@/components/console/not-here';
import { ReadError } from '@/components/console/states';
import { AutoRefresh } from '@/components/platform/auto-refresh';
import { ActionForm, Badge, Card, Checkbox, EmptyState, Field, FormMessage, Input, LinkButton, PageHeader, SubmitButton, Textarea, money } from '@/ui';
import { confirmImportItem, discardImport, discardImportItem, saveImportItem } from '../actions';

export const metadata = { title: 'Review an imported menu · Restaurant OS' };

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * The review screen. Every proposed item is shown with what the model read; a manager corrects
 * it, checks the allergens against the kitchen's own list, and adds it, or leaves it out. Text
 * here came from a pasted document or someone else's web page: it is rendered as text only.
 */
export default async function MenuImportReviewPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  if (!UUID.test(id)) return <NotHere back="/console/menu/import" label="Back to imports" />;
  const c = await getConsole();
  const r = await read((ctx) => onboarding.getMenuImport(ctx, id));
  if (!r.ok) {
    if (r.code === 'not_found') return <NotHere back="/console/menu/import" label="Back to imports" />;
    return (
      <>
        <PageHeader title="Imported menu" />
        <ReadError message={r.error} />
      </>
    );
  }
  const imp = r.data;
  // An import at another of the person's venues is still theirs to see; only its own venue's manager decides.
  const manager = atLeast(c.session.principal.venueRoles[imp.venueId] ?? 'read_only', 'manager');
  const venueName = c.venues.find((v) => v.id === imp.venueId)?.name ?? c.venue.name;
  const currency = c.org.currency;
  const open = imp.status === 'extracted';
  const sections = [...new Set(imp.items.map((i) => i.sectionName))];
  const waiting = imp.items.filter((i) => i.status === 'proposed');

  return (
    <>
      <PageHeader
        title="Imported menu"
        description={
          imp.status === 'extracting'
            ? 'The menu is being read. This takes a moment; the page updates by itself.'
            : imp.status === 'failed'
              ? 'The menu could not be read.'
              : `${imp.counts.proposed} waiting for you, ${imp.counts.confirmed} added to ${venueName}’s menu, ${imp.counts.discarded} left out. From ${imp.source.kind === 'url' ? imp.source.url : 'pasted text'}.`
        }
        actions={
          <>
            <LinkButton href="/console/menu/import">All imports</LinkButton>
            {manager && open && waiting.length ? (
              <ConfirmAction trigger="Leave the rest out" title="Leave out every item still waiting?" action={discardImport} hidden={{ importId: imp.id }} confirmLabel="Leave them out" testId="discard-import">
                The {waiting.length} {waiting.length === 1 ? 'item' : 'items'} still waiting {waiting.length === 1 ? 'is' : 'are'} left out and this import is closed. Items you already added stay on the menu.
              </ConfirmAction>
            ) : null}
          </>
        }
      />
      <AutoRefresh active={imp.status === 'extracting'} everyMs={2000} label="Reading the menu…" />
      {imp.status === 'failed' ? (
        <EmptyState title="The menu could not be read" action={<LinkButton href="/console/menu/import">Try again</LinkButton>}>
          {imp.error ?? 'Try again, or paste the menu text instead of giving a page address.'}
        </EmptyState>
      ) : null}
      {imp.status !== 'extracting' && imp.status !== 'failed' && imp.items.length === 0 ? <EmptyState title="Nothing was found">No dishes were read from that source.</EmptyState> : null}
      <div className="space-y-8">
        {sections.map((section) => (
          <section key={section} aria-label={section || 'Items'}>
            <h2 className="mb-3 text-lg font-semibold text-ink">{section || 'Items'}</h2>
            <ul className="space-y-4">
              {imp.items
                .filter((i) => i.sectionName === section)
                .map((i) => (
                  <li key={i.key} data-testid={`import-item-${i.key}`} data-status={i.status}>
                    <Card
                      title={i.name}
                      description={
                        <span className="inline-flex flex-wrap items-center gap-2">
                          <span>{i.priceCents === null ? 'No price was found' : money(i.priceCents, currency)}</span>
                          {i.status === 'confirmed' ? <Badge tone="good">On the menu</Badge> : i.status === 'discarded' ? <Badge>Left out</Badge> : <Badge tone="warn">Waiting for you</Badge>}
                          {i.edited && i.status === 'proposed' ? <Badge tone="accent">Changed by a person</Badge> : null}
                        </span>
                      }
                    >
                      {i.status !== 'proposed' || !manager || !open ? (
                        <dl className="grid gap-x-6 gap-y-2 text-sm sm:grid-cols-2">
                          <div className="sm:col-span-2">
                            <dt className="text-xs text-ink-2">Description</dt>
                            <dd className="whitespace-pre-wrap break-words text-ink">{i.description ?? '–'}</dd>
                          </div>
                          <div>
                            <dt className="text-xs text-ink-2">Dietary</dt>
                            <dd className="text-ink">{i.dietaryTags.join(', ') || 'None stated'}</dd>
                          </div>
                          <div>
                            <dt className="text-xs text-ink-2">Allergens</dt>
                            <dd className="text-ink">{i.allergens.join(', ') || 'None stated'}</dd>
                          </div>
                        </dl>
                      ) : (
                        <div className="space-y-4">
                          <ActionForm action={saveImportItem} className="space-y-3">
                            <input type="hidden" name="importId" value={imp.id} />
                            <input type="hidden" name="itemKey" value={i.key} />
                            <div className="grid gap-3 sm:grid-cols-[minmax(0,1fr)_9rem]">
                              <Field label="Name">
                                <Input name="name" required maxLength={200} defaultValue={i.name} />
                              </Field>
                              <Field label="Price ($)">
                                <Input name="price" inputMode="decimal" defaultValue={i.priceCents === null ? '' : (i.priceCents / 100).toFixed(2)} />
                              </Field>
                            </div>
                            <Field label="Description">
                              <Textarea name="description" maxLength={2000} defaultValue={i.description ?? ''} className="min-h-16" />
                            </Field>
                            <div className="grid gap-3 sm:grid-cols-2">
                              <Field label="Dietary" hint="Separate with commas.">
                                <Input name="dietaryTags" defaultValue={i.dietaryTags.join(', ')} />
                              </Field>
                              <Field label="Allergens" hint="Separate with commas. Empty means none.">
                                <Input name="allergens" defaultValue={i.allergens.join(', ')} />
                              </Field>
                            </div>
                            <Checkbox name="allergensMine" label="The allergen list above is the kitchen’s own" hint="Tick when you have set or checked it yourself. Saving then records it as checked by a person." />
                            <SubmitButton size="sm" variant="secondary">
                              Save changes to “{i.name}”
                            </SubmitButton>
                          </ActionForm>
                          {i.modifiers.length ? (
                            <p className="text-xs text-ink-2">
                              Choices: {i.modifiers.map((m) => `${m.group} (${m.options.map((o) => o.name).join(', ')})`).join('; ')}. They are added with the item and can be changed in the menu editor.
                            </p>
                          ) : null}
                          {i.allergensUnverified ? (
                            <FormMessage tone="info">The allergens were read by a model and have not been checked by a person. Check them against the kitchen’s own list before adding this item.</FormMessage>
                          ) : null}
                          <div className="flex flex-wrap items-start gap-3 border-t border-line pt-4">
                            <ActionForm action={confirmImportItem} className="min-w-0 flex-1 basis-72 space-y-3">
                              <input type="hidden" name="importId" value={imp.id} />
                              <input type="hidden" name="itemKey" value={i.key} />
                              <input type="hidden" name="itemName" value={i.name} />
                              {i.allergensUnverified ? <Checkbox name="allergensChecked" label={`I have checked the allergens for “${i.name}” against the kitchen’s own list`} /> : null}
                              <SubmitButton size="sm" pendingLabel="Adding…">
                                Add “{i.name}” to the menu
                              </SubmitButton>
                            </ActionForm>
                            <ConfirmAction trigger={<>Leave out<span className="sr-only"> {i.name}</span></>} title={`Leave out “${i.name}”?`} action={discardImportItem} hidden={{ importId: imp.id, itemKey: i.key, itemName: i.name }} confirmLabel="Leave it out" triggerVariant="ghost">
                              It is not added to the menu. You can still add the dish by hand in the menu editor.
                            </ConfirmAction>
                          </div>
                        </div>
                      )}
                    </Card>
                  </li>
                ))}
            </ul>
          </section>
        ))}
      </div>
    </>
  );
}
