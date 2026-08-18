/**
 * One collection cycle: obtain rows, judge them against the contract, persist the
 * verdict, and open or close an incident.
 *
 * The three ways of obtaining rows — live, replay and chaos — converge on the
 * same detection and persistence path immediately after they are read. That is
 * deliberate: a chaos run must be judged by exactly the code that judges a live
 * run, or the harness proves nothing.
 */
import {
  applyChaos,
  buildBaseline,
  computeRunStatistics,
  detectDrift,
  type ChaosOptions,
  type RunReport,
  type SourceContract,
} from '@weaver/core';
import type { BrightDataCollectionClient, CollectorInput } from '@weaver/brightdata';
import type { RunMode, RunRecord, WeaverStore } from '@weaver/db';
import type { FixtureStore } from './fixtures.js';

export interface EngineEvent {
  readonly kind:
    | 'source_started'
    | 'trigger_sent'
    | 'poll'
    | 'rows_received'
    | 'report_ready'
    | 'incident_opened'
    | 'incident_resolved'
    | 'source_finished';
  readonly sourceId: string;
  readonly message: string;
}

export interface EngineDeps {
  readonly store: WeaverStore;
  readonly fixtures: FixtureStore;
  /** Required for live mode only; replay and chaos never touch the network. */
  readonly collectionClient?: BrightDataCollectionClient | undefined;
  readonly now: () => Date;
  readonly log?: (event: EngineEvent) => void;
}

export interface CollectOptions {
  readonly contract: SourceContract;
  readonly mode: RunMode;
  /** Only for `mode: 'chaos'`. */
  readonly chaos?: ChaosOptions;
  /** Cap inputs, for a cheap smoke test against a live collector. */
  readonly limit?: number;
}

export interface CollectOutcome {
  readonly run: RunRecord;
  readonly report: RunReport;
  readonly rows: readonly unknown[];
  readonly incidentId: string | undefined;
}

export class MissingCollectorError extends Error {
  constructor(sourceId: string) {
    super(
      `source "${sourceId}" has no collector_id yet. ` +
        'Run `weaver create --source ' +
        sourceId +
        '` first, then paste the c_* id into the contract.',
    );
    this.name = 'MissingCollectorError';
  }
}

export class LiveModeUnavailableError extends Error {
  constructor() {
    super(
      'live mode needs a Bright Data API key. Set BRIGHTDATA_API_KEY in .env, ' +
        'or run: npx -p @brightdata/cli bdata login',
    );
    this.name = 'LiveModeUnavailableError';
  }
}

export async function collectSource(
  deps: EngineDeps,
  options: CollectOptions,
): Promise<CollectOutcome> {
  const { contract, mode } = options;
  const log = deps.log ?? (() => undefined);

  log({ kind: 'source_started', sourceId: contract.id, message: `collecting in ${mode} mode` });
  await deps.store.syncSource(contract, deps.now().toISOString());

  const collected = await obtainRows(deps, options);
  log({
    kind: 'rows_received',
    sourceId: contract.id,
    message: `${collected.rows.length} rows in ${collected.durationMs}ms`,
  });

  const statistics = computeRunStatistics(contract, collected.rows);
  const baseline = buildBaseline(await deps.store.loadBaselineHistory(contract.id));
  const report = detectDrift({
    contract,
    statistics,
    baseline,
    generatedAt: deps.now().toISOString(),
  });

  log({
    kind: 'report_ready',
    sourceId: contract.id,
    message: `${report.severity}, ${report.findings.length} findings, baseline of ${report.baselineRuns} runs`,
  });

  const run = await deps.store.recordRun({
    contract,
    mode,
    collectionId: collected.collectionId,
    rows: collected.rows,
    report,
    startedAt: collected.startedAt,
    finishedAt: collected.finishedAt,
    durationMs: collected.durationMs,
  });

  const incidentId = await reconcileIncident(deps, contract, run, report, log);

  log({ kind: 'source_finished', sourceId: contract.id, message: report.severity });

  return { run, report, rows: collected.rows, incidentId };
}

interface ObtainedRows {
  readonly rows: readonly unknown[];
  readonly collectionId: string | null;
  readonly startedAt: string;
  readonly finishedAt: string;
  readonly durationMs: number;
}

async function obtainRows(deps: EngineDeps, options: CollectOptions): Promise<ObtainedRows> {
  switch (options.mode) {
    case 'live':
      return await collectLive(deps, options);
    case 'replay':
      return replayFixture(deps, options);
    case 'chaos':
      return chaosFromFixture(deps, options);
  }
}

