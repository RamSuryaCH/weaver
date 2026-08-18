import type { Metadata } from 'next';
import { Instrument_Serif, JetBrains_Mono } from 'next/font/google';
import Link from 'next/link';
import type { ReactNode } from 'react';
import { Reveal } from '@/components/reveal';
import './globals.css';

const editorial = Instrument_Serif({
  weight: '400',
  subsets: ['latin'],
  variable: '--font-editorial',
  display: 'swap',
});

const code = JetBrains_Mono({
  subsets: ['latin'],
  variable: '--font-code',
  display: 'swap',
});

export const metadata: Metadata = {
  title: 'Weaver — self-healing web data',
  description:
    'A self-healing web data control plane built on Bright Data Scraper Studio. Detects drift, writes the heal prompt, and verifies the fix before approving it.',
};

const NAV = [
  { href: '/', label: 'Overview' },
  { href: '/incidents', label: 'Incidents' },
  { href: '/prices', label: 'Prices' },
] as const;

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="en" className={`${editorial.variable} ${code.variable}`}>
      <body className="min-h-screen bg-canvas text-ink">
        {/* A single ambient light spot, at 3% opacity, so the canvas is not flat. */}
        <div
          aria-hidden
          className="pointer-events-none fixed inset-0 -z-10"
          style={{
            background:
              'radial-gradient(60rem 40rem at 15% -10%, rgba(120,119,116,0.05), transparent 70%)',
          }}
        />

        <header className="sticky top-0 z-20 border-b border-line bg-canvas/85 backdrop-blur-sm">
          <div className="mx-auto flex max-w-6xl items-center justify-between px-6 py-4">
            <Link href="/" className="group flex items-baseline gap-3">
              <span className="font-serif text-2xl tracking-[-0.03em]">Weaver</span>
              <span className="hidden font-mono text-[10px] tracking-[0.12em] text-muted uppercase sm:inline">
                self-healing web data
              </span>
            </Link>

            <nav aria-label="Sections" className="flex items-center gap-1">
              {NAV.map((item) => (
                <Link
                  key={item.href}
                  href={item.href}
                  className="rounded-[var(--radius-control)] px-3 py-1.5 font-mono text-[11px] tracking-[0.06em] text-muted uppercase transition-colors hover:bg-surface hover:text-ink focus-visible:ring-1 focus-visible:ring-ink focus-visible:outline-none"
                >
                  {item.label}
                </Link>
              ))}
            </nav>
          </div>
        </header>

        <main className="mx-auto max-w-6xl px-6 py-16 sm:py-24">{children}</main>

        <footer className="mt-16 border-t border-line">
          <div className="mx-auto flex max-w-6xl flex-col gap-2 px-6 py-10 text-sm text-muted sm:flex-row sm:items-center sm:justify-between">
            <p>
              Public product data from three Indian online pharmacies. No personal data is
              collected.
            </p>
            <p className="font-mono text-[11px] tracking-[0.06em] uppercase">
              Built on Bright Data Scraper Studio
            </p>
          </div>
        </footer>

        <Reveal />
      </body>
    </html>
  );
}
