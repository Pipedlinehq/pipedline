import { HomeRoute, type SearchParams, homeMetadata } from '@/components/site/site-pages';

type Params = Promise<{ host: string; venue: string }>;

export async function generateMetadata({ params }: { params: Params }) {
  const { host, venue } = await params;
  return homeMetadata(host, venue);
}

export default async function VenueHome({ params, searchParams }: { params: Params; searchParams: Promise<SearchParams> }) {
  const { host, venue } = await params;
  return <HomeRoute host={host} venueSlug={venue} searchParams={await searchParams} />;
}
