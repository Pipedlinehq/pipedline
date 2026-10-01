import Image from 'next/image';
import Link from 'next/link';
import type { menu } from '@ros/modules';
import type { TableContext } from '@/lib/site-table';
import { AutoSubmit } from './client-bits';
import { cx, dietLabel, money } from './format';

type PublicMenu = menu.PublicMenu;
type Item = menu.PublicMenuItem;

/** Allergens are a safety surface: always shown in words, never truncated, never behind a tap. */
export function Allergens({ allergens }: { allergens: string[] }) {
  return (
    <p className="text-sm">
      <span className="font-semibold">Allergens:</span> {allergens.length ? allergens.join(', ') : 'none listed. Ask us if you have an allergy.'}
    </p>
  );
}

export function DietTags({ tags }: { tags: string[] }) {
  if (!tags.length) return null;
  return (
    <ul className="flex flex-wrap gap-1.5" aria-label="Dietary">
      {tags.map((t) => (
        <li key={t} className="s-pill">
          {dietLabel(t)}
        </li>
      ))}
    </ul>
  );
}

export function SoldOut() {
  return (
    <span className="s-pill font-semibold" style={{ borderColor: 'var(--brand-color-text)' }}>
      Sold out
    </span>
  );
}

function spice(level: number | null): string | null {
  if (!level || level <= 0) return null;
  return level >= 3 ? 'Hot' : level === 2 ? 'Medium spicy' : 'Mild spice';
}

export function MenuItemRow({ item, currency, showPrices, table }: { item: Item; currency: string; showPrices: boolean; table: TableContext | null }) {
  const spicy = spice(item.spiceLevel);
  const barOnly = table?.excludeAlcohol && item.isAlcohol;
  return (
    <li className="flex gap-4 border-b s-rule py-4 last:border-b-0" data-item={item.id} data-available={item.isAvailable ? 'yes' : 'no'}>
      {item.imageUrl ? (
        <div className="w-24 shrink-0 sm:w-28">
          <Image src={item.imageUrl} alt={item.name} width={224} height={168} unoptimized className="s-img" />
        </div>
      ) : null}
      <div className="min-w-0 flex-1 space-y-1.5">
        <div className="flex flex-wrap items-baseline justify-between gap-x-4 gap-y-1">
          <h4 className={cx('font-semibold text-[1.05em]', !item.isAvailable && 'line-through decoration-2')}>{item.name}</h4>
          {showPrices ? <span className="s-tabular font-semibold">{money(item.priceCents, currency)}</span> : null}
        </div>
        {!item.isAvailable ? (
          <p>
            <SoldOut /> <span className="text-sm">Not available right now.</span>
          </p>
        ) : null}
        {item.description ? <p className="s-muted">{item.description}</p> : null}
        <DietTags tags={item.dietaryTags} />
        <Allergens allergens={item.allergens} />
        {spicy || item.calories ? (
          <p className="text-sm">
            {[spicy, item.calories ? `${item.calories} kcal` : null].filter(Boolean).join(' · ')}
          </p>
        ) : null}
        {barOnly ? <p className="text-sm font-semibold">Order this from our staff.</p> : null}
      </div>
    </li>
  );
}

function matches(item: Item, diet: string[]): boolean {
  return diet.every((d) => item.dietaryTags.map((t) => t.toLowerCase()).includes(d));
}

export function dietOptions(m: PublicMenu): string[] {
  const set = new Set<string>();
  for (const mm of m.menus) for (const s of mm.sections) for (const i of s.items) for (const t of i.dietaryTags) set.add(t.toLowerCase());
  return [...set].sort((a, b) => dietLabel(a).localeCompare(dietLabel(b)));
}

const sectionAnchor = (id: string) => `section-${id.slice(0, 8)}`;

/**
 * The full live menu: every menu being served now, its sections and items, with dietary
 * filters that are a plain GET form (they work with JavaScript off).
 */
