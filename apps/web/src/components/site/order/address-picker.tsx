'use client';

import { useState } from 'react';

export interface DeliveryAddress {
  line1: string;
  line2: string;
  suburb: string;
  state: string;
  postcode: string;
  lat: number | null;
  lng: number | null;
}

export interface TestAddress extends DeliveryAddress {
  label: string;
}

export const EMPTY_ADDRESS: DeliveryAddress = { line1: '', line2: '', suburb: '', state: 'NSW', postcode: '', lat: null, lng: null };

/**
 * Where to deliver. The delivery module needs the address as text (for the courier) and as a
 * point (to check it is inside a delivery zone), so the point has to come from somewhere real:
 *
 *   - with simulated providers (development and tests), a few test addresses around the venue;
 *   - otherwise the device's own location, when the guest is ordering to where they are.
 *
 * SEAM: an address autocomplete (the provider's hosted suggestions) mounts in place of the
 * location button and hands back { line1, suburb, state, postcode, lat, lng }. Not built yet.
 */
export function AddressPicker({
  value,
  onChange,
  notes,
  onNotes,
  testAddresses,
  disabled,
}: {
  value: DeliveryAddress;
  onChange: (a: DeliveryAddress) => void;
  notes: string;
  onNotes: (n: string) => void;
  testAddresses: TestAddress[] | null;
  disabled?: boolean;
}) {
  const [locating, setLocating] = useState<string | null>(null);
  const set = (patch: Partial<DeliveryAddress>) => onChange({ ...value, ...patch });

  const locate = () => {
    if (!('geolocation' in navigator)) return setLocating('This browser cannot share its location.');
    setLocating('Finding where you are…');
    navigator.geolocation.getCurrentPosition(
      (pos) => {
        set({ lat: pos.coords.latitude, lng: pos.coords.longitude });
        setLocating('Location added. Check the address above is where you are.');
      },
      () => setLocating('We could not get your location. Allow it in your browser, then try again.'),
      { enableHighAccuracy: true, timeout: 10_000 },
    );
  };

  return (
    <fieldset disabled={disabled} className="space-y-3" data-address-picker={testAddresses ? 'sim' : 'device'}>
      <legend className="font-semibold">Deliver to</legend>
      {testAddresses ? (
        <label className="block space-y-1">
          <span className="text-sm">Development mode: choose a test address</span>
          <select
            className="s-select"
            aria-label="Test address"
            value={testAddresses.find((t) => t.line1 === value.line1 && t.lat === value.lat)?.label ?? ''}
            onChange={(e) => {
              const t = testAddresses.find((x) => x.label === e.target.value);
              if (t) onChange({ line1: t.line1, line2: t.line2, suburb: t.suburb, state: t.state, postcode: t.postcode, lat: t.lat, lng: t.lng });
            }}
          >
            <option value="">Choose…</option>
            {testAddresses.map((t) => (
              <option key={t.label} value={t.label}>
                {t.label}
              </option>
            ))}
          </select>
        </label>
      ) : null}
      <label className="block space-y-1">
        <span>Street address</span>
        <input className="s-input" name="address-line1" autoComplete="address-line1" value={value.line1} onChange={(e) => set({ line1: e.target.value })} maxLength={200} />
      </label>
      <label className="block space-y-1">
        <span>Unit, level or building (optional)</span>
        <input className="s-input" name="address-line2" autoComplete="address-line2" value={value.line2} onChange={(e) => set({ line2: e.target.value })} maxLength={200} />
      </label>
      <div className="grid grid-cols-[1fr_5rem_6rem] gap-2">
        <label className="block space-y-1">
          <span>Suburb</span>
          <input className="s-input" name="suburb" autoComplete="address-level2" value={value.suburb} onChange={(e) => set({ suburb: e.target.value })} maxLength={100} />
        </label>
        <label className="block space-y-1">
          <span>State</span>
          <input className="s-input" name="state" autoComplete="address-level1" value={value.state} onChange={(e) => set({ state: e.target.value })} maxLength={40} />
        </label>
        <label className="block space-y-1">
          <span>Postcode</span>
          <input className="s-input" name="postcode" autoComplete="postal-code" inputMode="numeric" value={value.postcode} onChange={(e) => set({ postcode: e.target.value })} maxLength={10} />
        </label>
      </div>
      {!testAddresses ? (
        <div className="space-y-1">
          <button type="button" className="s-btn-outline" onClick={locate}>
            {value.lat !== null ? 'Location added: update it' : 'Use my current location'}
          </button>
          <p className="text-sm" role="status">
            {locating ?? 'We use your location only to check you are inside our delivery area.'}
          </p>
        </div>
      ) : null}
      <label className="block space-y-1">
        <span>Note for the courier (optional)</span>
        <input className="s-input" name="delivery-notes" value={notes} onChange={(e) => onNotes(e.target.value)} maxLength={280} placeholder="e.g. buzz 4, second floor" />
      </label>
    </fieldset>
  );
}
