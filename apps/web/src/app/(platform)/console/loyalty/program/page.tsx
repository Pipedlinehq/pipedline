import { loyalty } from '@ros/modules';
import { getConsole } from '@/lib/console';
import { read } from '@/lib/console-read';
import { ConfirmAction } from '@/components/console/confirm';
import { NotForYourRole, ReadError } from '@/components/console/states';
import { ActionForm, Card, Checkbox, Field, Input, Select, SubmitButton, Table, Td, Textarea, Th } from '@/ui';
import { deleteTierAction, saveProgramAction, saveTierAction } from '../actions';
import { LoyaltyFrame, loyaltyRoles } from '../shared';

export const metadata = { title: 'Loyalty programme · Pipedline' };

/** How points are earned and what they are worth, and the tiers. Org-wide; managers and owners. */
export default async function ProgramPage() {
  const c = await getConsole();
  if (!loyaltyRoles(c).manager) return <NotForYourRole title="Programme and tiers">Only a manager or the owner can change the loyalty programme.</NotForYourRole>;
  const r = await read((ctx) => loyalty.getProgramSettings(ctx));
  const p = r.ok ? r.data : null;
  return (
    <LoyaltyFrame c={c} current="/console/loyalty/program" title="Programme and tiers" description="One programme for the whole organisation. Changes apply to every venue and are recorded on the audit log.">
      {!r.ok ? <ReadError message={r.error} /> : null}
      <div className="grid gap-6 xl:grid-cols-2">
        <Card title={p ? 'Programme' : 'Set up the programme'} description={p ? undefined : 'Nobody earns until a programme exists.'}>
          <ActionForm action={saveProgramAction} className="space-y-4">
            <Field label="Name">
              <Input name="name" required maxLength={120} defaultValue={p?.name ?? ''} />
            </Field>
            <Checkbox name="isActive" label="Running" hint="Pausing stops earning and redeeming, and keeps every balance." defaultChecked={p ? p.isActive : true} />
            <div className="grid gap-4 sm:grid-cols-2">
              <Field label="Guests earn">
                <Select name="earnModel" defaultValue={p?.earnModel ?? 'points_per_dollar'}>
                  <option value="points_per_dollar">Points per dollar spent</option>
                  <option value="visits">Points per visit</option>
                  <option value="stamps">Stamps (per visit)</option>
                </Select>
              </Field>
              <Field label="Points per dollar, or per visit">
                <Input name="pointsPerDollar" type="number" min={0} max={1000} step="0.01" required defaultValue={p?.pointsPerDollar ?? 1} />
              </Field>
              <Field label="Rounding of part points">
                <Select name="pointsRounding" defaultValue={p?.pointsRounding ?? 'floor'}>
                  <option value="floor">Round down</option>
                  <option value="round">Round to nearest</option>
                  <option value="ceil">Round up</option>
                </Select>
              </Field>
              <Field label="One point is worth (cents)" hint="Used to value the points outstanding.">
                <Input name="pointValueCents" type="number" min={0} max={10000} step="0.01" required defaultValue={p?.pointValueCents ?? 2} />
              </Field>
              <Field label="Points expire">
                <Select name="expiryPolicy" defaultValue={p?.expiryPolicy ?? 'none'}>
                  <option value="none">Never</option>
                  <option value="rolling">After a quiet spell (rolling)</option>
                  <option value="fixed">A fixed time after earning</option>
                </Select>
              </Field>
              <Field label="Months before expiry" hint="Ignored when points never expire.">
                <Input name="expiryMonths" type="number" min={1} max={120} defaultValue={p?.expiryMonths ?? ''} />
              </Field>
              <Field label="Points for joining">
                <Input name="enrolmentBonus" type="number" min={0} defaultValue={p?.enrolmentBonus ?? 0} />
              </Field>
              <Field label="Birthday points">
                <Input name="birthdayBonus" type="number" min={0} defaultValue={p?.birthdayBonus ?? 0} />
              </Field>
            </div>
            <Field label="Terms page (web address)">
              <Input name="termsUrl" type="url" defaultValue={p?.termsUrl ?? ''} placeholder="https://" />
            </Field>
            <SubmitButton>{p ? 'Save programme' : 'Create programme'}</SubmitButton>
          </ActionForm>
        </Card>

        <div className="space-y-6">
          <Card title="Tiers" description="Earned by points within a window. The multiplier raises the earn rate while on the tier." padded={false}>
            {!p || p.tiers.length === 0 ? (
              <p className="px-5 py-6 text-sm text-ink-2">{p ? 'No tiers. Everyone earns at the base rate.' : 'Set up the programme first.'}</p>
            ) : (
              <Table>
                <thead>
                  <tr>
                    <Th>Tier</Th>
                    <Th align="right">From</Th>
                    <Th align="right">Multiplier</Th>
                    <Th />
                  </tr>
                </thead>
                <tbody>
                  {p.tiers.map((t) => (
                    <tr key={t.id}>
                      <Td>
                        <span className="font-medium">{t.name}</span>
                        {t.perks.length ? <span className="block text-xs text-ink-3">{t.perks.join(' · ')}</span> : null}
                      </Td>
                      <Td numeric>
                        {t.thresholdPoints.toLocaleString('en-AU')} pts / {t.windowMonths} mo
                      </Td>
                      <Td numeric>×{t.multiplier}</Td>
                      <Td align="right">
                        <ConfirmAction trigger="Remove" title={`Remove the ${t.name} tier`} action={deleteTierAction} hidden={{ tierId: t.id }} confirmLabel="Remove tier">
                          Members on {t.name} lose the tier now and are placed again on their next sale or overnight. Their points are not touched.
                        </ConfirmAction>
                      </Td>
                    </tr>
                  ))}
                </tbody>
              </Table>
            )}
          </Card>
          {p ? (
            <Card title="Add a tier">
              <ActionForm action={saveTierAction} className="space-y-4" resetOnSuccess>
                <div className="grid gap-4 sm:grid-cols-2">
                  <Field label="Name">
                    <Input name="name" required maxLength={60} />
                  </Field>
                  <Field label="Points to reach it">
                    <Input name="thresholdPoints" type="number" min={0} required />
                  </Field>
                  <Field label="Within (months)">
                    <Input name="windowMonths" type="number" min={1} max={120} defaultValue={12} />
                  </Field>
                  <Field label="Earn multiplier">
                    <Input name="multiplier" type="number" min={0} max={99} step="0.1" defaultValue={1} />
                  </Field>
                </div>
                <Field label="Perks" hint="One per line.">
                  <Textarea name="perks" />
                </Field>
                <input type="hidden" name="sortOrder" value={p.tiers.length} />
                <SubmitButton>Add tier</SubmitButton>
              </ActionForm>
            </Card>
          ) : null}
        </div>
      </div>
    </LoyaltyFrame>
  );
}
