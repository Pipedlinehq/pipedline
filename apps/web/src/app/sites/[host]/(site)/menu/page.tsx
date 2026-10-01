import { MenuRoute, type SearchParams, menuMetadata } from '@/components/site/site-pages';

export async function generateMetadata({ params }: { params: Promise<{ host: string }> }) {
  return menuMetadata((await params).host, null);
}

/** The live menu. Viewing works with JavaScript off; filters are a plain GET form. */
export default async function MenuPage({ params, searchParams }: { params: Promise<{ host: string }>; searchParams: Promise<SearchParams> }) {
  return <MenuRoute host={(await params).host} venueSlug={null} searchParams={await searchParams} />;
}
