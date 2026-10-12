import { atLeast, getConsole } from '@/lib/console';
import { moduleOn } from '@/lib/console-modules';
import { ListBuilder } from '@/components/console/list-builder';
import { ModuleOff, NotForYourRole } from '@/components/console/states';
import { Card, LinkButton, PageHeader } from '@/ui';
import { parseListTextAction, previewListAction, saveListAction } from '../actions';
import { BUILDER_FIELDS } from '../rows';

export const metadata = { title: 'New guest list · Pipedline' };

export default async function NewGuestListPage() {
  const c = await getConsole();
  if (!atLeast(c.role, 'manager')) return <NotForYourRole title="New guest list">A manager defines guest lists.</NotForYourRole>;
  if (!(await moduleOn('campaigns'))) return <ModuleOff title="New guest list" what="Campaigns" canManage />;
  return (
    <>
      <PageHeader title="New guest list" description="Pick the conditions, or write the rule in words; the two say the same thing. Count the guests before you save." actions={<LinkButton href="/console/customers/lists">All lists</LinkButton>} />
      <Card>
        <ListBuilder save={saveListAction} preview={previewListAction} parse={parseListTextAction} fields={BUILDER_FIELDS} />
      </Card>
    </>
  );
}
