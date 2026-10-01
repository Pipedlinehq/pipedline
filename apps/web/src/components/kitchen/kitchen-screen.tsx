'use client';

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { type KBoard, type KTicket, type QueuedEvent, type ScreenEvent, type Shown, escalation, foldStatus, layoutOrder } from './logic';
import { TicketCard } from './ticket-card';
import { EightySixPanel, RejectPanel } from './panels';

/**
 * The kitchen order screen (docs/modules/kds.md sections 6 and 9, docs/modules/ordering.md section 5).
 *
 * Updates: the screen polls /kitchen/api/tickets every POLL_MS. Polling was chosen over a push
 * channel because it needs nothing but plain HTTP (no socket to keep alive through a venue's
 * Wi-Fi), it recovers by itself after an outage, and a few seconds' delay is well inside the
 * time a kitchen takes to look up. The server's clock comes back with every poll, so ticket ages
 * are right even when the tablet's clock is not.
 *
 * Offline: every tap is written to this screen's storage with its own idempotency key before
 * anything is sent, and sent in order through /kitchen/api/events (ordering.recordTicketEvents).
 * While the connection is down the taps wait, the tickets already received stay on screen and
 * fully usable, and a banner says so. On reconnect the queue is replayed; a key the server has
 * already recorded changes nothing, so a replay after a lost answer cannot double a tap. Server
 * state wins for what a ticket says; this screen's own taps are folded over its status until the
 * server has them.
 */

const POLL_MS = 4000;
const FLUSH_RETRY_MS = 3000;
/** How long a sent tap keeps being folded over server state, covering a poll that was already in flight. */
const RECENT_MS = 15_000;
const CARD_MIN_WIDTH = 300;

const QUEUE_KEY = (deviceId: string) => `ros.kitchen.${deviceId}.queue`;
const BOARD_KEY = (deviceId: string) => `ros.kitchen.${deviceId}.board`;

function load<T>(key: string): T | null {
  try {
    const raw = window.localStorage.getItem(key);
    return raw ? (JSON.parse(raw) as T) : null;
  } catch {
    return null;
  }
}
function save(key: string, value: unknown): void {
  try {
    window.localStorage.setItem(key, JSON.stringify(value));
  } catch {
    // Storage full or blocked: the queue still lives in memory for this session.
  }
}

