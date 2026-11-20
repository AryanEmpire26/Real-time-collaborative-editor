import type { Metadata } from 'next';
import type { ReactNode } from 'react';
import './styles.css';

export const metadata: Metadata = {
  title: 'MergePad — collaborative workspace',
  description: 'A real-time writing workspace that keeps working offline.',
};

export default function RootLayout({ children }: { children: ReactNode }) {
  return <html lang="en"><body>{children}</body></html>;
}