async function collectLive(deps: EngineDeps, options: CollectOptions): Promise<ObtainedRows> {
  const { contract } = options;
  if (contract.collectorId === null) throw new MissingCollectorError(contract.id);
  if (deps.collectionClient === undefined) throw new LiveModeUnavailableError();

  const log = deps.log ?? (() => undefined);
  const inputs = collectorInputs(contract, options.limit);

  log({
    kind: 'trigger_sent',
    sourceId: contract.id,
    message: `${contract.collectorId} with ${inputs.length} inputs`,
  });

  const result = await deps.collectionClient.collect({
    collectorId: contract.collectorId,
    inputs,
    onProgress: (progress) => {
      log({
        kind: 'poll',
        sourceId: contract.id,
        message: `${progress.collectionId} ${progress.state} (poll ${progress.attempt})`,
      });
    },
  });

  // Recording every live run is what makes replay mode honest: the fixtures a
  // judge explores are the exact payloads Bright Data returned.
  deps.fixtures.record({
    sourceId: contract.id,
    collectorId: contract.collectorId,
    collectedAt: result.finishedAt,
    rows: result.rows,
  });

  return {
    rows: result.rows,
    collectionId: result.collectionId,
    startedAt: result.startedAt,
    finishedAt: result.finishedAt,
    durationMs: result.durationMs,
  };
}

function replayFixture(deps: EngineDeps, options: CollectOptions): ObtainedRows {
  const fixture = deps.fixtures.latest(options.contract.id);
  const at = deps.now().toISOString();

  return {
    rows: options.limit === undefined ? fixture.rows : fixture.rows.slice(0, options.limit),
    collectionId: null,
    startedAt: at,
    finishedAt: at,
    durationMs: 0,
  };
}

function chaosFromFixture(deps: EngineDeps, options: CollectOptions): ObtainedRows {
  if (options.chaos === undefined) {
    throw new Error('chaos mode needs a mutation');
  }

  const base = replayFixture(deps, options);
  return { ...base, rows: applyChaos(base.rows, options.chaos) };
}

/** Turn a contract's declared inputs into Collection API input objects. */
export function collectorInputs(
  contract: SourceContract,
  limit?: number,
): readonly CollectorInput[] {
  const inputs: CollectorInput[] = [
    ...(contract.inputs.urls ?? []).map((url) => ({ url })),
    ...(contract.inputs.keywords ?? []).map((keyword) => ({ keyword })),
    ...(contract.inputs.sitemaps ?? []).map((sitemap) => ({ url: sitemap })),
  ];

  return limit === undefined ? inputs : inputs.slice(0, limit);
}

/**
 * Open an incident when a run is unhealthy, close it when the source recovers.
 *
 * One incident per source at a time. A second broken run while an incident is
 * open is another data point on the same incident, not a new one — otherwise a
 * six-hourly cron would file four identical incidents a day.
 */
async function reconcileIncident(
  deps: EngineDeps,
  contract: SourceContract,
  run: RunRecord,
  report: RunReport,
  log: (event: EngineEvent) => void,
): Promise<string | undefined> {
  const existing = await deps.store.openIncidentFor(contract.id);
  const at = deps.now().toISOString();

  if (report.severity === 'ok') {
    if (existing === undefined) return undefined;

    const mttrMs = new Date(at).getTime() - new Date(existing.openedAt).getTime();
    await deps.store.appendIncidentEvent({
      incidentId: existing.id,
      kind: 'resolved',
      message: `source healthy again after ${Math.round(mttrMs / 1000)}s`,
      at,
    });
    await deps.store.setIncidentStatus({
      incidentId: existing.id,
      status: 'resolved',
      closedAt: at,
      mttrMs,
      resolvedRunId: run.id,
    });

    log({
      kind: 'incident_resolved',
      sourceId: contract.id,
      message: `incident closed, MTTR ${Math.round(mttrMs / 1000)}s`,
    });
    return existing.id;
  }

  const summary = report.findings[0]?.message ?? `${report.severity} run`;

  if (existing !== undefined) {
    await deps.store.appendIncidentEvent({
      incidentId: existing.id,
      kind: 'detected',
      message: `still ${report.severity}: ${summary}`,
      detail: { runId: run.id, findings: report.findings },
      at,
    });
    return existing.id;
  }

  const incident = await deps.store.openIncident({
    sourceId: contract.id,
    collectorId: contract.collectorId,
    severity: report.severity,
    summary,
    detectedRunId: run.id,
    openedAt: at,
  });
  await deps.store.appendIncidentEvent({
    incidentId: incident.id,
    kind: 'detected',
    message: summary,
    detail: { runId: run.id, findings: report.findings },
    at,
  });

  log({
    kind: 'incident_opened',
    sourceId: contract.id,
    message: `${report.severity}: ${summary}`,
  });

  return incident.id;
}
