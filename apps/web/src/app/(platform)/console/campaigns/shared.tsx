import type { ReactNode } from 'react';
import { atLeast, type ConsoleContext } from '@/lib/console';
import { moduleOn } from '@/lib/console-modules';
import { ModuleOff, Tabs } from '@/components/console/states';
import { Badge, PageHeader } from '@/ui';

/** Header, tabs for what this role can use, and the module-off state. */
export async function CampaignsFrame({ c, current, title, description, actions, children }: { c: ConsoleContext; current: string; title: string; description?: ReactNode; actions?: ReactNode; children: ReactNode }) {
  if (!(await moduleOn('campaigns'))) return <ModuleOff title="Campaigns" what="Campaigns" canManage={atLeast(c.role, 'manager')} />;
  const manager = atLeast(c.role, 'manager');
  const tabs = [
    { href: '/console/campaigns', label: 'Campaigns' },
    { href: '/console/campaigns/segments', label: 'Segments' },
    ...(manager ? [{ href: '/console/campaigns/flows', label: 'Flows' }] : []),
    ...(manager ? [{ href: '/console/campaigns/settings', label: 'Settings' }] : []),
  ];
  return (
    <>
      <PageHeader title={title} description={description} actions={actions} />
      <Tabs items={tabs} current={current} />
      {children}
    </>
  );
}

type Tone = 'neutral' | 'good' | 'warn' | 'bad' | 'accent';
const STATUS: Record<string, { label: string; tone: Tone }> = {
  draft: { label: 'Draft', tone: 'neutral' },
  pending_approval: { label: 'Waiting for approval', tone: 'warn' },
  approved: { label: 'Approved, about to send', tone: 'accent' },
  scheduled: { label: 'Scheduled', tone: 'accent' },
  sending: { label: 'Sending in waves', tone: 'accent' },
  sent: { label: 'Sent', tone: 'good' },
  cancelled: { label: 'Cancelled', tone: 'neutral' },
};

export function CampaignStatusBadge({ status }: { status: string }) {
  const s = STATUS[status] ?? { label: status, tone: 'neutral' as Tone };
  return <Badge tone={s.tone}>{s.label}</Badge>;
}

export const channelWord = (c: 'email' | 'sms') => (c === 'email' ? 'email' : 'SMS');
export const guests = (n: number) => `${n.toLocaleString('en-AU')} ${n === 1 ? 'guest' : 'guests'}`;

const MODE: Record<string, { label: string; tone: Tone; meaning: string }> = {
  off: { label: 'Off', tone: 'neutral', meaning: 'Does nothing. Guests are still enrolled, so it can pick up where it left off.' },
  shadow: { label: 'Shadow', tone: 'neutral', meaning: 'Works out who it would write to and what it would say, and records that. Sends nothing.' },
  supervised: { label: 'Supervised', tone: 'accent', meaning: 'Prepares each batch and waits in Approvals. Messages go only after a manager approves the batch.' },
  autonomous: { label: 'Autonomous', tone: 'warn', meaning: 'Sends by itself, up to its daily cap, with no approval. Only for flows with no offer attached.' },
};
export const modeInfo = (m: string) => MODE[m] ?? { label: m, tone: 'neutral' as Tone, meaning: '' };
