import Link from 'next/link';
import { notFound } from 'next/navigation';
import type { IncidentEventRecord } from '@weaver/db';
import { Tag } from '@/components/primitives';
import { loadIncident } from '@/lib/data';
import { formatDuration, formatWhen } from '@/lib/format';

export const dynamic = 'force-dynamic';

/**
 * The incident timeline.
 *
 * This is the screen the project exists to show: detection, the exact prompt that
 * was sent, the preview that came back, the reason the gate approved or rejected
 * it, and the re-run that closed the incident. Nothing here is summarised — the
 * prompt is the prompt, the preview rows are the preview rows.
 */
export default async function IncidentPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const detail = await loadIncident(id);
  if (detail === undefined) notFound();

  const { incident, timeline, contract } = detail;

  return (
    <div>
      <Link
        href="/incidents"
        className="font-mono text-[11px] tracking-[0.08em] text-muted uppercase hover:text-ink"
      >
        ← all incidents
      </Link>

      <header className="mt-6 mb-12 border-b border-line pb-8">
        <div className="flex flex-wrap items-center gap-3">
          <Tag state={incident.status}>{incident.status.replace('_', ' ')}</Tag>
          <Tag state={incident.severity}>{incident.severity}</Tag>
          {incident.mttrMs !== null && (
            <span className="font-mono text-[11px] text-muted">
              repaired in {formatDuration(incident.mttrMs)}
            </span>
          )}
        </div>

        <h1 className="mt-4 max-w-3xl font-serif text-4xl leading-[1.12] tracking-[-0.02em]">
          {incident.summary}
        </h1>

        <dl className="mt-6 grid gap-x-10 gap-y-2 font-mono text-[11px] text-muted sm:grid-cols-2 lg:grid-cols-4">
          <Pair label="source" value={contract?.name ?? incident.sourceId} />
          <Pair label="collector" value={incident.collectorId ?? 'none'} />
          <Pair label="opened" value={formatWhen(incident.openedAt)} />
          <Pair
            label="closed"
            value={incident.closedAt === null ? 'still open' : formatWhen(incident.closedAt)}
          />
        </dl>

        {incident.collectorId !== null && (
          <p className="mt-6 max-w-2xl text-sm text-muted">
            The Collector ID above is the same before and after this repair. Healing changes the
            scraper in place, so every trigger, schedule and integration downstream kept working
            throughout.
          </p>
        )}
      </header>

      <ol className="relative space-y-8 border-l border-line pl-8">
        {timeline.map((event, index) => (
          <li
            key={event.id}
            data-reveal
            style={{ '--reveal-index': index } as React.CSSProperties}
            className="relative"
          >
            <span
              aria-hidden
              className={`absolute top-1.5 -left-[37px] h-3 w-3 rounded-full border-2 border-canvas ${dotFor(event.kind)}`}
            />

            <div className="flex flex-wrap items-baseline gap-3">
              <h2 className="font-mono text-[11px] tracking-[0.1em] uppercase">
                {event.kind.replace(/_/g, ' ')}
              </h2>
              <span className="numeric text-[11px] text-muted">{formatWhen(event.at)}</span>
            </div>

            <p className="mt-2 max-w-3xl text-[15px] text-ink-soft">{event.message}</p>

            <EventDetail event={event} />
          </li>
        ))}
      </ol>
    </div>
  );
}

function Pair({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex gap-2">
      <dt className="uppercase">{label}</dt>
      <dd className="text-ink-soft">{value}</dd>
    </div>
  );
}

function dotFor(kind: IncidentEventRecord['kind']): string {
  switch (kind) {
    case 'detected':
      return 'bg-state-bad-ink';
    case 'preview_verified':
    case 'approved':
    case 'reverified':
    case 'resolved':
      return 'bg-state-ok-ink';
    case 'preview_rejected':
    case 'rejected':
    case 'escalated':
      return 'bg-state-warn-ink';
    case 'heal_requested':
    case 'preview_received':
      return 'bg-state-busy-ink';
  }
}

/**
 * The evidence attached to an event.
 *
 * Heal prompts are rendered as prose because that is what they are; previews and
 * findings are rendered as JSON because that is what they are. Nothing is
 * paraphrased.
 */
function EventDetail({ event }: { event: IncidentEventRecord }) {
  if (event.detail === undefined || event.detail === null) return null;
  const detail = event.detail as Record<string, unknown>;

  const prompt = typeof detail.prompt === 'string' ? detail.prompt : undefined;
  const previewRows = Array.isArray(detail.previewRows) ? detail.previewRows : undefined;
  const findings = Array.isArray(detail.findings) ? detail.findings : undefined;

  return (
    <div className="mt-4 space-y-4">
      {prompt !== undefined && (
        <figure>
          <figcaption className="mb-2 font-mono text-[10px] tracking-[0.1em] text-muted uppercase">
            prompt sent to bdata scraper heal · {prompt.length} of 1000 characters
          </figcaption>
          <blockquote className="rounded-[var(--radius-card)] border border-line bg-surface px-5 py-4 font-serif text-[17px] leading-relaxed">
            {prompt}
          </blockquote>
        </figure>
      )}

      {findings !== undefined && findings.length > 0 && (
        <div className="space-y-2">
          {findings.map((raw, index) => {
            const finding = raw as { field?: string; code?: string; message?: string };
            return (
              <div
                key={index}
                className="rounded-[var(--radius-control)] border border-line bg-surface-sunk px-4 py-2 text-[13px]"
              >
                <span className="font-mono text-[11px] text-muted">
                  {finding.field ?? 'run'} · {finding.code ?? 'finding'}
                </span>
                <div className="text-ink-soft">{finding.message}</div>
              </div>
            );
          })}
        </div>
      )}

      {previewRows !== undefined && (
        <details className="rounded-[var(--radius-card)] border border-line bg-surface">
          <summary className="cursor-pointer px-5 py-3 font-mono text-[11px] tracking-[0.08em] text-muted uppercase">
            preview returned by Bright Data · {previewRows.length} row
            {previewRows.length === 1 ? '' : 's'}
          </summary>
          <pre className="overflow-x-auto border-t border-line px-5 py-4 font-mono text-[12px] leading-relaxed">
            {JSON.stringify(previewRows.slice(0, 4), null, 2)}
          </pre>
        </details>
      )}
    </div>
  );
}
