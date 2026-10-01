import type { Metadata, Viewport } from 'next';
import type { ReactNode } from 'react';
import '@/components/kitchen/kitchen.css';

export const metadata: Metadata = {
  title: 'Kitchen orders',
  manifest: '/kitchen/manifest.webmanifest',
  icons: { icon: '/kitchen/app-icon', apple: '/kitchen/app-icon' },
  appleWebApp: { capable: true, title: 'Kitchen', statusBarStyle: 'black' },
};

export const viewport: Viewport = { themeColor: '#0b0d10', colorScheme: 'dark', width: 'device-width', initialScale: 1, maximumScale: 1, userScalable: false };

/** The kitchen screen: dark, full height, its own frame. */
export default function KitchenLayout({ children }: { children: ReactNode }) {
  return <div className="min-h-dvh bg-[#0b0d10] text-slate-50 [color-scheme:dark]">{children}</div>;
}
