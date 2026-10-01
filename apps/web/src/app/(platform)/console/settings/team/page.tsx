import { ROLE_RANK, type StaffRole } from '@ros/core';
import { auth } from '@ros/modules';
import { atLeast, getConsole } from '@/lib/console';
import { read } from '@/lib/console-read';
import { ConfirmAction } from '@/components/console/confirm';
import { NotForYourRole, ReadError } from '@/components/console/states';
import { ActionForm, Badge, Card, Checkbox, Dialog, EmptyState, Field, Input, PageHeader, SubmitButton, Table, Td, Th } from '@/ui';
import { invitePerson, removePerson, saveRoles } from './actions';

export const metadata = { title: 'Team · Pipedline' };

const ROLE_LABEL: Record<StaffRole, string> = {
  owner: 'Owner',
  manager: 'Manager',
  host: 'Host',
  front_of_house: 'Front of house',
  kitchen: 'Kitchen',
  read_only: 'Read only',
};

function RoleSelect({ name, value, roles, label }: { name: string; value?: string; roles: StaffRole[]; label: string }) {
  return (
    <label className="flex items-center justify-between gap-3 text-sm">
      <span className="min-w-0 truncate text-ink">{label}</span>
      <select name={name} defaultValue={value ?? ''} className="h-9 w-44 shrink-0 rounded-md border border-line-strong bg-surface px-2 text-sm">
        <option value="">No access</option>
        {roles.map((r) => (
          <option key={r} value={r}>
            {ROLE_LABEL[r]}
          </option>
        ))}
      </select>
    </label>
  );
}

export default async function TeamPage() {
  const c = await getConsole();
  if (!atLeast(c.role, 'manager')) return <NotForYourRole title="Team" />;
  const staff = await read((ctx) => auth.listStaff(ctx));
  const myRoles = c.session.principal.venueRoles;
  const me = c.session.principal.staffId;
  // What this person may grant: an owner anything; a manager roles below manager, at venues they manage.
  const grantable: StaffRole[] = c.isOwner ? ['manager', 'host', 'front_of_house', 'kitchen', 'read_only'] : ['host', 'front_of_house', 'kitchen', 'read_only'];
  const inviteVenues = c.venues.filter((v) => c.isOwner || ROLE_RANK[myRoles[v.id] ?? 'read_only'] >= ROLE_RANK.manager);
  const venueName = new Map(c.venues.map((v) => [v.id, v.name]));

  return (
    <>
      <PageHeader title="Team" description="Who can sign in to the console, and what they can do at each venue. There are no passwords: people sign in with a code emailed to them." />
      <div className="grid grid-cols-1 gap-6 xl:grid-cols-[minmax(0,1fr)_24rem]">
        <Card title="People" padded={false}>
          {!staff.ok ? (
            <div className="p-5">
              <ReadError message={staff.error} />
            </div>
          ) : staff.data.length === 0 ? (
            <div className="p-5">
              <EmptyState title="Nobody yet" />
            </div>
          ) : (
            <Table>
              <thead>
                <tr>
                  <Th>Name</Th>
                  <Th>Roles</Th>
                  <Th>Status</Th>
                  {c.isOwner ? <Th /> : null}
                </tr>
              </thead>
              <tbody>
                {staff.data.map((s) => {
                  const name = [s.firstName, s.lastName].filter(Boolean).join(' ');
                  const visibleRoles = s.roles.filter((r) => venueName.has(r.venueId));
                  return (
                    <tr key={s.id} data-testid={`staff-${s.email}`}>
                      <Td>
                        <p className="font-medium">{name}</p>
                        <p className="text-xs text-ink-3">{s.email}</p>
                      </Td>
                      <Td>
                        {s.isOwner ? (
                          'Owner of every venue'
                        ) : visibleRoles.length ? (
                          <ul className="space-y-0.5">
                            {visibleRoles.map((r) => (
                              <li key={r.venueId}>
                                {ROLE_LABEL[r.role]} <span className="text-ink-3">at {venueName.get(r.venueId)}</span>
                              </li>
                            ))}
                          </ul>
                        ) : (
                          <span className="text-ink-3">No venue you can see</span>
                        )}
                      </Td>
                      <Td>
                        <Badge tone={s.status === 'active' ? 'good' : s.status === 'invited' ? 'accent' : 'neutral'}>{s.status === 'active' ? 'Active' : s.status === 'invited' ? 'Invited' : 'Removed'}</Badge>
                      </Td>
                      {c.isOwner ? (
                        <Td align="right">
                          {s.status !== 'disabled' && s.id !== me ? (
                            <div className="flex justify-end gap-2">
                              {s.isOwner ? null : (
                                <Dialog trigger="Roles" title={`Roles for ${name}`}>
                                  <ActionForm action={saveRoles} className="space-y-3">
                                    <input type="hidden" name="staffId" value={s.id} />
                                    {c.venues.map((v) => (
                                      <RoleSelect key={v.id} name={`role:${v.id}`} label={v.name} value={s.roles.find((r) => r.venueId === v.id)?.role} roles={grantable} />
                                    ))}
                                    <SubmitButton size="sm">Save roles</SubmitButton>
                                  </ActionForm>
                                </Dialog>
                              )}
                              <ConfirmAction triggerSize="md" trigger="Remove" title={`Remove ${name}?`} action={removePerson} hidden={{ staffId: s.id }} confirmLabel="Remove their access">
                                <p>
                                  {name} is signed out everywhere straight away and can no longer sign in to {c.org.tradingName}. Their assistant keys stop working too.
                                </p>
                                <p className="mt-2">What they did stays in the records.</p>
                              </ConfirmAction>
                            </div>
                          ) : null}
                        </Td>
                      ) : null}
                    </tr>
                  );
                })}
              </tbody>
            </Table>
          )}
        </Card>
        <Card title="Invite someone" description={c.isOwner ? undefined : 'You can add people at the venues you manage, at roles below manager. An owner adds managers.'}>
          {inviteVenues.length === 0 ? (
            <p className="text-sm text-ink-3">You do not manage a venue, so you cannot invite anyone.</p>
          ) : (
            <div data-testid="invite-form">
            <ActionForm action={invitePerson} className="space-y-4" resetOnSuccess>
              <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 xl:grid-cols-1">
                <Field label="First name">
                  <Input name="firstName" required maxLength={100} />
                </Field>
                <Field label="Last name">
                  <Input name="lastName" maxLength={100} />
                </Field>
              </div>
              <Field label="Email">
                <Input name="email" type="email" required />
              </Field>
              <fieldset className="space-y-2">
                <legend className="mb-1 text-sm font-medium text-ink">Role at each venue</legend>
                {inviteVenues.map((v) => (
                  <RoleSelect key={v.id} name={`role:${v.id}`} label={v.name} roles={grantable} />
                ))}
              </fieldset>
              {c.isOwner ? <Checkbox name="isOwner" label="Make them an owner" hint="Owners see and can change everything, at every venue, including billing and exports." /> : null}
              <SubmitButton pendingLabel="Inviting…">Send invitation</SubmitButton>
            </ActionForm>
            </div>
          )}
        </Card>
      </div>
    </>
  );
}
