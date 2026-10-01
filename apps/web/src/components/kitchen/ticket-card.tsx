'use client';

import { type ReactNode, useEffect, useRef, useState } from 'react';
import { CHANNEL_LABEL, type KTicket, type ScreenEvent, type Shown } from './logic';

/*
 * A card on a 1280-wide tablet is about 300px across. The label must fit inside its button at that
 * width (it used to run past the edge, and the Reject button beside it was cut off), so the type
 * steps down on narrow cards and the buttons may never be wider than their column.
 */
const btn = 'flex h-20 w-full min-w-0 items-center justify-center overflow-hidden rounded-xl px-1 text-lg font-black tracking-normal disabled:opacity-40 2xl:text-2xl 2xl:tracking-wide';

function Action({ label, event, ticket, onTap, tone }: { label: string; event: ScreenEvent; ticket: KTicket; onTap: (id: string, e: ScreenEvent) => void; tone: string }) {
  return (
    <button type="button" data-action={event} className={`${btn} ${tone}`} onClick={() => onTap(ticket.id, event)}>
      {label}
    </button>
  );
}

/**
 * The part of a ticket that can be long: the guest's note and the items. It is the only part that
 * scrolls, so the header, the allergens and the next-step button always stay on the card whatever
 * the screen's height. When some of it is out of view, it says so in words rather than hiding it.
 */
function TicketBody({ note, children }: { note: ReactNode; children: ReactNode }) {
  const ref = useRef<HTMLDivElement>(null);
  const [more, setMore] = useState(false);
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const check = () => setMore(el.scrollHeight - el.scrollTop - el.clientHeight > 4);
    check();
    el.addEventListener('scroll', check, { passive: true });
    const ro = new ResizeObserver(check);
    ro.observe(el);
    return () => {
      el.removeEventListener('scroll', check);
      ro.disconnect();
    };
  }, []);
  return (
    <div className="relative mt-2 flex min-h-24 flex-1 flex-col">
      {/* Focusable so a bump bar or keyboard can scroll it. */}
      <div ref={ref} tabIndex={0} role="group" aria-label="Note and items" data-testid="ticket-body" className="min-h-0 flex-1 overflow-y-auto pb-2">
        {note}
        <ul className="space-y-2 px-3 pt-2" aria-label="Items">
          {children}
        </ul>
      </div>
      {more ? (
        <p className="pointer-events-none absolute inset-x-0 bottom-0 bg-gradient-to-t from-[#1a1d23] from-60% to-transparent pt-6 text-center text-lg font-black text-slate-50" data-testid="ticket-more">
          ▼ MORE — SWIPE UP
        </p>
      ) : null}
    </div>
  );
}

const LEVEL_ICON: Record<Shown['esc']['level'], string> = { ok: '●', soon: '▲', due: '■', over: '⚠', ready: '✓', done: '↩' };

/**
 * One ticket. Who it is for, what is on it, allergens where nobody can miss them, how late it is
 * in words and colour, and the one next step as the biggest thing on the card.
 */
