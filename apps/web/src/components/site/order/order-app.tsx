'use client';

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useRouter } from 'next/navigation';
import type { menu } from '@ros/modules';
import { cx, dietLabel, money } from '../format';
import { track } from '../track';
import { type CartLine, type PricedCart, type SlotBoard, api, loadCart, newKey, saveCart, toCartInput } from './api';
import { AddressPicker, type DeliveryAddress, EMPTY_ADDRESS, type TestAddress } from './address-picker';
import { type CardChoice, CardPicker, type PaymentConfig } from './card-picker';

type Item = menu.PublicMenuItem;

export interface ConsentBox {
  purpose: string;
  version: string;
  body: string;
}

export interface RewardChoice {
  code: string;
  name: string;
  description: string | null;
  costPoints: number;
  canAfford: boolean;
  blockedReason: string | null;
}

export interface OrderAppProps {
  venue: { id: string; name: string; timezone: string };
  channel: 'pickup' | 'dine-in-qr';
  /** Set when the venue delivers. `testAddresses` only with simulated providers. */
  delivery: { testAddresses: TestAddress[] | null } | null;
  /** False when pickup is switched off and only delivery is offered. */
  pickupEnabled: boolean;
  table: { label: string | null; area: string | null } | null;
  menu: menu.PublicMenu;
  excludeAlcohol: boolean;
  showPrices: boolean;
  payment: PaymentConfig | null;
  promoCodesEnabled: boolean;
  consents: ConsentBox[];
  loyalty: { programName: string; joinable: boolean; member: { available: number } | null; rewards: RewardChoice[] } | null;
  guest: { name: string; email: string; phone: string } | null;
  signInHref: string;
  initialCode: string | null;
  /** Show the receipt-by-email hint and the loyalty box at a table (qr config prompts). */
  prompts: { receiptEmail: boolean; loyalty: boolean };
}

const CONSENT_TITLES: Record<string, string> = {
  marketing_email: 'Offers by email',
  marketing_sms: 'Offers by text message',
  card_recognition: 'Recognise my card',
  ad_platform_sharing: 'Help measure this venue’s ads',
};
const CONSENT_ORDER = ['marketing_email', 'marketing_sms', 'card_recognition', 'ad_platform_sharing'];

function timeLabel(iso: string, tz: string): string {
  return new Intl.DateTimeFormat('en-AU', { timeZone: tz, hour: 'numeric', minute: '2-digit' }).format(new Date(iso));
}
function dayLabel(date: string, tz: string, today: string): string {
  if (date === today) return 'Today';
  return new Intl.DateTimeFormat('en-AU', { timeZone: 'UTC', weekday: 'long', day: 'numeric', month: 'short' }).format(new Date(`${date}T12:00:00Z`));
}

// ── Item dialog ─────────────────────────────────────────────────────────────

