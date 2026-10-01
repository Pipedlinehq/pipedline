import { OrderRoute, orderMetadata } from '@/components/site/order-pages';
import type { SearchParams } from '@/components/site/site-pages';

type Params = Promise<{ host: string; venue: string }>;

export async function generateMetadata({ params }: { params: Params }) {
  const { host, venue } = await params;
  return orderMetadata(host, venue);
}

export default async function VenueOrderPage({ params, searchParams }: { params: Params; searchParams: Promise<SearchParams> }) {
  const { host, venue } = await params;
  return <OrderRoute host={host} venueSlug={venue} searchParams={await searchParams} />;
}
