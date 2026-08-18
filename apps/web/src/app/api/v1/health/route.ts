import { NextResponse } from 'next/server';
import { loadDashboard } from '@/lib/data';

export const dynamic = 'force-dynamic';

/**
 * GET /api/v1/health
 *
 * Machine-readable source health, so a scheduler or a status page can ask "is the
 * data trustworthy right now?" without parsing the dashboard.
 *
 * Read-only and unauthenticated: it exposes no credentials, no personal data, and
 * nothing that is not already visible on the dashboard.
 */
export async function GET(): Promise<NextResponse> {
  const data = await loadDashboard();

  const sources = data.sources.map((source) => ({
    id: source.contract.id,
    name: source.contract.name,
    type: source.contract.type,
    collectorId: source.contract.collectorId,
    severity: source.latestRun?.severity ?? null,
    lastRunAt: source.latestRun?.startedAt ?? null,
    rowCount: source.latestRun?.rowCount ?? null,
    findings: source.findings.map((finding) => ({
      code: finding.code,
      field: finding.field,
      severity: finding.severity,
      message: finding.message,
    })),
  }));

  const worst = sources.some((source) => source.severity === 'broken')
    ? 'broken'
    : sources.some((source) => source.severity === 'degraded')
      ? 'degraded'
      : 'ok';

  return NextResponse.json(
    {
      status: worst,
      generatedAt: new Date().toISOString(),
      mode: data.mode,
      healPolicy: data.healPolicy,
      openIncidents: data.summary.openIncidents,
      runCount: data.summary.runCount,
      rowCount: data.summary.rowCount,
      sources,
    },
    // A degraded pipeline should not read as healthy to a machine that only
    // checks the status code.
    { status: worst === 'broken' ? 503 : 200 },
  );
}
