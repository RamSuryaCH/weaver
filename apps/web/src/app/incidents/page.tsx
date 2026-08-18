import Link from 'next/link';
import { Empty, SectionHeading, Tag } from '@/components/primitives';
import { loadDashboard } from '@/lib/data';
import { formatDuration, formatWhen } from '@/lib/format';

export const dynamic = 'force-dynamic';

export default async function IncidentsPage() {
  const data = await loadDashboard();

  return (
    <div>
      <SectionHeading eyebrow="Reliability" title="Incidents">
        One incident per source at a time, from the moment a contract was violated to the moment the
        source satisfied it again. Every heal prompt, every preview and every approve-or-reject
        decision is recorded, because a repair you cannot audit is not a repair you can trust.
      </SectionHeading>

      {data.incidents.length === 0 ? (
        <Empty>
          No incidents recorded. Break something on purpose with{' '}
          <code className="font-mono text-[12px]">
            pnpm weaver chaos --source truemeds --mutation null-field --field mrp
          </code>
          .
        </Empty>
      ) : (
        <ul className="space-y-3">
          {data.incidents.map((incident, index) => (
            <li
              key={incident.id}
              data-reveal
              style={{ '--reveal-index': index } as React.CSSProperties}
            >
              <Link
                href={`/incidents/${incident.id}`}
                className="block rounded-[var(--radius-card)] border border-line bg-surface px-6 py-5 transition-shadow hover:shadow-[0_2px_8px_rgba(0,0,0,0.04)] focus-visible:ring-1 focus-visible:ring-ink focus-visible:outline-none"
              >
                <div className="flex flex-wrap items-center gap-3">
                  <Tag state={incident.status}>{incident.status.replace('_', ' ')}</Tag>
                  <Tag state={incident.severity}>{incident.severity}</Tag>
                  <span className="font-mono text-[11px] text-muted">{incident.sourceId}</span>
                  <span className="numeric ml-auto text-[11px] text-muted">
                    {formatWhen(incident.openedAt)}
                  </span>
                </div>

                <p className="mt-3 text-[15px] text-ink-soft">{incident.summary}</p>

                <dl className="mt-3 flex flex-wrap gap-x-8 gap-y-1 font-mono text-[11px] text-muted">
                  <div className="flex gap-2">
                    <dt className="uppercase">heal attempts</dt>
                    <dd className="text-ink-soft">{incident.healAttempts}</dd>
                  </div>
                  {incident.mttrMs !== null && (
                    <div className="flex gap-2">
                      <dt className="uppercase">time to repair</dt>
                      <dd className="text-ink-soft">{formatDuration(incident.mttrMs)}</dd>
                    </div>
                  )}
                  {incident.collectorId !== null && (
                    <div className="flex gap-2">
                      <dt className="uppercase">collector</dt>
                      <dd className="text-ink-soft">{incident.collectorId}</dd>
                    </div>
                  )}
                </dl>
              </Link>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
