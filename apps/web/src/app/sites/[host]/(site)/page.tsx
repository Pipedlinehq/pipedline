import { HomeRoute, type SearchParams, homeMetadata } from '@/components/site/site-pages';

export async function generateMetadata({ params }: { params: Promise<{ host: string }> }) {
  return homeMetadata((await params).host, null);
}

export default async function SiteHome({ params, searchParams }: { params: Promise<{ host: string }>; searchParams: Promise<SearchParams> }) {
  return <HomeRoute host={(await params).host} venueSlug={null} searchParams={await searchParams} />;
}
