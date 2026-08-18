import type { Severity } from '@weaver/core';
import type { ReactNode } from 'react';

/**
 * The shared vocabulary of the interface.
 *
 * Small, unstyled-by-default components rather than a component library: the
 * whole design is a handful of rules (one border weight, four pastels, three
 * typefaces), and importing a library would bury them.
 */

const STATE_CLASS: Record<string, string> = {
  ok: 'bg-state-ok-bg text-state-ok-ink',
  degraded: 'bg-state-warn-bg text-state-warn-ink',
  broken: 'bg-state-bad-bg text-state-bad-ink',
  healing: 'bg-state-busy-bg text-state-busy-ink',
  awaiting_approval: 'bg-state-busy-bg text-state-busy-ink',
  open: 'bg-state-bad-bg text-state-bad-ink',
  resolved: 'bg-state-ok-bg text-state-ok-ink',
  escalated: 'bg-state-warn-bg text-state-warn-ink',
  live: 'bg-state-busy-bg text-state-busy-ink',
  replay: 'bg-surface-sunk text-muted',
  chaos: 'bg-state-warn-bg text-state-warn-ink',
};

export function Tag({ state, children }: { state: string; children: ReactNode }) {
  const tone = STATE_CLASS[state] ?? 'bg-surface-sunk text-muted';
  return (
    <span
      className={`inline-flex items-center rounded-full px-2.5 py-0.5 font-mono text-[10px] tracking-[0.08em] uppercase ${tone}`}
    >
      {children}
    </span>
  );
}

export function SeverityTag({ severity }: { severity: Severity }) {
  return <Tag state={severity}>{severity}</Tag>;
}

export function Card({
  children,
  className = '',
  index = 0,
}: {
  children: ReactNode;
  className?: string;
  index?: number;
}) {
  return (
    <section
      data-reveal
      style={{ '--reveal-index': index } as React.CSSProperties}
      className={`rounded-[var(--radius-card)] border border-line bg-surface p-6 sm:p-8 ${className}`}
    >
      {children}
    </section>
  );
}

export function Metric({ label, value, note }: { label: string; value: string; note?: string }) {
  return (
    <div>
      <div className="font-mono text-[10px] tracking-[0.12em] text-muted uppercase">{label}</div>
      <div className="mt-2 font-serif text-4xl leading-none tracking-[-0.02em]">{value}</div>
      {note !== undefined && <div className="mt-2 text-sm text-muted">{note}</div>}
    </div>
  );
}

/**
 * A fill-rate bar.
 *
 * Twelve segments rather than a smooth bar: a discrete count is easier to compare
 * across rows at a glance than a continuous width, and it echoes the terminal
 * output, which uses the same idea.
 */
export function FillBar({ rate, segments = 12 }: { rate: number; segments?: number }) {
  const filled = Math.round(rate * segments);
  const tone =
    rate >= 0.9 ? 'bg-state-ok-ink' : rate >= 0.5 ? 'bg-state-warn-ink' : 'bg-state-bad-ink';

  return (
    <span
      className="inline-flex items-center gap-[3px]"
      role="img"
      aria-label={`${Math.round(rate * 100)} percent of rows carry a value`}
    >
      {Array.from({ length: segments }, (_unused, index) => (
        <span
          key={index}
          className={`h-3 w-[3px] rounded-[1px] ${index < filled ? tone : 'bg-line'}`}
        />
      ))}
    </span>
  );
}

export function SectionHeading({
  eyebrow,
  title,
  children,
}: {
  eyebrow: string;
  title: string;
  children?: ReactNode;
}) {
  return (
    <header className="mb-8">
      <div className="font-mono text-[10px] tracking-[0.12em] text-muted uppercase">{eyebrow}</div>
      <h2 className="mt-3 font-serif text-3xl leading-[1.1] tracking-[-0.02em] sm:text-4xl">
        {title}
      </h2>
      {children !== undefined && (
        <div className="mt-3 max-w-2xl text-[15px] text-muted">{children}</div>
      )}
    </header>
  );
}

export function Empty({ children }: { children: ReactNode }) {
  return (
    <div className="rounded-[var(--radius-card)] border border-dashed border-line px-6 py-10 text-center text-sm text-muted">
      {children}
    </div>
  );
}

/** A shell command, rendered as something you would type. */
export function Command({ children }: { children: string }) {
  return (
    <code className="inline-block rounded-[var(--radius-control)] border border-line bg-surface-sunk px-2 py-1 font-mono text-[12px] text-ink-soft">
      {children}
    </code>
  );
}
