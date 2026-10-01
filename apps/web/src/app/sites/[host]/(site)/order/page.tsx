import { OrderRoute, orderMetadata } from '@/components/site/order-pages';
import type { SearchParams } from '@/components/site/site-pages';

export async function generateMetadata({ params }: { params: Promise<{ host: string }> }) {
  return orderMetadata((await params).host, null);
}

/** Pickup ordering, or table ordering after a QR scan. The cart is client-side and priced only by the server. */
export default async function OrderPage({ params, searchParams }: { params: Promise<{ host: string }>; searchParams: Promise<SearchParams> }) {
  return <OrderRoute host={(await params).host} venueSlug={null} searchParams={await searchParams} />;
}
