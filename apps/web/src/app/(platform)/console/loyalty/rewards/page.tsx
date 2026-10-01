import { loyalty } from '@ros/modules';
import { getConsole } from '@/lib/console';
import { read } from '@/lib/console-read';
import { ReadError } from '@/components/console/states';
import { ActionForm, Badge, Card, Checkbox, Dialog, EmptyState, Field, Input, Select, SubmitButton, Table, Td, Textarea, Th, money } from '@/ui';
import { saveRewardAction } from '../actions';
import { LoyaltyFrame, loyaltyRoles } from '../shared';

export const metadata = { title: 'Rewards · Pipedline' };

const DAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];

function what(r: loyalty.RewardView, currency: string): string {
  const off = r.kind === 'fixed' ? `${money(r.valueCents, currency)} off` : r.kind === 'percent' ? `${r.percentOff}% off` : 'A free item';
  return r.minSpendCents ? `${off} when spending ${money(r.minSpendCents, currency)} or more` : off;
}

export default async function RewardsPage() {
  const c = await getConsole();
  const { manager } = loyaltyRoles(c);
  const r = await read((ctx) => loyalty.listRewards(ctx, { includeInactive: manager }));
  return (
    <LoyaltyFrame c={c} current="/console/loyalty/rewards" title="Rewards" description="What members can spend their points on. Offered at every venue unless limited.">
      {!r.ok ? (
        <ReadError message={r.error} />
      ) : r.data.length === 0 ? (
        <EmptyState title="No rewards yet">{manager ? 'Add the first one below.' : 'A manager can add rewards.'}</EmptyState>
      ) : (
        <Card padded={false}>
          <Table>
            <thead>
              <tr>
                <Th>Reward</Th>
                <Th>Gives</Th>
                <Th align="right">Points</Th>
                <Th>Limits</Th>
                <Th>Status</Th>
                {manager ? <Th /> : null}
              </tr>
            </thead>
            <tbody>
              {r.data.map((w) => (
                <tr key={w.id}>
                  <Td>
                    <span className="font-medium">{w.name}</span>
                    {w.description ? <span className="block text-xs text-ink-3">{w.description}</span> : null}
                  </Td>
                  <Td>{what(w, c.org.currency)}</Td>
                  <Td numeric>{w.costPoints.toLocaleString('en-AU')}</Td>
                  <Td className="text-xs text-ink-2">
                    {[
                      w.validDays ? w.validDays.map((d) => DAYS[d]).join(', ') : null,
                      w.validVenueIds ? w.validVenueIds.map((id) => c.venues.find((v) => v.id === id)?.name ?? 'another venue').join(', ') : null,
                      w.maxRedemptionsPerCustomer ? `${w.maxRedemptionsPerCustomer} per guest` : null,
                    ]
                      .filter(Boolean)
                      .join(' · ') || 'None'}
                  </Td>
                  <Td>{w.isActive ? <Badge tone="good">Offered</Badge> : <Badge>Off</Badge>}</Td>
                  {manager ? (
                    <Td align="right">
                      <Dialog trigger="Edit" title={`Edit ${w.name}`}>
                        <RewardForm reward={w} c={c} />
                      </Dialog>
                    </Td>
                  ) : null}
                </tr>
              ))}
            </tbody>
          </Table>
        </Card>
      )}
      {manager ? (
        <Card title="Add a reward" className="mt-6">
          <RewardForm c={c} />
        </Card>
      ) : null}
    </LoyaltyFrame>
  );
}

function RewardForm({ reward: w, c }: { reward?: loyalty.RewardView; c: Awaited<ReturnType<typeof getConsole>> }) {
  return (
    <ActionForm action={saveRewardAction} className="space-y-4" resetOnSuccess={!w}>
      {w ? <input type="hidden" name="id" value={w.id} /> : null}
      <div className="grid gap-4 sm:grid-cols-2">
        <Field label="Name">
          <Input name="name" required maxLength={120} defaultValue={w?.name ?? ''} />
        </Field>
        <Field label="Costs (points)">
          <Input name="costPoints" type="number" min={1} required defaultValue={w?.costPoints ?? ''} />
        </Field>
        <Field label="Gives">
          <Select name="kind" defaultValue={w?.kind ?? 'fixed'}>
            <option value="fixed">Dollars off</option>
            <option value="percent">Percentage off</option>
            <option value="free_item">A free item</option>
          </Select>
        </Field>
        <Field label="Dollars off, or the free item's value" hint="e.g. 10.00">
          <Input name="value" inputMode="decimal" defaultValue={w?.valueCents ? (w.valueCents / 100).toFixed(2) : ''} />
        </Field>
        <Field label="Percentage off" hint="For a percentage reward.">
          <Input name="percentOff" type="number" min={1} max={100} defaultValue={w?.percentOff ?? ''} />
        </Field>
        <Field label="Minimum spend" hint="Dollars; leave empty for none.">
          <Input name="minSpend" inputMode="decimal" defaultValue={w?.minSpendCents ? (w.minSpendCents / 100).toFixed(2) : ''} />
        </Field>
        <Field label="Most times per guest" hint="Leave empty for no limit.">
          <Input name="maxPerCustomer" type="number" min={1} defaultValue={w?.maxRedemptionsPerCustomer ?? ''} />
        </Field>
      </div>
      <Field label="Description">
        <Textarea name="description" maxLength={1000} defaultValue={w?.description ?? ''} />
      </Field>
      <fieldset>
        <legend className="mb-1 text-sm font-medium">Days it can be used</legend>
        <div className="flex flex-wrap gap-3">
          {DAYS.map((d, i) => (
            <Checkbox key={d} name="validDays" value={String(i)} label={d} defaultChecked={!w?.validDays || w.validDays.includes(i)} />
          ))}
        </div>
      </fieldset>
      {c.venues.length > 1 ? (
        <fieldset>
          <legend className="mb-1 text-sm font-medium">Venues</legend>
          <p className="mb-2 text-xs text-ink-3">Tick none for every venue.</p>
          <div className="flex flex-wrap gap-3">
            {c.venues.map((v) => (
              <Checkbox key={v.id} name="validVenueIds" value={v.id} label={v.name} defaultChecked={!!w?.validVenueIds?.includes(v.id)} />
            ))}
          </div>
        </fieldset>
      ) : null}
      <Checkbox name="isActive" label="Offered to members" defaultChecked={w ? w.isActive : true} />
      <SubmitButton>{w ? 'Save reward' : 'Add reward'}</SubmitButton>
    </ActionForm>
  );
}
