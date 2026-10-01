'use client';

import { useState } from 'react';

/** The points to add or remove, with the resulting balance spelled out before anyone confirms. */
export function AdjustFields({ balance, available }: { balance: number; available: number }) {
  const [direction, setDirection] = useState<'add' | 'remove'>('add');
  const [amount, setAmount] = useState('');
  const n = Math.abs(Math.trunc(Number(amount) || 0));
  const after = direction === 'add' ? balance + n : balance - n;
  const control = 'block h-10 w-full rounded-md border border-line-strong bg-surface px-3 text-sm text-ink';
  return (
    <div className="space-y-3">
      <div className="grid grid-cols-2 gap-3">
        <label className="block">
          <span className="mb-1 block text-sm font-medium text-ink">Change</span>
          <select name="direction" value={direction} onChange={(e) => setDirection(e.currentTarget.value as 'add' | 'remove')} className={control}>
            <option value="add">Add points</option>
            <option value="remove">Remove points</option>
          </select>
        </label>
        <label className="block">
          <span className="mb-1 block text-sm font-medium text-ink">Points</span>
          <input name="points" type="number" min={1} max={direction === 'remove' ? Math.max(1, available) : 10_000_000} step={1} required value={amount} onChange={(e) => setAmount(e.currentTarget.value)} className={control} />
        </label>
      </div>
      <p className="rounded-md bg-sunken px-3 py-2 text-sm text-ink" role="status" data-testid="adjust-preview">
        {n
          ? `${direction === 'add' ? 'Adds' : 'Removes'} ${n.toLocaleString('en-AU')} points: the balance goes from ${balance.toLocaleString('en-AU')} to ${after.toLocaleString('en-AU')}.`
          : `The balance is ${balance.toLocaleString('en-AU')} points (${available.toLocaleString('en-AU')} free to spend).`}
      </p>
    </div>
  );
}
