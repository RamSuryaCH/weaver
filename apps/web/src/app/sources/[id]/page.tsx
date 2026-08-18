import Link from 'next/link';
import { notFound } from 'next/navigation';
import { Command, Empty, FillBar, SeverityTag, Tag } from '@/components/primitives';
import { loadSource, sourceContracts } from '@/lib/data';
import { formatWhen } from '@/lib/format';

export const dynamic = 'force-dynamic';

export function generateStaticParams() {
  return sourceContracts().map((contract) => ({ id: contract.id }));
}

export default async function SourcePage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const detail = await loadSource(id);
  if (detail === undefined) notFound();

  const { contract, latestRun, findings, runs, fieldStats, sampleRows } = detail;

  return (
    <div>
      <Link
        href="/"
        className="font-mono text-[11px] tracking-[0.08em] text-muted uppercase hover:text-ink"
      >
        ← overview
      </Link>

      <header className="mt-6 mb-12 border-b border-line pb-8">
        <div className="flex flex-wrap items-center gap-3">
          <Tag state={contract.type}>{contract.type}</Tag>
          {latestRun !== undefined && <SeverityTag severity={latestRun.severity} />}
        </div>

        <h1 className="mt-4 font-serif text-5xl leading-[1.05] tracking-[-0.03em]">
          {contract.name}
        </h1>

        <dl className="mt-6 grid gap-x-10 gap-y-2 font-mono text-[11px] text-muted sm:grid-cols-2 lg:grid-cols-4">
          <div className="flex gap-2">
            <dt className="uppercase">collector</dt>
            <dd className="text-ink-soft">{contract.collectorId ?? 'not created yet'}</dd>
          </div>
          <div className="flex gap-2">
            <dt className="uppercase">inputs</dt>
            <dd className="text-ink-soft">{(contract.inputs.urls ?? []).length} urls</dd>
          </div>
          <div className="flex gap-2">
            <dt className="uppercase">expects</dt>
            <dd className="text-ink-soft">{contract.expectations.minRows}+ rows</dd>
          </div>
          <div className="flex gap-2">
            <dt className="uppercase">heal policy</dt>
            <dd className="text-ink-soft">{contract.policy.heal}</dd>
          </div>
        </dl>
      </header>

      {latestRun === undefined ? (
        <Empty>
          No runs recorded. Try <Command>{`pnpm weaver collect --source ${contract.id}`}</Command>.
        </Empty>
      ) : (
        <>
          <section className="mb-16">
            <h2 className="mb-6 font-serif text-3xl tracking-[-0.02em]">
              The contract, field by field
            </h2>

            <div className="overflow-hidden rounded-[var(--radius-card)] border border-line bg-surface">
              <table className="w-full text-left text-sm">
                <thead>
                  <tr className="border-b border-line font-mono text-[10px] tracking-[0.1em] text-muted uppercase">
                    <th scope="col" className="px-6 py-3 font-normal">
                      Field
                    </th>
                    <th scope="col" className="px-6 py-3 font-normal">
                      Fill
                    </th>
                    <th scope="col" className="px-6 py-3 text-right font-normal">
                      Distinct
                    </th>
                    <th scope="col" className="px-6 py-3 text-right font-normal">
                      Invalid
                    </th>
                    <th scope="col" className="px-6 py-3 text-right font-normal">
                      Median
                    </th>
                  </tr>
                </thead>
                <tbody>
                  {fieldStats.map((stats) => (
                    <tr key={stats.field} className="border-b border-line last:border-0">
                      <td className="max-w-md px-6 py-4">
                        <div className="flex items-center gap-2">
                          <span className="font-mono text-[12px]">{stats.field}</span>
                          {stats.required && <Tag state="replay">required</Tag>}
                        </div>
                        {/* The description is the load-bearing part of the contract:
                            it creates the scraper, validates it, and heals it. */}
                        <p className="mt-1 text-[13px] text-muted">{stats.description}</p>
                      </td>
                      <td className="px-6 py-4">
                        <span className="flex items-center gap-3">
                          <FillBar rate={stats.fillRate} />
                          <span className="numeric text-[12px]">
                            {Math.round(stats.fillRate * 100)}%
                          </span>
                        </span>
                      </td>
                      <td className="numeric px-6 py-4 text-right">{stats.distinctCount}</td>
                      <td
                        className={`numeric px-6 py-4 text-right ${stats.invalidCount > 0 ? 'text-state-bad-ink' : 'text-muted'}`}
                      >
                        {stats.invalidCount}
                      </td>
                      <td className="numeric px-6 py-4 text-right">
                        {stats.median === null ? '—' : stats.median.toFixed(2)}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>

            {findings.length > 0 && (
              <div className="mt-4 space-y-2">
                {findings.map((finding, index) => (
                  <div
                    key={index}
                    className="rounded-[var(--radius-control)] border border-line bg-surface px-5 py-3 text-[13px]"
                  >
                    <div className="flex flex-wrap items-center gap-2">
                      <SeverityTag severity={finding.severity} />
                      <span className="font-mono text-[11px] text-muted">
                        {finding.field ?? 'run'} · {finding.code}
                      </span>
                    </div>
                    <p className="mt-1.5 text-ink-soft">{finding.message}</p>
                  </div>
                ))}
              </div>
            )}
          </section>

          <section className="mb-16">
            <h2 className="mb-6 font-serif text-3xl tracking-[-0.02em]">Run history</h2>
            <div className="overflow-hidden rounded-[var(--radius-card)] border border-line bg-surface">
              <table className="w-full text-left text-sm">
                <thead>
                  <tr className="border-b border-line font-mono text-[10px] tracking-[0.1em] text-muted uppercase">
                    <th scope="col" className="px-6 py-3 font-normal">
                      Started
                    </th>
                    <th scope="col" className="px-6 py-3 font-normal">
                      Mode
                    </th>
                    <th scope="col" className="px-6 py-3 font-normal">
                      Collection
                    </th>
                    <th scope="col" className="px-6 py-3 text-right font-normal">
                      Rows
                    </th>
                    <th scope="col" className="px-6 py-3 font-normal">
                      Verdict
                    </th>
                  </tr>
                </thead>
                <tbody>
                  {runs.map((run) => (
                    <tr key={run.id} className="border-b border-line last:border-0">
                      <td className="numeric px-6 py-3 text-[12px]">{formatWhen(run.startedAt)}</td>
                      <td className="px-6 py-3">
                        <Tag state={run.mode}>{run.mode}</Tag>
                      </td>
                      <td className="px-6 py-3 font-mono text-[11px] text-muted">
                        {run.collectionId ?? '—'}
                      </td>
                      <td className="numeric px-6 py-3 text-right">{run.rowCount}</td>
                      <td className="px-6 py-3">
                        <SeverityTag severity={run.severity} />
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </section>

          {sampleRows.length > 0 && (
            <section>
              <h2 className="mb-6 font-serif text-3xl tracking-[-0.02em]">
                What the collector returned
              </h2>
              <pre className="overflow-x-auto rounded-[var(--radius-card)] border border-line bg-surface px-6 py-5 font-mono text-[12px] leading-relaxed">
                {JSON.stringify(sampleRows, null, 2)}
              </pre>
            </section>
          )}
        </>
      )}
    </div>
  );
}
