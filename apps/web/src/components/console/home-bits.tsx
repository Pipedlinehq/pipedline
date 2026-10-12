import Link from 'next/link';
import type { hub } from '@ros/modules';
import type { FormState } from '@/ui/client';
import { Badge, Card, EmptyState } from '@/ui';
import { ConfirmAction, InlineAction } from './confirm';

/**
 * Home's own pieces (docs/CONSOLE_IA.md section 9, pattern 8): the needs-attention strip whose
 * counts deep-link to the filtered view with the same rows, guidance cards a person can put away,
 * and the suggestions block with Approve (the tool's own commit, once) and Dismiss with a reason.
 */
export function AttentionStrip({ n }: { n: hub.NeedsAttention }) {
  return (
    <div className="rounded-card border border-line bg-surface p-4" data-testid="home-attention">
      <p className="text-sm text-ink-2">Needs attention</p>
      {n.open.length ? (
        <ul className="mt-1.5 flex flex-wrap gap-x-3 gap-y-1 text-sm" data-testid="attention-items">
          {n.open.map((i) => (
            <li key={i.key}>
              <Link href={i.href} className="font-medium text-accent hover:underline" data-testid={`attention-${i.key}`} data-count={i.count}>
                {i.label}
              </Link>
            </li>
          ))}
        </ul>
      ) : (
        <p className="mt-1 font-display text-[1.75rem] font-medium text-ink" data-testid="attention-nothing">
          Nothing
        </p>
      )}
    </div>
  );
}

export function GuidanceCards({ cards, dismiss }: { cards: hub.HomeCard[]; dismiss: (prev: FormState, fd: FormData) => Promise<FormState> }) {
  if (!cards.length) return null;
  return (
    <section aria-labelledby="guides-heading" data-testid="home-cards">
      <h2 id="guides-heading" className="mb-3 text-lg font-semibold text-ink">
        Getting more from Pipedline
      </h2>
      <div className="grid grid-cols-1 gap-3 md:grid-cols-2 xl:grid-cols-4">
        {cards.map((card) => (
          <div key={card.key} className="flex flex-col rounded-card border border-line bg-surface p-4" data-testid={`home-card-${card.key}`}>
            <p className="font-medium text-ink">{card.title}</p>
            <p className="mt-1 flex-1 text-sm text-ink-2">{card.body}</p>
            <div className="mt-3 flex items-center justify-between gap-2">
              <Link href={card.href} className="text-sm font-medium text-accent hover:underline">
                {card.cta}
              </Link>
              <InlineAction action={dismiss} hidden={{ card: card.key }} label="Put away" pendingLabel="…" testId={`dismiss-card-${card.key}`} />
            </div>
          </div>
        ))}
      </div>
    </section>
  );
}

export function Suggestions({ items, approve, dismiss }: { items: hub.Suggestion[]; approve: (prev: FormState, fd: FormData) => Promise<FormState>; dismiss: (prev: FormState, fd: FormData) => Promise<FormState> }) {
  return (
    <section aria-labelledby="suggestions-heading" data-testid="home-suggestions">
      <div className="mb-3 flex flex-wrap items-end justify-between gap-2">
        <h2 id="suggestions-heading" className="text-lg font-semibold text-ink">
          Suggestions
        </h2>
        <p className="text-xs text-ink-3">Worked out from your records: nothing here is a model's opinion, and nothing happens without your yes.</p>
      </div>
      {items.length === 0 ? (
        <EmptyState title="Nothing to suggest right now">When an order is left waiting, a service stops, or something in the weekly digest moves beyond normal variation, it appears here.</EmptyState>
      ) : (
        <Card padded={false}>
          <ul className="divide-y divide-line">
            {items.map((s) => (
              <li key={s.key} className="flex flex-wrap items-start justify-between gap-3 px-5 py-4" data-testid={`suggestion-${s.key}`}>
                <div className="min-w-0 flex-1 basis-72">
                  <p className="flex flex-wrap items-center gap-2">
                    <span className="font-medium text-ink">{s.title}</span>
                    <Badge tone={s.source === 'ops' ? 'warn' : 'accent'}>{s.source === 'ops' ? 'Right now' : 'Last week'}</Badge>
                  </p>
                  <p className="mt-0.5 text-sm text-ink-2">{s.body}</p>
                  <Link href={s.href} className="mt-1 inline-block text-xs text-accent hover:underline">
                    See the detail
                  </Link>
                </div>
                <div className="flex flex-wrap gap-2">
                  {s.action ? (
                    <ConfirmAction trigger={s.action.verb} triggerVariant="primary" title={`${s.title}?`} action={approve} hidden={{ key: s.key }} confirmLabel={s.action.verb} variant="primary" pendingLabel="Doing it…" testId={`approve-${s.key}`}>
                      <p>This runs the same step your assistant would, once, after this yes:</p>
                      <p className="mt-2 rounded-md bg-sunken px-3 py-2 text-ink">{s.body}</p>
                    </ConfirmAction>
                  ) : null}
                  <ConfirmAction trigger="Not now" title="Put this suggestion away?" action={dismiss} hidden={{ key: s.key }} reason={{ label: 'Why? (optional, for the record)', required: false, minLength: 0 }} confirmLabel="Put it away" variant="primary" testId={`dismiss-${s.key}`}>
                    It will not be shown again at this venue. Nothing else changes.
                  </ConfirmAction>
                </div>
              </li>
            ))}
          </ul>
        </Card>
      )}
    </section>
  );
}
