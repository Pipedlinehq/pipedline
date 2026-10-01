import type { ReactNode } from 'react';
import { GUEST_FACING_ROLES } from '@ros/core';
import { atLeast, type ConsoleContext } from '@/lib/console';
import { moduleOn } from '@/lib/console-modules';
import { ModuleOff, Tabs } from '@/components/console/states';
import { PageHeader } from '@/ui';

export interface LoyaltyRoles {
  manager: boolean;
  /** Deals with guests at the counter: host, front of house, managers and owners. */
  counter: boolean;
}

export function loyaltyRoles(c: ConsoleContext): LoyaltyRoles {
  const manager = atLeast(c.role, 'manager');
  return { manager, counter: manager || GUEST_FACING_ROLES.includes(c.role) };
}

/** Header, tabs for what this role can use, and the module-off state. Returns null when the page may render. */
export async function LoyaltyFrame({ c, current, title, description, actions, children }: { c: ConsoleContext; current: string; title: string; description?: ReactNode; actions?: ReactNode; children: ReactNode }) {
  if (!(await moduleOn('loyalty'))) return <ModuleOff title="Loyalty" what="Loyalty" canManage={atLeast(c.role, 'manager')} />;
  const r = loyaltyRoles(c);
  const tabs = [
    { href: '/console/loyalty', label: 'Summary' },
    ...(r.counter ? [{ href: '/console/loyalty/counter', label: 'Counter' }] : []),
    ...(r.manager ? [{ href: '/console/loyalty/members', label: 'Members' }] : []),
    { href: '/console/loyalty/rewards', label: 'Rewards' },
    ...(r.manager ? [{ href: '/console/loyalty/program', label: 'Programme and tiers' }] : []),
  ];
  return (
    <>
      <PageHeader title={title} description={description} actions={actions} />
      <Tabs items={tabs} current={current} />
      {children}
    </>
  );
}

export const points = (n: number) => `${n.toLocaleString('en-AU')} ${Math.abs(n) === 1 ? 'point' : 'points'}`;