function ItemDialog({
  item,
  currency,
  showPrices,
  onClose,
  onAdd,
  check,
}: {
  item: Item;
  currency: string;
  showPrices: boolean;
  onClose: () => void;
  onAdd: (line: Omit<CartLine, 'key'>) => void;
  /** Ask the server whether this one line can be ordered as chosen. Returns the problems, in words. */
  check: (line: Omit<CartLine, 'key'>) => Promise<string[]>;
}) {
  const ref = useRef<HTMLDialogElement>(null);
  const [picked, setPicked] = useState<Record<string, string[]>>(() =>
    Object.fromEntries(item.modifierGroups.map((g) => [g.id, g.modifiers.filter((m) => m.isDefault && m.isAvailable).map((m) => m.id)])),
  );
  const [qty, setQty] = useState(1);
  const [note, setNote] = useState('');
  const [problems, setProblems] = useState<string[]>([]);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    ref.current?.showModal();
    track('item.viewed', { menu_item_id: item.id, name: item.name.slice(0, 200) });
  }, [item.id, item.name]);

  const toggle = (groupId: string, modId: string, single: boolean) =>
    setPicked((p) => {
      const cur = p[groupId] ?? [];
      return { ...p, [groupId]: single ? [modId] : cur.includes(modId) ? cur.filter((x) => x !== modId) : [...cur, modId] };
    });

  const modifierIds = Object.values(picked).flat();
  const modifierNames = item.modifierGroups.flatMap((g) => g.modifiers.filter((m) => modifierIds.includes(m.id)).map((m) => m.name));
  const unit = item.priceCents + item.modifierGroups.flatMap((g) => g.modifiers).filter((m) => modifierIds.includes(m.id)).reduce((s, m) => s + m.priceDeltaCents, 0);

  const add = async () => {
    setBusy(true);
    const line = { menuItemId: item.id, name: item.name, qty, modifierIds, modifierNames, note: note.trim() || null };
    const found = await check(line);
    setBusy(false);
    if (found.length) {
      setProblems(found);
      return;
    }
    onAdd(line);
    ref.current?.close();
  };

  return (
    <dialog
      ref={ref}
      onClose={onClose}
      aria-labelledby="item-dialog-title"
      className="m-auto max-h-[92dvh] w-[min(36rem,calc(100vw-1rem))] overflow-y-auto rounded-[var(--brand-radius-lg)] border p-0 backdrop:bg-black/50 s-rule"
      style={{ background: 'var(--brand-color-surface)', color: 'var(--brand-color-text)' }}
    >
      <div className="space-y-5 p-5">
        <div className="flex items-start justify-between gap-4">
          <div>
            <h2 id="item-dialog-title" className="s-heading text-2xl">
              {item.name}
            </h2>
            {showPrices ? <p className="s-tabular font-semibold">{money(item.priceCents, currency)}</p> : null}
          </div>
          <button type="button" className="s-btn-outline px-3" onClick={() => ref.current?.close()} aria-label="Close">
            ✕
          </button>
        </div>
        {item.description ? <p className="s-muted">{item.description}</p> : null}
        {item.dietaryTags.length ? <p className="text-sm">{item.dietaryTags.map(dietLabel).join(' · ')}</p> : null}
        <p className="text-sm">
          <span className="font-semibold">Allergens:</span> {item.allergens.length ? item.allergens.join(', ') : 'none listed. Tell us about any allergy in the note.'}
        </p>
        {item.modifierGroups.map((g) => {
          const single = g.selectionType === 'single' && g.maxSelections === 1;
          const rule = g.minSelections > 0 ? (g.minSelections === g.maxSelections ? `Required: choose ${g.minSelections}` : `Required: choose ${g.minSelections} to ${g.maxSelections}`) : `Optional${g.maxSelections > 1 ? `: up to ${g.maxSelections}` : ''}`;
          return (
            <fieldset key={g.id} className="space-y-2">
              <legend className="font-semibold">
                {g.name} <span className="text-sm font-normal">({rule})</span>
              </legend>
              {g.modifiers.map((m) => (
                <label key={m.id} className={cx('flex min-h-11 items-center gap-3 rounded-[var(--brand-radius-md)] border px-3 py-2 s-rule', !m.isAvailable && 'cursor-not-allowed')}>
                  <input
                    type={single ? 'radio' : 'checkbox'}
                    name={`g-${g.id}`}
                    className="s-check mt-0"
                    checked={(picked[g.id] ?? []).includes(m.id)}
                    disabled={!m.isAvailable}
                    onChange={() => toggle(g.id, m.id, single)}
                  />
                  <span className="flex-1">
                    {m.name}
                    {!m.isAvailable ? <span className="ml-2 text-sm font-semibold">(sold out)</span> : null}
                  </span>
                  {m.priceDeltaCents && showPrices ? <span className="s-tabular text-sm">+{money(m.priceDeltaCents, currency)}</span> : null}
                </label>
              ))}
            </fieldset>
          );
        })}
        <label className="block space-y-1">
          <span className="font-semibold">Note for the kitchen (optional)</span>
          <input className="s-input" maxLength={200} value={note} onChange={(e) => setNote(e.target.value)} placeholder="e.g. no onion" />
        </label>
        {problems.length ? (
          <div role="alert" className="s-notice space-y-1" data-tone="error">
            {problems.map((p) => (
              <p key={p}>{p}</p>
            ))}
          </div>
        ) : null}
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div className="flex items-center gap-2" role="group" aria-label="Quantity">
            <button type="button" className="s-btn-outline px-4" onClick={() => setQty((q) => Math.max(1, q - 1))} aria-label="One fewer" disabled={qty <= 1}>
              −
            </button>
            <span className="s-tabular min-w-8 text-center text-lg font-semibold" aria-live="polite" aria-label={`Quantity ${qty}`}>
              {qty}
            </span>
            <button type="button" className="s-btn-outline px-4" onClick={() => setQty((q) => Math.min(item.maxPerOrder ?? 99, q + 1))} aria-label="One more">
              +
            </button>
          </div>
          <button type="button" className="s-btn" onClick={add} disabled={busy} aria-busy={busy}>
            {busy ? 'Checking…' : `Add to order${showPrices ? ` · ${money(unit * qty, currency)}` : ''}`}
          </button>
        </div>
      </div>
    </dialog>
  );
}

// ── The app ─────────────────────────────────────────────────────────────────

