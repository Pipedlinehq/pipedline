import { campaigns } from '@ros/modules';
import { atLeast, getConsole } from '@/lib/console';
import { moduleOn } from '@/lib/console-modules';
import { read } from '@/lib/console-read';
import { ModuleOff, NotForYourRole } from '@/components/console/states';
import { Card, LinkButton, PageHeader } from '@/ui';
import { OfferForm } from '../offer-form';

export const metadata = { title: 'New offer · Pipedline' };

export default async function NewOfferPage() {
  const c = await getConsole();
  const manager = atLeast(c.role, 'manager');
  if (!(await moduleOn('offers'))) return <ModuleOff title="New offer" what="Offers" canManage={manager} />;
  if (!manager) return <NotForYourRole title="New offer">Only a manager or the owner can create offers.</NotForYourRole>;
  const lists = (await moduleOn('campaigns')) ? await read((ctx) => campaigns.listSegments(ctx)) : null;
  return (
    <>
      <PageHeader title="New offer" description="Offers apply across the organisation unless limited to venues. The summary guests see is written from what you set here." actions={<LinkButton href="/console/offers" size="sm">Back</LinkButton>} />
      <Card>
        <OfferForm c={c} lists={lists?.ok ? lists.data.map((s) => ({ id: s.id, name: s.name })) : []} />
      </Card>
    </>
  );
}