export function FullMenu({
  data,
  diet,
  action,
  showPrices,
  table,
  headingLevel = 3,
}: {
  data: PublicMenu;
  diet: string[];
  /** The path the filter form submits to. */
  action: string;
  showPrices: boolean;
  table: TableContext | null;
  headingLevel?: 2 | 3;
}) {
  const options = dietOptions(data);
  const active = diet.filter((d) => options.includes(d));
  const total = data.menus.reduce((s, m) => s + m.sections.reduce((a, sec) => a + sec.items.length, 0), 0);
  const shown = data.menus.reduce((s, m) => s + m.sections.reduce((a, sec) => a + sec.items.filter((i) => matches(i, active)).length, 0), 0);
  const MenuHeading = headingLevel === 2 ? 'h2' : 'h3';
  if (!data.menus.length) {
    return (
      <p className="s-notice">
        The kitchen is not serving right now, so there is no menu to show. Check our hours and come back then.
      </p>
    );
  }
  const formId = `diet-${data.venueId.slice(0, 8)}`;
  return (
    <div className="space-y-8">
      {options.length ? (
        <form id={formId} method="get" action={action} className="space-y-3" role="search" aria-label="Filter the menu">
          <fieldset>
            <legend className="mb-2 font-semibold">Show only dishes that are</legend>
            <div className="flex flex-wrap gap-2">
              {options.map((o) => (
                <label key={o} className="s-pill cursor-pointer gap-2 py-1.5 text-sm has-[:checked]:font-semibold" style={{ minHeight: '2.5rem' }}>
                  <input type="checkbox" name="diet" value={o} defaultChecked={active.includes(o)} className="s-check mt-0" />
                  {dietLabel(o)}
                </label>
              ))}
            </div>
          </fieldset>
          <div className="flex flex-wrap items-center gap-3">
            <button type="submit" className="s-btn-outline" data-autosubmit-hide>
              Apply filters
            </button>
            <p className="text-sm" role="status">
              {active.length ? `Showing ${shown} of ${total} dishes.` : `${total} dishes.`}{' '}
              {active.length ? (
                <Link href={action} className="s-link">
                  Clear filters
                </Link>
              ) : null}
            </p>
          </div>
          <AutoSubmit formId={formId} />
        </form>
      ) : null}
      <p className="text-sm">Allergens are listed on every dish. Our kitchen handles common allergens; tell us about any allergy when you order.</p>
      {data.menus.map((m) => (
        <section key={m.id} aria-labelledby={`menu-${m.id}`} className="space-y-6">
          {data.menus.length > 1 ? (
            <MenuHeading id={`menu-${m.id}`} className="s-heading">
              {m.name}
            </MenuHeading>
          ) : (
            <MenuHeading id={`menu-${m.id}`} className="sr-only">
              {m.name}
            </MenuHeading>
          )}
          <nav aria-label={`${m.name} sections`} className="flex flex-wrap gap-2">
            {m.sections.map((s) => (
              <a key={s.id} href={`#${sectionAnchor(s.id)}`} className="s-pill no-underline hover:underline">
                {s.name}
              </a>
            ))}
          </nav>
          {m.sections.map((s) => {
            const items = s.items.filter((i) => matches(i, active));
            return (
              <section key={s.id} id={sectionAnchor(s.id)} aria-labelledby={`${sectionAnchor(s.id)}-h`} className="scroll-mt-24">
                <h3 id={`${sectionAnchor(s.id)}-h`} className="s-heading border-b-2 pb-2" style={{ borderColor: 'var(--brand-color-text)' }}>
                  {s.name}
                </h3>
                {s.description ? <p className="s-muted mt-2">{s.description}</p> : null}
                {items.length ? (
                  <ul>
                    {items.map((i) => (
                      <MenuItemRow key={i.id} item={i} currency={data.currency} showPrices={showPrices} table={table} />
                    ))}
                  </ul>
                ) : (
                  <p className="py-4 text-sm">Nothing in this section matches those filters.</p>
                )}
              </section>
            );
          })}
        </section>
      ))}
      {data.taxInclusive && showPrices ? <p className="text-sm">Prices include GST.</p> : null}
    </div>
  );
}

/** A few dishes as cards, for a home page. Sold-out dishes are left out of highlights. */
export function MenuHighlights({ data, limit, showPrices, moreHref }: { data: PublicMenu; limit: number; showPrices: boolean; moreHref: string }) {
  const items = data.menus.flatMap((m) => m.sections.flatMap((s) => s.items)).filter((i) => i.isAvailable).slice(0, limit);
  if (!items.length) return <p>The kitchen is not serving right now.</p>;
  return (
    <div className="space-y-6">
      <ul className="grid gap-4 sm:grid-cols-2">
        {items.map((i) => (
          <li key={i.id} className="s-card flex flex-col gap-2 p-5" data-highlight={i.name}>
            {i.imageUrl ? <Image src={i.imageUrl} alt={i.name} width={480} height={360} unoptimized className="s-img mb-2" /> : null}
            <div className="flex items-baseline justify-between gap-3">
              <h3 className="text-[1.05em] font-semibold" style={{ fontFamily: 'var(--brand-font-body)', letterSpacing: 0 }}>
                {i.name}
              </h3>
              {showPrices ? <span className="s-tabular font-semibold">{money(i.priceCents, data.currency)}</span> : null}
            </div>
            {i.description ? <p className="s-muted text-sm">{i.description}</p> : null}
            <DietTags tags={i.dietaryTags} />
            <Allergens allergens={i.allergens} />
          </li>
        ))}
      </ul>
      <Link href={moreHref} className="s-btn-outline">
        See the full menu
      </Link>
    </div>
  );
}
