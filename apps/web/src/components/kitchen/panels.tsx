'use client';

import { type ReactNode, useEffect, useState } from 'react';
import type { KTicket } from './logic';

function Overlay({ title, onClose, children }: { title: string; onClose: () => void; children: ReactNode }) {
  return (
    <div role="dialog" aria-modal="true" aria-label={title} className="fixed inset-0 z-50 flex flex-col bg-[#0b0d10] p-6">
      <div className="mb-4 flex items-center justify-between gap-4">
        <h2 className="text-3xl font-black">{title}</h2>
        <button type="button" onClick={onClose} className="h-16 rounded-xl bg-slate-100 px-8 text-2xl font-black text-black active:bg-slate-300">
          Close
        </button>
      </div>
      <div className="min-h-0 flex-1 overflow-y-auto">{children}</div>
    </div>
  );
}

const REASONS = ['We have sold out of something in this order.', 'The kitchen is too busy to take this order right now.', 'We are closing early tonight.'];

/** Turning a new order down refunds it and tells the guest why, so it needs the connection and a reason the guest can read. */
export function RejectPanel({ ticket, offline, onClose, onDone }: { ticket: KTicket; offline: boolean; onClose: () => void; onDone: (message: string) => void }) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const reject = async (reason: string) => {
    setBusy(true);
    setError(null);
    try {
      const res = await fetch('/kitchen/api/reject', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ orderId: ticket.orderId, reason }) });
      const body = (await res.json().catch(() => null)) as { error?: { message?: string } } | null;
      if (!res.ok) throw new Error(body?.error?.message ?? 'The order could not be rejected.');
      onDone(`Order #${ticket.ticketNumber} rejected. The guest is refunded and told why.`);
    } catch (e) {
      setError((e as Error).message === 'Failed to fetch' ? 'No connection. Try again when the screen is back online.' : (e as Error).message);
    } finally {
      setBusy(false);
    }
  };
  return (
    <Overlay title={`Reject order #${ticket.ticketNumber}?`} onClose={onClose}>
      <p className="mb-4 text-xl text-slate-300">The guest is refunded in full and sees the reason you choose.</p>
      {offline ? <p className="mb-4 rounded-xl bg-yellow-300 p-4 text-xl font-bold text-black">Rejecting needs a connection. The screen is offline.</p> : null}
      {error ? (
        <p role="alert" className="mb-4 rounded-xl border-4 border-red-500 bg-red-950 p-4 text-xl font-semibold">
          {error}
        </p>
      ) : null}
      <div className="grid gap-3">
        {REASONS.map((r) => (
          <button key={r} type="button" disabled={busy || offline} onClick={() => reject(r)} className="min-h-20 rounded-xl border-4 border-red-500 px-5 text-left text-2xl font-bold active:bg-red-950 disabled:opacity-40">
            {r}
          </button>
        ))}
      </div>
    </Overlay>
  );
}

interface MenuItem {
  id: string;
  name: string;
  section: string;
  available: boolean;
}

/** The 86 button (docs/modules/ordering.md section 1): one tap takes a dish off the site, the QR menu and ordering until the end of service. */
export function EightySixPanel({ offline, onClose }: { offline: boolean; onClose: () => void }) {
  const [items, setItems] = useState<MenuItem[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);

  useEffect(() => {
    let live = true;
    fetch('/kitchen/api/menu', { cache: 'no-store' })
      .then(async (r) => {
        const body = (await r.json()) as { items?: MenuItem[]; error?: { message: string } };
        if (!r.ok) throw new Error(body.error?.message ?? 'The menu could not be loaded.');
        if (live) setItems(body.items ?? []);
      })
      .catch((e: Error) => live && setError(e.message === 'Failed to fetch' ? 'No connection. The 86 list needs the connection.' : e.message));
    return () => {
      live = false;
    };
  }, []);

  const toggle = async (item: MenuItem) => {
    setBusy(item.id);
    setError(null);
    try {
      const res = await fetch('/kitchen/api/menu', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ itemId: item.id, available: !item.available }) });
      const body = (await res.json().catch(() => null)) as { available?: boolean; error?: { message?: string } } | null;
      if (!res.ok) throw new Error(body?.error?.message ?? 'That could not be changed.');
      setItems((list) => list?.map((i) => (i.id === item.id ? { ...i, available: Boolean(body?.available) } : i)) ?? null);
    } catch (e) {
      setError((e as Error).message === 'Failed to fetch' ? 'No connection. Try again when the screen is back online.' : (e as Error).message);
    } finally {
      setBusy(null);
    }
  };

  const sections = [...new Set((items ?? []).map((i) => i.section))];
  return (
    <Overlay title="86 — what has run out" onClose={onClose}>
      <p className="mb-4 text-xl text-slate-300">Tap a dish to take it off every menu until the end of this service. Tap again to bring it back.</p>
      {offline ? <p className="mb-4 rounded-xl bg-yellow-300 p-4 text-xl font-bold text-black">The screen is offline: changes need the connection.</p> : null}
      {error ? (
        <p role="alert" className="mb-4 rounded-xl border-4 border-red-500 bg-red-950 p-4 text-xl font-semibold">
          {error}
        </p>
      ) : null}
      {items === null && !error ? <p className="text-2xl">Loading the menu…</p> : null}
      {sections.map((s) => (
        <section key={s} className="mb-6">
          <h3 className="mb-2 text-xl font-bold uppercase tracking-wide text-slate-400">{s}</h3>
          <div className="grid grid-cols-2 gap-3 lg:grid-cols-3">
            {items!
              .filter((i) => i.section === s)
              .map((i) => (
                <button
                  key={i.id}
                  type="button"
                  data-item={i.name}
                  aria-pressed={!i.available}
                  disabled={busy === i.id || offline}
                  onClick={() => toggle(i)}
                  className={`flex min-h-20 items-center justify-between gap-3 rounded-xl px-4 text-left text-xl font-bold disabled:opacity-50 ${i.available ? 'border-4 border-slate-600 bg-[#1a1d23] active:bg-slate-700' : 'border-4 border-red-500 bg-red-950 line-through decoration-4 active:bg-red-900'}`}
                >
                  <span>{i.name}</span>
                  <span className={`shrink-0 rounded px-2 py-1 text-base no-underline ${i.available ? 'bg-emerald-500 text-black' : 'bg-red-500 text-white'}`}>{i.available ? 'ON' : "86'D"}</span>
                </button>
              ))}
          </div>
        </section>
      ))}
    </Overlay>
  );
}