export function OrderApp(props: OrderAppProps) {
  const { venue, menu: data, showPrices } = props;
  const [fulfilment, setFulfilment] = useState<'pickup' | 'delivery'>(props.pickupEnabled || !props.delivery ? 'pickup' : 'delivery');
  const channel: 'pickup' | 'delivery' | 'dine-in-qr' = props.channel === 'dine-in-qr' ? 'dine-in-qr' : fulfilment;
  const [address, setAddress] = useState<DeliveryAddress>(EMPTY_ADDRESS);
  const [courierNotes, setCourierNotes] = useState('');
  const [quote, setQuote] = useState<{ deliveryId: string; feeCents: number; dropoffEta: string | null; zoneName: string } | null>(null);
  const [quoteError, setQuoteError] = useState<string | null>(null);
  const [quoting, setQuoting] = useState(false);
  const router = useRouter();
  const storageKey = `ros-cart:${venue.id}:${props.channel}`;
  const [lines, setLines] = useState<CartLine[]>([]);
  const [loaded, setLoaded] = useState(false);
  const [open, setOpen] = useState<Item | null>(null);
  const [priced, setPriced] = useState<PricedCart | null>(null);
  const [priceError, setPriceError] = useState<string | null>(null);
  const [codes, setCodes] = useState<string[]>(props.initialCode ? [props.initialCode] : []);
  const [codeInput, setCodeInput] = useState('');
  const [tipPercent, setTipPercent] = useState<number>(0);
  const [slot, setSlot] = useState<string>('asap');
  const [board, setBoard] = useState<SlotBoard | null>(null);
  const [date, setDate] = useState<string | null>(null);
  const [step, setStep] = useState<'menu' | 'checkout'>('menu');
  const [name, setName] = useState(props.guest?.name ?? '');
  const [email, setEmail] = useState(props.guest?.email ?? '');
  const [phone, setPhone] = useState(props.guest?.phone ?? '');
  const [note, setNote] = useState('');
  const [ticked, setTicked] = useState<Record<string, boolean>>({});
  const [joinLoyalty, setJoinLoyalty] = useState(false);
  const [card, setCard] = useState<CardChoice>(null);
  const [placing, setPlacing] = useState(false);
  const [checkoutError, setCheckoutError] = useState<{ message: string; issues?: string[] } | null>(null);
  const [payMessage, setPayMessage] = useState<{ tone: 'error' | 'info'; text: string; retry?: boolean } | null>(null);
  const [order, setOrder] = useState<{ trackingToken: string; reference: string; totalCents: number } | null>(null);
  const idempotencyKey = useRef<string>(newKey());
  const checkoutRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    setLines(loadCart(storageKey));
    setLoaded(true);
  }, [storageKey]);
  useEffect(() => {
    if (loaded) saveCart(storageKey, lines);
  }, [lines, loaded, storageKey]);

  const tipCents = priced && tipPercent ? Math.round((priced.subtotalCents * tipPercent) / 100) : 0;

  // The server prices the cart; the page shows exactly what it says.
  const priceSeq = useRef(0);
  useEffect(() => {
    if (!loaded) return;
    if (!lines.length) {
      setPriced(null);
      setPriceError(null);
      return;
    }
    const seq = ++priceSeq.current;
    const t = window.setTimeout(async () => {
      const r = await api<PricedCart>('/api/cart', {
        // Until an address has been checked there is no delivery to price: show the food's price.
        body: { venueId: venue.id, channel: channel === 'delivery' && !quote ? 'pickup' : channel, lines: toCartInput(lines), codes, tipCents, slotStart: channel === 'pickup' && slot !== 'asap' ? slot : null, deliveryId: channel === 'delivery' ? quote?.deliveryId : undefined },
      });
      if (seq !== priceSeq.current) return;
      if (r.ok) {
        setPriced(r.data);
        setPriceError(null);
      } else {
        setPriced(null);
        setPriceError(r.error.message);
      }
    }, 200);
    return () => window.clearTimeout(t);
  }, [lines, codes, tipCents, slot, loaded, venue.id, channel, quote]);

  // Pickup times, for the checkout.
  const itemCount = lines.reduce((s, l) => s + l.qty, 0);
  const prepMinutes = priced?.prepMinutes ?? 0;
  useEffect(() => {
    if (channel !== 'pickup' || step !== 'checkout' || !itemCount) return;
    const q = new URLSearchParams({ venueId: venue.id, itemCount: String(itemCount), prepMinutes: String(prepMinutes), ...(date ? { date } : {}) });
    let live = true;
    void api<SlotBoard>(`/api/slots?${q}`).then((r) => {
      if (!live || !r.ok) return;
      setBoard(r.data);
      setSlot((cur) => {
        if (cur === 'asap' && !r.data.asap.available && r.data.slots[0]) return r.data.slots[0].start;
        if (cur !== 'asap' && !r.data.slots.some((s) => s.start === cur)) return r.data.asap.available ? 'asap' : (r.data.slots[0]?.start ?? 'asap');
        return cur;
      });
    });
    return () => {
      live = false;
    };
  }, [channel, step, itemCount, prepMinutes, date, venue.id]);

  const checkLine = useCallback(
    async (line: Omit<CartLine, 'key'>) => {
      // A dish is checked on its own merits; delivery is priced once an address has been checked.
      const r = await api<PricedCart>('/api/cart', { body: { venueId: venue.id, channel: channel === 'delivery' ? 'pickup' : channel, lines: toCartInput([{ ...line, key: 'x' }]) } });
      if (!r.ok) return [r.error.message];
      // Only problems with the line itself: a closed kitchen or a minimum order is not the dish's fault.
      return r.data.issues.filter((i) => i.lineIndex === 0).map((i) => i.message);
    },
    [venue.id, channel],
  );

  const addLine = (line: Omit<CartLine, 'key'>) => {
    setLines((ls) => [...ls, { ...line, key: newKey() }]);
    track('cart.item_added', { menu_item_id: line.menuItemId, name: line.name.slice(0, 200), qty: line.qty });
  };
  const removeLine = (key: string) => {
    const line = lines.find((l) => l.key === key);
    setLines((ls) => ls.filter((l) => l.key !== key));
    if (line) track('cart.item_removed', { menu_item_id: line.menuItemId, name: line.name.slice(0, 200) });
  };
  const setQty = (key: string, qty: number) => {
    if (qty < 1) return removeLine(key);
    setLines((ls) => ls.map((l) => (l.key === key ? { ...l, qty: Math.min(99, qty) } : l)));
  };

  const goCheckout = () => {
    setStep('checkout');
    track('checkout.started', { channel, item_count: Math.max(1, itemCount) });
    window.setTimeout(() => checkoutRef.current?.focus(), 50);
  };

  const changeAddress = (a: DeliveryAddress) => {
    setAddress(a);
    setQuote(null);
    setQuoteError(null);
  };

  const checkAddress = async () => {
    setQuoting(true);
    setQuoteError(null);
    const r = await api<{ deliveryId: string; feeCents: number; dropoffEta: string | null; zoneName: string }>('/api/delivery/quote', {
      body: {
        venueId: venue.id,
        address: { line1: address.line1, line2: address.line2 || null, suburb: address.suburb, state: address.state, postcode: address.postcode, lat: address.lat, lng: address.lng },
        notes: courierNotes.trim() || null,
        subtotalCents: priced?.subtotalCents ?? 0,
        containsAlcohol: priced?.lines.some((l) => l.isAlcohol) ?? false,
      },
    });
    setQuoting(false);
    if (r.ok) setQuote(r.data);
    else {
      setQuote(null);
      setQuoteError(r.error.issues?.[0]?.message ? 'Fill in the street address, suburb, state and postcode.' : r.error.message);
    }
  };

  const addCode = (raw: string) => {
    const c = raw.trim();
    if (!c || codes.some((x) => x.toLowerCase() === c.toLowerCase())) return;
    setCodes((cs) => [...cs, c].slice(-5));
    setCodeInput('');
  };

  const consents = useMemo(() => [...props.consents].sort((a, b) => CONSENT_ORDER.indexOf(a.purpose) - CONSENT_ORDER.indexOf(b.purpose)), [props.consents]);

  const pay = async (token: string, trackingToken: string) => {
    setPayMessage({ tone: 'info', text: 'Taking payment…' });
    const r = await api<{ status: 'paid' | 'declined' | 'retry'; message?: string; trackingToken?: string }>('/api/pay', { body: { trackingToken, sourceToken: token } });
    if (!r.ok) {
      setPayMessage({ tone: 'error', text: r.error.message });
      return false;
    }
    if (r.data.status === 'paid') {
      setLines([]);
      saveCart(storageKey, []);
      router.push(`/order/t/${encodeURIComponent(r.data.trackingToken ?? trackingToken)}`);
      return true;
    }
    if (r.data.status === 'declined') {
      setCard(null);
      setPayMessage({ tone: 'error', text: `${r.data.message ?? 'The card was declined.'} Your order is saved; choose another card.` });
    } else {
      setPayMessage({ tone: 'error', text: r.data.message ?? 'The card processor did not answer.', retry: true });
    }
    return false;
  };

  const placeAndPay = async () => {
    if (!priced?.orderable) return;
    if (channel === 'delivery' && !quote) {
      setCheckoutError({ message: 'Check your delivery address first.' });
      return;
    }
    if (!card && priced.totalCents > 0) {
      setCheckoutError({ message: 'Choose a card to pay with.' });
      return;
    }
    setPlacing(true);
    setCheckoutError(null);
    let current = order;
    if (!current) {
      const r = await api<{ trackingToken: string; reference: string; totalCents: number }>('/api/order', {
        body: {
          venueId: venue.id,
          channel,
          lines: toCartInput(lines),
          codes,
          tipCents,
          slotStart: channel === 'pickup' && slot !== 'asap' ? slot : null,
          deliveryId: channel === 'delivery' ? quote?.deliveryId : undefined,
          idempotencyKey: idempotencyKey.current,
          customer: { name: name.trim() || null, email: email.trim() || null, phone: phone.trim() || null },
          note: note.trim() || null,
          consents: consents.filter((c) => ticked[c.purpose]).map((c) => ({ purpose: c.purpose, wordingVersion: c.version })),
          flags: joinLoyalty ? ['loyalty_join'] : [],
        },
      });
      if (!r.ok) {
        setPlacing(false);
        setCheckoutError({ message: r.error.message, issues: r.error.issues?.map((i) => i.message).filter((m) => m && m !== r.error.message) });
        return;
      }
      current = r.data;
      setOrder(r.data);
    }
    await pay(card?.token ?? '', current.trackingToken);
    setPlacing(false);
  };

  const changeOrder = async () => {
    if (!order) return;
    setPlacing(true);
    const r = await api('/api/order/cancel', { body: { trackingToken: order.trackingToken } });
    setPlacing(false);
    if (!r.ok) {
      setPayMessage({ tone: 'error', text: r.error.message });
      return;
    }
    setOrder(null);
    setPayMessage(null);
    // A delivery quote belongs to the order that used it: check the address again for a new one.
    setQuote(null);
    idempotencyKey.current = newKey();
  };

  const currency = data.currency;
  const lineIssues = (i: number) => priced?.issues.filter((x) => x.lineIndex === i) ?? [];
  const generalIssues = priced?.issues.filter((x) => x.lineIndex === undefined) ?? [];
  const locked = !!order;
  const needsCard = (priced?.totalCents ?? 0) > 0;
  const today = board?.dates[0] ?? '';

  const itemButton = (i: Item) => {
    const barOnly = props.excludeAlcohol && i.isAlcohol;
    if (!i.isAvailable) return <span className="s-pill font-semibold">Sold out</span>;
    if (barOnly) return <span className="text-sm font-semibold">Order from our staff</span>;
    return (
      <button type="button" className="s-btn-outline px-4" onClick={() => setOpen(i)} aria-label={`Add ${i.name}`} disabled={locked}>
        Add
      </button>
    );
  };

  return (
    <div className="mx-auto grid max-w-6xl gap-8 px-4 pt-6 pb-32 sm:px-6 lg:grid-cols-[minmax(0,1fr)_24rem] lg:pb-16" data-order-venue={venue.id} data-channel={channel}>
      {/* ── Menu ── */}
      <div className={cx('space-y-8', step === 'checkout' && 'hidden lg:block')}>
        {data.menus.length === 0 ? <p className="s-notice">The kitchen is not serving right now, so there is nothing to order. Check our hours.</p> : null}
        {data.menus.map((m) => (
          <section key={m.id} aria-labelledby={`om-${m.id}`} className="space-y-6">
            <h2 id={`om-${m.id}`} className={data.menus.length > 1 ? 's-heading' : 'sr-only'}>
              {m.name}
            </h2>
            <nav aria-label="Sections" className="flex flex-wrap gap-2">
              {m.sections.map((s) => (
                <a key={s.id} href={`#os-${s.id}`} className="s-pill no-underline hover:underline">
                  {s.name}
                </a>
              ))}
            </nav>
            {m.sections.map((s) => (
              <section key={s.id} id={`os-${s.id}`} aria-labelledby={`os-${s.id}-h`} className="scroll-mt-24">
                <h3 id={`os-${s.id}-h`} className="s-heading border-b-2 pb-2" style={{ borderColor: 'var(--brand-color-text)' }}>
                  {s.name}
                </h3>
                <ul>
                  {s.items.map((i) => (
                    <li key={i.id} className="flex items-start justify-between gap-4 border-b py-4 s-rule" data-order-item={i.name}>
                      <div className="min-w-0 space-y-1">
                        <p className={cx('font-semibold', !i.isAvailable && 'line-through')}>{i.name}</p>
                        {i.description ? <p className="s-muted text-sm">{i.description}</p> : null}
                        {i.dietaryTags.length ? <p className="text-sm">{i.dietaryTags.map(dietLabel).join(' · ')}</p> : null}
                        <p className="text-sm">
                          <span className="font-semibold">Allergens:</span> {i.allergens.length ? i.allergens.join(', ') : 'none listed'}
                        </p>
                      </div>
                      <div className="flex shrink-0 flex-col items-end gap-2">
                        {showPrices ? <span className="s-tabular font-semibold">{money(i.priceCents, currency)}</span> : null}
                        {itemButton(i)}
                      </div>
                    </li>
                  ))}
                </ul>
              </section>
            ))}
          </section>
        ))}
      </div>

      {/* ── Cart and checkout ── */}
      <div className={cx('lg:sticky lg:top-24 lg:self-start', step === 'menu' && 'hidden lg:block')}>
        <div ref={checkoutRef} tabIndex={-1} className="s-card space-y-5 p-5 outline-none" aria-labelledby="cart-h">
          <div className="flex items-center justify-between gap-3">
            <h2 id="cart-h" className="s-heading text-2xl">
              Your order
            </h2>
            {step === 'checkout' ? (
              <button type="button" className="s-btn-quiet lg:hidden" onClick={() => setStep('menu')}>
                Back to the menu
              </button>
            ) : null}
          </div>
          <p className="text-sm">
            {channel === 'dine-in-qr' ? `To your table${props.table?.label ? `: ${props.table.label}` : ''}, at ${venue.name}.` : channel === 'delivery' ? `Delivered from ${venue.name}.` : `Pickup from ${venue.name}.`}
          </p>

          {!loaded ? (
            <p className="text-sm">Loading your order…</p>
          ) : !lines.length ? (
            <p>Nothing here yet. Add something from the menu.</p>
          ) : (
            <ul className="divide-y divide-[var(--brand-color-border)]" aria-label="Items">
              {lines.map((l, i) => {
                const p = priced?.lines[i];
                return (
                  <li key={l.key} className="py-3" data-cart-line={l.name}>
                    <div className="flex items-start justify-between gap-3">
                      <div className="min-w-0">
                        <p className="font-semibold">{l.name}</p>
                        {(p?.modifiers.map((m) => m.name) ?? l.modifierNames).length ? <p className="text-sm">{(p?.modifiers.map((m) => m.name) ?? l.modifierNames).join(', ')}</p> : null}
                        {l.note ? <p className="text-sm">Note: {l.note}</p> : null}
                      </div>
                      {p && showPrices ? <span className="s-tabular">{money(p.lineTotalCents, currency)}</span> : null}
                    </div>
                    <div className="mt-2 flex items-center gap-2">
                      <button type="button" className="s-btn-outline min-h-9 px-3" onClick={() => setQty(l.key, l.qty - 1)} disabled={locked} aria-label={`One fewer ${l.name}`}>
                        −
                      </button>
                      <span className="s-tabular min-w-6 text-center">{l.qty}</span>
                      <button type="button" className="s-btn-outline min-h-9 px-3" onClick={() => setQty(l.key, l.qty + 1)} disabled={locked} aria-label={`One more ${l.name}`}>
                        +
                      </button>
                      <button type="button" className="s-btn-quiet ml-auto text-sm" onClick={() => removeLine(l.key)} disabled={locked}>
                        Remove
                      </button>
                    </div>
                    {lineIssues(i).map((x) => (
                      <p key={x.message} role="alert" className="s-notice mt-2 text-sm" data-tone="error">
                        {x.message}
                      </p>
                    ))}
                  </li>
                );
              })}
            </ul>
          )}

          {priceError ? (
            <div role="alert" className="s-notice space-y-2" data-tone="error">
              <p>{priceError}</p>
              <button type="button" className="s-btn-quiet px-0" onClick={() => setLines([])} disabled={locked}>
                Empty the order and start again
              </button>
            </div>
          ) : null}
          {generalIssues.map((x) => (
            <p key={x.message} role="alert" className="s-notice" data-tone="error">
              {x.message}
            </p>
          ))}

          {priced && lines.length ? (
            <dl className="space-y-1 border-t pt-3 s-rule s-tabular" aria-live="polite">
              <div className="flex justify-between">
                <dt>Subtotal</dt>
                <dd>{money(priced.subtotalCents, currency)}</dd>
              </div>
              {priced.adjustments.map((a) => (
                <div key={a.code} className="flex justify-between gap-3">
                  <dt>{a.label}</dt>
                  <dd>−{money(a.amountCents, currency)}</dd>
                </div>
              ))}
              {channel === 'delivery' ? (
                <div className="flex justify-between" data-delivery-fee={quote && priced.channel === 'delivery' ? priced.deliveryFeeCents : ''}>
                  <dt>Delivery</dt>
                  <dd>{!quote ? 'Check your address' : priced.channel !== 'delivery' ? 'Working it out…' : priced.deliveryFeeCents ? money(priced.deliveryFeeCents, currency) : 'Free'}</dd>
                </div>
              ) : null}
              {priced.tipCents ? (
                <div className="flex justify-between">
                  <dt>Tip</dt>
                  <dd>{money(priced.tipCents, currency)}</dd>
                </div>
              ) : null}
              <div className="flex justify-between text-lg font-semibold">
                <dt>Total</dt>
                <dd data-total>{money(priced.totalCents, currency)}</dd>
              </div>
              <div className="flex justify-between text-sm">
                <dt>{priced.taxInclusive ? 'Includes GST of' : 'GST'}</dt>
                <dd>{money(priced.taxCents, currency)}</dd>
              </div>
            </dl>
          ) : null}

          {step === 'menu' ? (
            <button type="button" className="s-btn hidden w-full lg:inline-flex" onClick={goCheckout} disabled={!lines.length}>
              Go to checkout
            </button>
          ) : (
            <form
              className="space-y-6 border-t pt-5 s-rule"
              onSubmit={(e) => {
                e.preventDefault();
                void placeAndPay();
              }}
              aria-labelledby="checkout-h"
              noValidate
            >
              <h3 id="checkout-h" className="s-heading text-xl">
                Checkout
              </h3>
              <fieldset disabled={locked} className="space-y-6">
                {props.channel === 'pickup' && props.delivery ? (
                  <fieldset className="space-y-2">
                    <legend className="font-semibold">How would you like it?</legend>
                    <div className="flex flex-wrap gap-2">
                      {(props.pickupEnabled ? (['pickup', 'delivery'] as const) : (['delivery'] as const)).map((f) => (
                        <label key={f} className="s-pill cursor-pointer gap-2 py-2 has-[:checked]:border-[var(--brand-color-text)] has-[:checked]:font-semibold">
                          <input type="radio" name="fulfilment" value={f} className="s-check mt-0" checked={fulfilment === f} onChange={() => setFulfilment(f)} />
                          {f === 'pickup' ? 'Pickup' : 'Delivery'}
                        </label>
                      ))}
                    </div>
                  </fieldset>
                ) : null}
                {channel === 'delivery' && props.delivery ? (
                  <div className="space-y-3">
                    <AddressPicker value={address} onChange={changeAddress} notes={courierNotes} onNotes={(n) => { setCourierNotes(n); setQuote(null); }} testAddresses={props.delivery.testAddresses} />
                    <button type="button" className="s-btn-outline" onClick={checkAddress} disabled={quoting || !lines.length} aria-busy={quoting}>
                      {quoting ? 'Checking…' : quote ? 'Check again' : 'Check this address'}
                    </button>
                    {quoteError ? (
                      <p role="alert" className="s-notice" data-tone="error">
                        {quoteError}
                      </p>
                    ) : null}
                    {quote ? (
                      <p role="status" className="s-notice" data-tone="success" data-quote={quote.deliveryId}>
                        We deliver there ({quote.zoneName}).{quote.dropoffEta ? ` Expected at about ${timeLabel(quote.dropoffEta, venue.timezone)}.` : ''} The delivery fee is in your total.
                      </p>
                    ) : null}
                  </div>
                ) : null}
                {channel === 'pickup' ? (
                  <fieldset className="space-y-2">
                    <legend className="font-semibold">When</legend>
                    {!board ? (
                      <p className="text-sm">Finding pickup times…</p>
                    ) : (
                      <>
                        {board.dates.length > 1 ? (
                          <label className="block space-y-1">
                            <span className="text-sm">Day</span>
                            <select className="s-select" value={date ?? board.date} onChange={(e) => setDate(e.target.value)}>
                              {board.dates.map((d) => (
                                <option key={d} value={d}>
                                  {dayLabel(d, board.timezone, today)}
                                </option>
                              ))}
                            </select>
                          </label>
                        ) : null}
                        {(date ?? board.date) === today ? (
                          <label className="flex min-h-11 items-center gap-3">
                            <input type="radio" name="when" className="s-check mt-0" checked={slot === 'asap'} disabled={!board.asap.available} onChange={() => setSlot('asap')} />
                            <span>
                              {board.asap.available ? `As soon as possible (about ${board.asap.estimateMinutes} min)` : 'As soon as possible'}
                              {!board.asap.available && board.asap.reason ? <span className="block text-sm">{board.asap.reason}</span> : null}
                            </span>
                          </label>
                        ) : null}
                        <label className="block space-y-1">
                          <span className="text-sm">Or choose a time</span>
                          <select className="s-select" value={slot === 'asap' ? '' : slot} onChange={(e) => setSlot(e.target.value || 'asap')} aria-label="Pickup time">
                            <option value="">{board.slots.length ? 'Choose a time' : 'No times left on this day'}</option>
                            {board.slots.map((s) => (
                              <option key={s.start} value={s.start}>
                                {timeLabel(s.start, board.timezone)}
                              </option>
                            ))}
                          </select>
                        </label>
                      </>
                    )}
                  </fieldset>
                ) : null}

                {props.promoCodesEnabled ? (
                  <div className="space-y-2">
                    <label htmlFor="code" className="block font-semibold">
                      Offer or promo code
                    </label>
                    <div className="flex gap-2">
                      <input
                        id="code"
                        className="s-input"
                        value={codeInput}
                        autoCapitalize="characters"
                        onChange={(e) => setCodeInput(e.target.value)}
                        onKeyDown={(e) => {
                          if (e.key === 'Enter') {
                            e.preventDefault();
                            addCode(codeInput);
                          }
                        }}
                      />
                      <button type="button" className="s-btn-outline" onClick={() => addCode(codeInput)}>
                        Apply
                      </button>
                    </div>
                    {codes.length ? (
                      <ul className="flex flex-wrap gap-2" aria-label="Codes">
                        {codes.map((c) => (
                          <li key={c} className="s-pill gap-2">
                            {c.startsWith('REWARD-') ? (props.loyalty?.rewards.find((r) => r.code === c)?.name ?? 'Reward') : c}
                            <button type="button" className="underline" onClick={() => setCodes((cs) => cs.filter((x) => x !== c))} aria-label={`Remove code ${c}`}>
                              remove
                            </button>
                          </li>
                        ))}
                      </ul>
                    ) : null}
                    {priced?.rejectedCodes.map((r) => (
                      <p key={r.code} role="alert" className="s-notice text-sm" data-tone="error">
                        {r.code.startsWith('REWARD-') ? 'That reward' : r.code}: {r.reason}
                      </p>
                    ))}
                  </div>
                ) : null}

                {props.loyalty?.member && props.loyalty.rewards.length ? (
                  <fieldset className="space-y-2">
                    <legend className="font-semibold">Use your points ({props.loyalty.member.available} available)</legend>
                    <ul className="space-y-2">
                      {props.loyalty.rewards.map((r) => (
                        <li key={r.code} className="flex items-center justify-between gap-3 text-sm">
                          <span>
                            {r.name} <span className="block">{r.costPoints} points{r.blockedReason ? ` · ${r.blockedReason}` : !r.canAfford ? ' · not enough points yet' : ''}</span>
                          </span>
                          <button type="button" className="s-btn-outline min-h-9 px-3" disabled={!r.canAfford || !!r.blockedReason || codes.includes(r.code)} onClick={() => addCode(r.code)}>
                            {codes.includes(r.code) ? 'Added' : 'Use'}
                          </button>
                        </li>
                      ))}
                    </ul>
                  </fieldset>
                ) : null}

                {priced?.tipping.enabled ? (
                  <fieldset className="space-y-2">
                    <legend className="font-semibold">Add a tip for the team?</legend>
                    <div className="flex flex-wrap gap-2">
                      {[0, ...priced.tipping.presets].map((p) => (
                        <label key={p} className="s-pill cursor-pointer gap-2 py-2 has-[:checked]:font-semibold has-[:checked]:border-[var(--brand-color-text)]">
                          <input type="radio" name="tip" className="s-check mt-0" checked={tipPercent === p} onChange={() => setTipPercent(p)} />
                          {p === 0 ? 'No tip' : `${p}%`}
                        </label>
                      ))}
                    </div>
                  </fieldset>
                ) : null}

                <fieldset className="space-y-3">
                  <legend className="font-semibold">Your details</legend>
                  {!props.guest ? (
                    <p className="text-sm">
                      Been here before?{' '}
                      <a href={props.signInHref} className="s-link">
                        Sign in
                      </a>{' '}
                      to use your points and see your orders.
                    </p>
                  ) : null}
                  <label className="block space-y-1">
                    <span>Name{channel === 'dine-in-qr' ? ' (optional)' : ''}</span>
                    <input className="s-input" name="name" autoComplete="name" value={name} onChange={(e) => setName(e.target.value)} required={channel !== 'dine-in-qr'} />
                  </label>
                  <label className="block space-y-1">
                    <span>Email{channel === 'dine-in-qr' ? ' (optional, for your receipt)' : ''}</span>
                    <input className="s-input" name="email" type="email" autoComplete="email" inputMode="email" value={email} onChange={(e) => setEmail(e.target.value)} />
                  </label>
                  <label className="block space-y-1">
                    <span>Mobile{channel === 'pickup' ? ' (or give an email)' : channel === 'delivery' ? ' (so the courier can reach you)' : ' (optional)'}</span>
                    <input className="s-input" name="phone" type="tel" autoComplete="tel" inputMode="tel" value={phone} onChange={(e) => setPhone(e.target.value)} />
                  </label>
                  {channel !== 'dine-in-qr' ? <p className="text-sm">We use these to tell you when your order is ready and to send your receipt. Nothing else unless you tick a box below.</p> : props.prompts.receiptEmail ? <p className="text-sm">Add an email and we will send your receipt. That is all we will send unless you tick a box below.</p> : null}
                  <label className="block space-y-1">
                    <span>Note for the venue (optional)</span>
                    <textarea className="s-textarea" name="note" maxLength={500} value={note} onChange={(e) => setNote(e.target.value)} />
                  </label>
                </fieldset>

                {props.loyalty?.joinable && (channel !== 'dine-in-qr' || props.prompts.loyalty) ? (
                  <label className="flex items-start gap-3">
                    <input type="checkbox" className="s-check" checked={joinLoyalty} onChange={(e) => setJoinLoyalty(e.target.checked)} name="loyalty_join" />
                    <span>
                      <span className="font-semibold">Join {props.loyalty.programName}</span>
                      <span className="block text-sm">Earn points on this order and every visit. Needs an email or mobile above.</span>
                    </span>
                  </label>
                ) : null}

                {consents.length ? (
                  <fieldset className="space-y-3" data-consents>
                    <legend className="font-semibold">Optional. You can order without ticking any of these.</legend>
                    {consents.map((c) => (
                      <label key={c.purpose} className="flex items-start gap-3" data-consent={c.purpose} data-wording-version={c.version}>
                        <input type="checkbox" className="s-check" name={`consent_${c.purpose}`} checked={!!ticked[c.purpose]} onChange={(e) => setTicked((t) => ({ ...t, [c.purpose]: e.target.checked }))} />
                        <span>
                          <span className="block font-semibold">{CONSENT_TITLES[c.purpose] ?? c.purpose}</span>
                          <span className="block text-sm">{c.body}</span>
                        </span>
                      </label>
                    ))}
                  </fieldset>
                ) : null}
              </fieldset>

              {needsCard || !priced ? <CardPicker payment={props.payment} value={card} onChange={setCard} disabled={placing} /> : null}

              {checkoutError ? (
                <div role="alert" className="s-notice space-y-1" data-tone="error">
                  <p>{checkoutError.message}</p>
                  {checkoutError.issues?.map((m) => (
                    <p key={m}>{m}</p>
                  ))}
                </div>
              ) : null}
              {order ? (
                <p className="s-notice text-sm" role="status">
                  Order {order.reference} is saved and waiting for payment. Nothing has gone to the kitchen yet.
                </p>
              ) : null}
              {payMessage ? (
                <div role={payMessage.tone === 'error' ? 'alert' : 'status'} className="s-notice" data-tone={payMessage.tone === 'error' ? 'error' : undefined}>
                  <p>{payMessage.text}</p>
                </div>
              ) : null}

              {priced?.rejectedCodes.length && !order ? <p className="text-sm">Remove the code that does not work to place your order.</p> : null}
              <div className="flex flex-col gap-3">
                <button type="submit" className="s-btn w-full" disabled={placing || !priced?.orderable || !!priced?.rejectedCodes.length || !lines.length || (needsCard && !props.payment) || (channel === 'delivery' && (!quote || priced?.channel !== 'delivery'))} aria-busy={placing}>
                  {placing ? 'Working…' : payMessage?.retry ? 'Try the same card again' : order ? `Pay ${money(order.totalCents, currency)}` : `Place order and pay${priced ? ` ${money(priced.totalCents, currency)}` : ''}`}
                </button>
                {order ? (
                  <button type="button" className="s-btn-quiet" onClick={changeOrder} disabled={placing}>
                    Change my order (cancels this unpaid order)
                  </button>
                ) : null}
              </div>
            </form>
          )}
        </div>
      </div>

      {/* A bar at the bottom of the phone screen with the order so far. */}
      {step === 'menu' && lines.length ? (
        <div className="fixed inset-x-0 bottom-0 z-40 border-t p-3 lg:hidden s-rule" style={{ background: 'var(--brand-color-surface)' }}>
          <button type="button" className="s-btn w-full justify-between" onClick={goCheckout}>
            <span>
              View order ({itemCount} {itemCount === 1 ? 'item' : 'items'})
            </span>
            {priced && showPrices ? <span className="s-tabular">{money(priced.totalCents, currency)}</span> : null}
          </button>
        </div>
      ) : null}

      {open ? <ItemDialog key={open.id} item={open} currency={currency} showPrices={showPrices} onClose={() => setOpen(null)} onAdd={addLine} check={checkLine} /> : null}
    </div>
  );
}