function newKey(): string {
  const c = globalThis.crypto;
  if (c && 'randomUUID' in c) return c.randomUUID();
  return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}-${Math.random().toString(36).slice(2)}`;
}

function clockLabel(ms: number): string {
  return new Intl.DateTimeFormat('en-AU', { hour: 'numeric', minute: '2-digit' }).format(new Date(ms));
}

/** Two short tones. Created only after a tap, so the browser allows it. */
function beep(ctx: AudioContext): void {
  const t0 = ctx.currentTime;
  for (const [i, freq] of [880, 1320, 880].entries()) {
    const osc = ctx.createOscillator();
    const gain = ctx.createGain();
    osc.type = 'square';
    osc.frequency.value = freq;
    gain.gain.setValueAtTime(0.0001, t0 + i * 0.25);
    gain.gain.exponentialRampToValueAtTime(0.35, t0 + i * 0.25 + 0.02);
    gain.gain.exponentialRampToValueAtTime(0.0001, t0 + i * 0.25 + 0.2);
    osc.connect(gain).connect(ctx.destination);
    osc.start(t0 + i * 0.25);
    osc.stop(t0 + i * 0.25 + 0.22);
  }
}

export function KitchenScreen({ initial, venueName, deviceId }: { initial: KBoard; venueName: string; deviceId: string }) {
  const [board, setBoard] = useState<KBoard>(initial);
  const [queue, setQueue] = useState<QueuedEvent[]>([]);
  const [recent, setRecent] = useState<Array<QueuedEvent & { sentAt: number }>>([]);
  const [offline, setOffline] = useState(false);
  const [lastOkAt, setLastOkAt] = useState<number>(() => Date.now());
  const [offsetMs, setOffsetMs] = useState(() => Date.parse(initial.serverTime) - Date.now());
  const [nowMs, setNowMs] = useState(() => Date.parse(initial.serverTime));
  const [page, setPage] = useState(0);
  const [perPage, setPerPage] = useState(4);
  const [soundOn, setSoundOn] = useState(false);
  const [panel, setPanel] = useState<{ kind: 'reject'; ticket: KTicket } | { kind: '86' } | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  const queueRef = useRef<QueuedEvent[]>([]);
  const flushing = useRef(false);
  const epoch = useRef(0);
  const audio = useRef<AudioContext | null>(null);
  const viewed = useRef(new Set<string>());
  const heard = useRef(new Set<string>(initial.tickets.filter((t) => t.status === 'new').map((t) => t.id)));
  const boardArea = useRef<HTMLDivElement>(null);
  const offsetRef = useRef(offsetMs);
  offsetRef.current = offsetMs;

  const setQueueBoth = useCallback(
    (next: QueuedEvent[]) => {
      queueRef.current = next;
      setQueue(next);
      save(QUEUE_KEY(deviceId), next);
    },
    [deviceId],
  );

  const unpaired = useCallback(() => {
    try {
      window.localStorage.removeItem(QUEUE_KEY(deviceId));
      window.localStorage.removeItem(BOARD_KEY(deviceId));
    } catch {
      // nothing to clear
    }
    window.location.replace('/kitchen');
  }, [deviceId]);

  const poll = useCallback(async () => {
    const startedEpoch = epoch.current;
    try {
      const res = await fetch('/kitchen/api/tickets', { cache: 'no-store', headers: { accept: 'application/json' } });
      if (res.status === 401) return unpaired();
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const next = (await res.json()) as KBoard;
      setOffline(false);
      setLastOkAt(Date.now());
      setOffsetMs(Date.parse(next.serverTime) - Date.now());
      // A poll that started before our last batch of taps landed may not show them: skip it.
      if (startedEpoch !== epoch.current) return;
      setBoard(next);
      save(BOARD_KEY(deviceId), next);
    } catch {
      setOffline(true);
    }
  }, [deviceId, unpaired]);

  const flush = useCallback(async () => {
    if (flushing.current || !queueRef.current.length) return;
    flushing.current = true;
    const batch = queueRef.current.slice(0, 200);
    let delivered = false;
    try {
      const res = await fetch('/kitchen/api/events', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ events: batch.map((e) => ({ ticketId: e.ticketId, event: e.event, key: e.key, occurredAt: e.occurredAt })) }),
      });
      if (res.status === 401) {
        unpaired();
        return;
      }
      if (!res.ok) {
        // The batch itself was refused (malformed): drop it rather than retry it forever.
        if (res.status >= 400 && res.status < 500) {
          const body = (await res.json().catch(() => null)) as { error?: { message?: string } } | null;
          setNotice(body?.error?.message ?? 'Some taps could not be saved.');
          setQueueBoth(queueRef.current.filter((q) => !batch.some((b) => b.key === q.key)));
          return;
        }
        // A server error: keep the taps, the retry timer sends them again.
        return;
      }
      const { results } = (await res.json()) as { results: Array<{ key: string; ok: boolean; error?: string }> };
      const done = new Set(results.map((r) => r.key));
      const failed = results.filter((r) => !r.ok);
      if (failed.length) setNotice(failed[0]!.error ?? 'A tap could not be applied.');
      const sentAt = Date.now();
      epoch.current++;
      setRecent((r) => [...r.filter((x) => sentAt - x.sentAt < RECENT_MS), ...batch.filter((b) => done.has(b.key) && results.find((x) => x.key === b.key)?.ok).map((b) => ({ ...b, sentAt }))]);
      setQueueBoth(queueRef.current.filter((q) => !done.has(q.key)));
      setOffline(false);
      setLastOkAt(Date.now());
      delivered = true;
    } catch {
      // No connection: the taps stay queued here and the retry timer tries again.
      setOffline(true);
    } finally {
      flushing.current = false;
    }
    if (!delivered) return;
    if (queueRef.current.length) void flush();
    else void poll();
  }, [poll, setQueueBoth, unpaired]);

  // Start: what this screen had queued or last saw before it was closed. A page served from the
  // offline cache carries an old board; the one saved from the last poll is newer.
  useEffect(() => {
    const cached = load<KBoard>(BOARD_KEY(deviceId));
    if (cached && Date.parse(cached.serverTime) > Date.parse(initial.serverTime)) setBoard(cached);
    const saved = load<QueuedEvent[]>(QUEUE_KEY(deviceId)) ?? [];
    if (saved.length) {
      queueRef.current = saved;
      setQueue(saved);
      void flush();
    }
    if (!navigator.onLine) setOffline(true);
    if ('serviceWorker' in navigator) navigator.serviceWorker.register('/kitchen/sw.js', { scope: '/kitchen' }).catch(() => undefined);
  }, [deviceId, flush]);

  useEffect(() => {
    const id = window.setInterval(() => void poll(), POLL_MS);
    const retry = window.setInterval(() => {
      if (queueRef.current.length) void flush();
    }, FLUSH_RETRY_MS);
    const goOnline = () => {
      void flush();
      void poll();
    };
    const goOffline = () => setOffline(true);
    window.addEventListener('online', goOnline);
    window.addEventListener('offline', goOffline);
    return () => {
      window.clearInterval(id);
      window.clearInterval(retry);
      window.removeEventListener('online', goOnline);
      window.removeEventListener('offline', goOffline);
    };
  }, [poll, flush]);

  // The clock on screen follows the server's.
  useEffect(() => {
    const id = window.setInterval(() => setNowMs(Date.now() + offsetRef.current), 1000);
    return () => window.clearInterval(id);
  }, []);

  // How many tickets fit side by side: that is a page. Nothing is ever below the fold.
  useEffect(() => {
    const el = boardArea.current;
    if (!el) return;
    const measure = () => setPerPage(Math.max(1, Math.floor(el.clientWidth / CARD_MIN_WIDTH)));
    measure();
    const ro = new ResizeObserver(measure);
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  const tap = useCallback(
    (ticketId: string, event: ScreenEvent) => {
      const e: QueuedEvent = { key: newKey(), ticketId, event, occurredAt: new Date(Date.now() + offsetRef.current).toISOString() };
      setQueueBoth([...queueRef.current, e]);
      void flush();
    },
    [flush, setQueueBoth],
  );

  const shown: Shown[] = useMemo(() => {
    const pending = [...recent, ...queue];
    return layoutOrder(
      board.tickets
        .map((ticket) => {
          const status = foldStatus(
            ticket.status,
            pending.filter((p) => p.ticketId === ticket.id),
          );
          return { ticket, status, esc: escalation(ticket, status, nowMs) };
        })
        .filter((s) => s.status !== 'cancelled'),
    );
  }, [board, queue, recent, nowMs]);

  const pages = Math.max(1, Math.ceil(shown.length / perPage));
  const current = Math.min(page, pages - 1);
  const visible = shown.slice(current * perPage, current * perPage + perPage);
  const newOnes = shown.filter((s) => s.status === 'new');
  const overdue = shown.filter((s) => s.esc.level === 'over');
  const overdueElsewhere = overdue.filter((s) => !visible.includes(s)).length;
  const newElsewhere = newOnes.filter((s) => !visible.includes(s)).length;

  // First view of a ticket on screen is a measured moment (kds.md section 10). One key per ticket, so it is recorded once.
  useEffect(() => {
    for (const s of visible) {
      if (s.status === 'new' && !viewed.current.has(s.ticket.id)) {
        viewed.current.add(s.ticket.id);
        setQueueBoth([...queueRef.current, { key: `viewed-${s.ticket.id}`, ticketId: s.ticket.id, event: 'viewed', occurredAt: new Date(Date.now() + offsetRef.current).toISOString() }]);
        void flush();
      }
    }
  }, [visible, flush, setQueueBoth]);

  // The new-order alert: at once for a ticket not heard before, then again every alertRepeatSeconds until acknowledged.
  const newIds = newOnes.map((s) => s.ticket.id).join(',');
  useEffect(() => {
    if (!newIds) return;
    const ids = newIds.split(',');
    const fresh = ids.some((id) => !heard.current.has(id));
    ids.forEach((id) => heard.current.add(id));
    const ring = () => {
      if (audio.current && audio.current.state === 'running') beep(audio.current);
    };
    if (fresh) ring();
    const id = window.setInterval(ring, Math.max(5, board.alertRepeatSeconds) * 1000);
    return () => window.clearInterval(id);
  }, [newIds, board.alertRepeatSeconds, soundOn]);

  const enableSound = useCallback(() => {
    try {
      const Ctor = window.AudioContext ?? (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
      if (!Ctor) return;
      audio.current ??= new Ctor();
      void audio.current.resume().then(() => setSoundOn(audio.current?.state === 'running'));
    } catch {
      // No audio on this device: the visual alert still repeats.
    }
  }, []);

  // Any touch turns sound on: the browser only allows audio after one.
  useEffect(() => {
    const onFirst = () => enableSound();
    window.addEventListener('pointerdown', onFirst, { once: true });
    return () => window.removeEventListener('pointerdown', onFirst);
  }, [enableSound]);

  // A bump bar is a keyboard: left and right page.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (panel) return;
      if (e.key === 'ArrowRight' || e.key === 'PageDown') setPage((p) => Math.min(p + 1, pages - 1));
      if (e.key === 'ArrowLeft' || e.key === 'PageUp') setPage((p) => Math.max(p - 1, 0));
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [pages, panel]);

  useEffect(() => {
    if (!notice) return;
    const id = window.setTimeout(() => setNotice(null), 8000);
    return () => window.clearTimeout(id);
  }, [notice]);

  // Taps a person made and is waiting on; the automatic "seen" marks are not counted.
  const taps = queue.filter((e) => e.event !== 'viewed').length;
  const counts = {
    new: newOnes.length,
    cooking: shown.filter((s) => s.status === 'acknowledged').length,
    ready: shown.filter((s) => s.status === 'ready').length,
  };

  return (
    <div className="flex h-dvh flex-col overflow-hidden" data-testid="kitchen-screen">
      {offline ? (
        <div role="alert" data-testid="offline-banner" className="kds-offline flex items-center gap-4 px-5 py-3 text-black">
          <span className="rounded bg-black px-3 py-1 text-xl font-black tracking-wider text-yellow-300">OFFLINE</span>
          <span className="text-xl font-bold">
            No connection since {clockLabel(lastOkAt + offsetMs)}. Tickets stay on screen and taps are saved here
            {taps ? ` (${taps} ${taps === 1 ? 'tap' : 'taps'} waiting)` : ''}. They send by themselves when the connection is back.
          </span>
        </div>
      ) : null}

      <header className="flex shrink-0 items-center gap-3 border-b-2 border-slate-700 bg-[#12151a] px-4 py-2">
        <div className="min-w-0">
          <p className="truncate text-2xl font-bold">{venueName}</p>
          <p className="text-base text-slate-300" data-testid="kitchen-counts">
            {counts.new} new · {counts.cooking} cooking · {counts.ready} ready
            {!offline && taps ? <span className="ml-2 text-amber-300">· sending {taps}…</span> : null}
          </p>
        </div>
        <p className="ml-auto font-mono text-3xl font-bold tabular-nums" aria-label="Time now">
          {clockLabel(nowMs)}
        </p>
        {!soundOn ? (
          <button type="button" onClick={enableSound} className="h-16 rounded-xl border-4 border-amber-400 px-4 text-lg font-bold text-amber-300 active:bg-amber-950">
            Tap to turn sound on
          </button>
        ) : (
          <span className="rounded-lg border-2 border-slate-600 px-3 py-2 text-base font-semibold text-slate-300">Sound on</span>
        )}
        <button type="button" onClick={() => setPanel({ kind: '86' })} className="h-16 min-w-24 rounded-xl bg-slate-100 px-5 text-2xl font-black text-black active:bg-slate-300">
          86
        </button>
        <div className="flex items-center gap-2" aria-label="Pages">
          <button type="button" aria-label="Previous page" disabled={current === 0} onClick={() => setPage(current - 1)} className="h-16 w-20 rounded-xl bg-slate-700 text-3xl font-bold active:bg-slate-600 disabled:opacity-30">
            ‹
          </button>
          <span className="w-20 text-center text-lg font-semibold tabular-nums" data-testid="kitchen-page">
            {current + 1} / {pages}
          </span>
          <button
            type="button"
            aria-label="Next page"
            disabled={current >= pages - 1}
            onClick={() => setPage(current + 1)}
            className="h-16 w-20 rounded-xl bg-slate-700 text-3xl font-bold active:bg-slate-600 disabled:opacity-30"
          >
            ›
          </button>
        </div>
      </header>

      {newOnes.length ? (
        <div role="alert" data-testid="new-alert" className="kds-alert flex shrink-0 items-center justify-center gap-3 px-4 py-2 text-2xl font-black tracking-wide">
          <span aria-hidden>●</span> {newOnes.length === 1 ? 'NEW ORDER' : `${newOnes.length} NEW ORDERS`} — TAP ACKNOWLEDGE
          {newElsewhere ? <span className="ml-2 rounded bg-black/40 px-2 text-xl">{newElsewhere} on another page</span> : null}
        </div>
      ) : null}
      {overdueElsewhere ? (
        <div role="alert" className="shrink-0 bg-red-700 px-4 py-2 text-center text-xl font-black">
          ⚠ {overdueElsewhere} MORE OVERDUE ON THE NEXT PAGE ›
        </div>
      ) : null}
      {notice ? (
        <div role="status" className="shrink-0 bg-slate-200 px-4 py-2 text-center text-lg font-semibold text-black">
          {notice}
        </div>
      ) : null}

      <main ref={boardArea} className="min-h-0 flex-1 p-3">
        {shown.length === 0 ? (
          <div className="flex h-full flex-col items-center justify-center text-center">
            <p className="text-4xl font-bold">No orders right now</p>
            <p className="mt-2 text-xl text-slate-400">New orders appear here by themselves, with a sound.</p>
          </div>
        ) : (
          <div className="grid h-full gap-3" style={{ gridTemplateColumns: `repeat(${perPage}, minmax(0, 1fr))` }}>
            {visible.map((s) => (
              <TicketCard key={s.ticket.id} shown={s} offline={offline} onTap={tap} onReject={(t) => setPanel({ kind: 'reject', ticket: t })} />
            ))}
          </div>
        )}
      </main>

      {panel?.kind === 'reject' ? <RejectPanel ticket={panel.ticket} offline={offline} onClose={() => setPanel(null)} onDone={(msg) => { setPanel(null); setNotice(msg); void poll(); }} /> : null}
      {panel?.kind === '86' ? <EightySixPanel offline={offline} onClose={() => setPanel(null)} /> : null}
    </div>
  );
}