export function TicketCard({ shown, offline, onTap, onReject }: { shown: Shown; offline: boolean; onTap: (id: string, e: ScreenEvent) => void; onReject: (t: KTicket) => void }) {
  const { ticket: t, status, esc } = shown;
  const who = t.tableLabel ? `Table ${t.tableLabel}` : (t.guestName ?? 'Guest');
  return (
    <article
      data-testid="ticket"
      data-ticket-id={t.id}
      data-status={status}
      data-level={esc.level}
      aria-label={`Ticket ${t.ticketNumber}, ${who}, ${esc.label}, ${esc.timing}`}
      className={`kds-level-${esc.level} flex min-h-0 flex-col overflow-hidden rounded-xl bg-[#1a1d23] ${status === 'new' ? 'kds-new' : ''} ${status === 'bumped' ? 'opacity-70' : ''}`}
    >
      <div className="kds-bar flex shrink-0 items-center justify-between gap-2 px-3 py-2">
        <span className="whitespace-nowrap text-xl font-black tracking-wide" data-testid="ticket-level">
          <span aria-hidden className="mr-1">
            {LEVEL_ICON[esc.level]}
          </span>
          {esc.label}
        </span>
        <span className="shrink-0 text-lg font-bold tabular-nums" data-testid="ticket-timing">
          {esc.timing}
        </span>
      </div>

      <div className="flex shrink-0 items-baseline justify-between gap-2 px-3 pt-2">
        <p className="min-w-0 truncate text-3xl font-black" data-testid="ticket-who">
          {who}
        </p>
        <p className="font-mono text-2xl font-bold text-slate-300">#{t.ticketNumber}</p>
      </div>
      <p className="shrink-0 px-3 text-lg font-semibold text-slate-300">
        {CHANNEL_LABEL[t.channel]}
        {t.tableLabel && t.guestName ? ` · ${t.guestName}` : ''} · {t.reference}
        {status === 'new' ? <span className="ml-2 rounded bg-emerald-500 px-2 font-black text-black">NEW</span> : null}
      </p>

      {t.allergenFlags.length ? (
        <p className="kds-allergen mx-3 mt-2 shrink-0 rounded px-2 py-1 text-xl font-black uppercase leading-tight" data-testid="ticket-allergens">
          ⚠ Allergens: {t.allergenFlags.join(' · ')}
        </p>
      ) : null}

      <TicketBody
        note={
          t.notes ? (
            <p className="mx-3 rounded-lg border-2 border-amber-300 px-2 py-1 text-xl leading-snug text-amber-100" data-testid="ticket-note">
              <span className="font-bold">Guest note: </span>“{t.notes}”
            </p>
          ) : null
        }
      >
        {t.items.map((i, n) => (
          <li key={n} className="border-b border-slate-700 pb-2 last:border-b-0">
            <p className="text-2xl font-bold leading-snug">
              <span className="mr-2 inline-block min-w-8 rounded bg-slate-100 px-1 text-center text-black">{i.qty}</span>
              {i.name}
            </p>
            {i.modifiers.map((m, k) => (
              <p key={k} className="pl-10 text-xl text-slate-200">
                + {m}
              </p>
            ))}
            {i.allergens.length ? (
              <p className="pl-10 text-lg font-bold uppercase text-yellow-300">⚠ {i.allergens.join(', ')}</p>
            ) : null}
            {i.note ? <p className="pl-10 text-xl italic text-amber-200">Note: “{i.note}”</p> : null}
          </li>
        ))}
      </TicketBody>

      <div className="shrink-0 space-y-2 border-t-2 border-slate-700 p-3">
        {status === 'new' ? (
          <div className="grid grid-cols-[minmax(0,2fr)_minmax(0,1fr)] gap-2">
            <Action label="ACKNOWLEDGE" event="acknowledged" ticket={t} onTap={onTap} tone="bg-emerald-500 text-black active:bg-emerald-300" />
            <button
              type="button"
              disabled={offline}
              title={offline ? 'Rejecting needs the connection' : undefined}
              onClick={() => onReject(t)}
              data-action="reject"
              className="h-20 w-full min-w-0 rounded-xl border-4 border-red-500 px-1 text-lg font-bold text-red-200 active:bg-red-950 disabled:opacity-40 2xl:text-xl"
            >
              Reject
            </button>
          </div>
        ) : null}
        {status === 'acknowledged' ? <Action label="READY" event="ready" ticket={t} onTap={onTap} tone="bg-blue-700 text-white active:bg-blue-600" /> : null}
        {status === 'ready' ? <Action label="BUMP" event="bumped" ticket={t} onTap={onTap} tone="bg-slate-100 text-black active:bg-slate-300" /> : null}
        {status === 'bumped' ? <Action label="RECALL" event="recalled" ticket={t} onTap={onTap} tone="border-4 border-slate-300 text-slate-100 active:bg-slate-700" /> : null}
      </div>
    </article>
  );
}
