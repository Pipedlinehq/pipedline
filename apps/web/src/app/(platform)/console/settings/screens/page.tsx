import { auth } from '@ros/modules';
import { app } from '@/lib/runtime';
import { atLeast, getConsole } from '@/lib/console';
import { read } from '@/lib/console-read';
import { ConfirmAction } from '@/components/console/confirm';
import { PairScreenForm } from '@/components/console/settings-once';
import { NotForYourRole, ReadError } from '@/components/console/states';
import { Badge, Card, EmptyState, Field, Input, PageHeader, Select, Table, Td, Th, dateTime } from '@/ui';
import { pairScreen, revokeScreen } from './actions';

export const metadata = { title: 'Kitchen screens · Restaurant OS' };

export default async function ScreensPage() {
  const c = await getConsole();
  if (!atLeast(c.role, 'manager')) return <NotForYourRole title="Kitchen screens" />;
  const devices = await read((ctx) => auth.listDevices(ctx, c.venue.id));
  const cfg = app().config;
  const pairUrl = `${cfg.scheme}://${cfg.platformHost}/kitchen`;
  const tz = c.venue.timezone;

  const status = (d: auth.DeviceView) => (d.revoked ? <Badge>Revoked</Badge> : d.paired ? <Badge tone="good">Paired</Badge> : <Badge tone="warn">Waiting for its code</Badge>);

  return (
    <>
      <PageHeader title="Kitchen screens" description={`Tablets and screens at ${c.venue.name} that show orders to the kitchen or the counter. A screen sees only this venue's tickets and nothing else.`} />
      <div className="grid grid-cols-1 gap-6 lg:grid-cols-[minmax(0,1fr)_22rem]">
        <Card title="Screens" padded={false}>
          {!devices.ok ? (
            <div className="p-5">
              <ReadError message={devices.error} />
            </div>
          ) : devices.data.length === 0 ? (
            <div className="p-5">
              <EmptyState title="No screens yet">Pair the kitchen tablet with a code from the pairing form on this page.</EmptyState>
            </div>
          ) : (
            <Table>
              <thead>
                <tr>
                  <Th>Name</Th>
                  <Th>For</Th>
                  <Th>Status</Th>
                  <Th>Last seen</Th>
                  <Th />
                </tr>
              </thead>
              <tbody>
                {devices.data.map((d) => (
                  <tr key={d.id} data-testid={`device-${d.name}`}>
                    <Td className="font-medium">{d.name}</Td>
                    <Td>{d.purpose === 'kitchen' ? 'Kitchen' : 'Counter'}</Td>
                    <Td>{status(d)}</Td>
                    <Td>{d.lastSeenAt ? dateTime(d.lastSeenAt, tz) : '–'}</Td>
                    <Td align="right">
                      {d.revoked ? null : (
                        <ConfirmAction
                          trigger="Revoke"
                          title={`Revoke “${d.name}”?`}
                          action={revokeScreen}
                          hidden={{ deviceId: d.id }}
                          confirmLabel="Revoke this screen"
                          testId={`revoke-device-${d.name}`}
                        >
                          <p>
                            “{d.name}” is signed out straight away and stops showing {c.venue.name}&apos;s tickets. To use it again, pair it with a new code.
                          </p>
                        </ConfirmAction>
                      )}
                    </Td>
                  </tr>
                ))}
              </tbody>
            </Table>
          )}
        </Card>
        <Card title="Pair a screen" description="You get a code that works once, for 15 minutes.">
          <PairScreenForm action={pairScreen} pairUrl={pairUrl}>
            <Field label="Name">
              <Input name="name" required maxLength={60} placeholder="Pass tablet" />
            </Field>
            <Field label="Used for">
              <Select name="purpose" defaultValue="kitchen">
                <option value="kitchen">Kitchen tickets</option>
                <option value="counter">Counter</option>
              </Select>
            </Field>
          </PairScreenForm>
        </Card>
      </div>
    </>
  );
}
