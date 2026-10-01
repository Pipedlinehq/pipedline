import { TrackRoute, trackMetadata } from '@/components/site/order-pages';

export const metadata = trackMetadata();

/** Order confirmation and live tracking, by the unguessable token in the guest's link. */
export default async function TrackPage({ params }: { params: Promise<{ host: string; token: string }> }) {
  const { host, token } = await params;
  return <TrackRoute host={host} token={token} />;
}
