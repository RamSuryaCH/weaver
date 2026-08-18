'use client';

import { useEffect } from 'react';

/**
 * Reveals `[data-reveal]` elements as they enter the viewport.
 *
 * One observer for the whole document rather than a wrapper component per
 * element, and `IntersectionObserver` rather than a scroll listener, so nothing
 * runs on the main thread during a scroll. Elements are unobserved once revealed.
 */
export function Reveal() {
  useEffect(() => {
    const targets = document.querySelectorAll<HTMLElement>('[data-reveal]');

    if (window.matchMedia('(prefers-reduced-motion: reduce)').matches) {
      for (const target of targets) target.dataset.revealed = 'true';
      return;
    }

    const observer = new IntersectionObserver(
      (entries) => {
        for (const entry of entries) {
          if (!entry.isIntersecting) continue;
          (entry.target as HTMLElement).dataset.revealed = 'true';
          observer.unobserve(entry.target);
        }
      },
      { rootMargin: '0px 0px -8% 0px', threshold: 0.05 },
    );

    for (const target of targets) observer.observe(target);
    return () => observer.disconnect();
  }, []);

  return null;
}
