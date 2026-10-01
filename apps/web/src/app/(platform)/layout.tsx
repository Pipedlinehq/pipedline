import type { ReactNode } from 'react';
import '../globals.css';

export const metadata = { title: 'Restaurant OS' };

export default function PlatformLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}
