import { MenuRoute, type SearchParams, menuMetadata } from '@/components/site/site-pages';

type Params = Promise<{ host: string; venue: string }>;

export async function generateMetadata({ params }: { params: Params }) {
  const { host, venue } = await params;
  return menuMetadata(host, venue);
}

export default async function VenueMenuPage({ params, searchParams }: { params: Params; searchParams: Promise<SearchParams> }) {
  const { host, venue } = await params;
  return <MenuRoute host={host} venueSlug={venue} searchParams={await searchParams} />;
}
