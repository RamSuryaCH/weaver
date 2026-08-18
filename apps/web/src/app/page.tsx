import Link from 'next/link';
import { Card, Command, Empty, Metric, SeverityTag, Tag } from '@/components/primitives';
import { loadDashboard } from '@/lib/data';
import { formatDuration, formatWhen, median } from '@/lib/format';

export const dynamic = 'force-dynamic';

export default async function OverviewPage() {
  const data = await loadDashboard();
  const withRuns = data.sources.filter((source) => source.latestRun !== undefined);
  const healthy = withRuns.filter((source) => source.latestRun?.severity === 'ok').length;
  const mttr = median(
    data.resolvedIncidents
      .map((incident) => incident.mttrMs)
      .filter((value): value is number => value !== null),
  );

  return (
    <div className="space-y-16">
      <section data-reveal className="max-w-3xl">
        <div className="font-mono text-[10px] tracking-[0.12em] text-muted uppercase">
          Control plane
        </div>
        <h1 className="mt-4 font-serif text-5xl leading-[1.05] tracking-[-0.03em] sm:text-6xl">
          Scrapers do not fail loudly.
        </h1>
        <p className="mt-6 text-lg leading-relaxed text-ink-soft">
          A class name changes, a field starts returning null, and the pipeline downstream keeps
          running on quietly degrading data. Weaver watches every field against the sentence that
          describes it, writes the repair prompt when that sentence stops being true, and verifies
          the fix before approving it.
        </p>
      </section>

      {/* Bento grid: deliberately asymmetric, so the eye lands on health first. */}
      <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
        <Card index={0} className="lg:col-span-2">
          <Metric
            label="Sources healthy"
            value={`${String(healthy)} / ${String(data.sources.length)}`}
            note={
              data.summary.openIncidents === 0
                ? 'No open incidents.'
                : `${String(data.summary.openIncidents)} open incident${data.summary.openIncidents === 1 ? '' : 's'}.`
            }
          />
        </Card>

        <Card index={1}>
          <Metric
            label="Rows collected"
            value={data.summary.rowCount.toLocaleString('en-IN')}
            note={`${String(data.summary.runCount)} recorded runs`}
          />
        </Card>

        <Card index={2}>
          <Metric
            label="Median time to repair"
            value={mttr === undefined ? '—' : formatDuration(mttr)}
            note={
              mttr === undefined
                ? 'No incident has closed yet'
                : `across ${String(data.resolvedIncidents.length)} resolved`
            }
          />
        </Card>
      </div>

      <section>
        <div className="mb-6 flex flex-wrap items-baseline justify-between gap-3">
          <h2 className="font-serif text-3xl tracking-[-0.02em]">Sources</h2>
          <div className="flex items-center gap-2">
            <Tag state={data.mode}>{data.mode} mode</Tag>
            <Tag state="healing">heal policy {data.healPolicy}</Tag>
          </div>
        </div>

        {data.sources.length === 0 ? (
          <Empty>
            No source contracts found. Add a YAML file to <Command>sources/</Command>.
          </Empty>
        ) : (
          <div className="overflow-hidden rounded-[var(--radius-card)] border border-line bg-surface">
            <table className="w-full text-left text-sm">
              <thead>
                <tr className="border-b border-line font-mono text-[10px] tracking-[0.1em] text-muted uppercase">
                  <th scope="col" className="px-6 py-3 font-normal">
                    Source
                  </th>
                  <th scope="col" className="px-6 py-3 font-normal">
                    Collector
                  </th>
                  <th scope="col" className="px-6 py-3 font-normal">
                    Last run
                  </th>
                  <th scope="col" className="px-6 py-3 text-right font-normal">
                    Rows
                  </th>
                  <th scope="col" className="px-6 py-3 font-normal">
                    State
                  </th>
                </tr>
              </thead>
              <tbody>
                {data.sources.map((source) => (
                  <tr key={source.contract.id} className="border-b border-line last:border-0">
                    <td className="px-6 py-4">
                      <Link
                        href={`/sources/${source.contract.id}`}
                        className="font-medium underline decoration-line decoration-1 underline-offset-4 hover:decoration-ink"
                      >
                        {source.contract.name}
                      </Link>
                      <div className="mt-0.5 font-mono text-[11px] text-muted">
                        {source.contract.type} · {source.contract.schema.length} fields
                      </div>
                    </td>
                    <td className="px-6 py-4 font-mono text-[11px] text-muted">
                      {source.contract.collectorId ?? 'not created yet'}
                    </td>
                    <td className="px-6 py-4 text-muted">
                      {source.latestRun === undefined ? (
                        '—'
                      ) : (
                        <span className="flex items-center gap-2">
                          <Tag state={source.latestRun.mode}>{source.latestRun.mode}</Tag>
                          <span className="numeric text-[11px]">
                            {formatWhen(source.latestRun.startedAt)}
                          </span>
                        </span>
                      )}
                    </td>
                    <td className="numeric px-6 py-4 text-right">
                      {source.latestRun?.rowCount ?? '—'}
                    </td>
                    <td className="px-6 py-4">
                      {source.latestRun === undefined ? (
                        <Tag state="replay">no runs</Tag>
                      ) : (
                        <SeverityTag severity={source.latestRun.severity} />
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>

      {withRuns.some((source) => source.findings.length > 0) && (
        <section>
          <h2 className="mb-6 font-serif text-3xl tracking-[-0.02em]">What is wrong right now</h2>
          <div className="space-y-3">
            {withRuns.flatMap((source) =>
              source.findings.map((finding, index) => (
                <div
                  key={`${source.contract.id}-${finding.code}-${String(index)}`}
                  data-reveal
                  style={{ '--reveal-index': index } as React.CSSProperties}
                  className="rounded-[var(--radius-card)] border border-line bg-surface px-6 py-4"
                >
                  <div className="flex flex-wrap items-center gap-3">
                    <SeverityTag severity={finding.severity} />
                    <span className="font-mono text-[11px] text-muted">
                      {source.contract.name} · {finding.field ?? 'run'} · {finding.code}
                    </span>
                  </div>
                  <p className="mt-2 text-[15px]">{finding.message}</p>
                  <dl className="mt-3 grid gap-x-8 gap-y-1 text-[13px] sm:grid-cols-2">
                    <div className="flex gap-2">
                      <dt className="font-mono text-[10px] tracking-[0.1em] text-muted uppercase">
                        observed
                      </dt>
                      <dd className="text-ink-soft">{finding.observed}</dd>
                    </div>
                    <div className="flex gap-2">
                      <dt className="font-mono text-[10px] tracking-[0.1em] text-muted uppercase">
                        expected
                      </dt>
                      <dd className="text-ink-soft">{finding.expected}</dd>
                    </div>
                  </dl>
                </div>
              )),
            )}
          </div>
        </section>
      )}
    </div>
  );
}
