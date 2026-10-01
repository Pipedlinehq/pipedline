import type { ReactNode } from 'react';
import { atLeast, type ConsoleContext } from '@/lib/console';
import { moduleOn } from '@/lib/console-modules';
import { ModuleOff, Tabs } from '@/components/console/states';
import { PageHeader } from '@/ui';

/** Header, tabs and the module-off state for every reviews page. */
export async function ReviewsFrame({ c, current, description, actions, children }: { c: ConsoleContext; current: string; description?: ReactNode; actions?: ReactNode; children: ReactNode }) {
  const manager = atLeast(c.role, 'manager');
  if (!(await moduleOn('reviews'))) return <ModuleOff title="Reviews" what="Reviews" canManage={manager} />;
  return (
    <>
      <PageHeader title="Reviews" description={description} actions={actions} />
      <Tabs
        current={current}
        items={[
          { href: '/console/reviews', label: 'Inbox' },
          { href: '/console/reviews/listings', label: 'Listings' },
          ...(manager ? [{ href: '/console/reviews/settings', label: 'Reply settings' }] : []),
        ]}
      />
      {children}
    </>
  );
}
