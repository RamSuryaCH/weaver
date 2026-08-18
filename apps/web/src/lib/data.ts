/**
 * Server-side data access for the dashboard.
 *
 * The dashboard is a read-only view over the database the CLI writes, so this
 * module opens the store, reads, and closes. There is no separate API layer and
 * no duplicated business logic: severity, findings and price comparison all come
 * from `@weaver/core`, which is the same code the CLI and the MCP server use.
 */
import { loadSourceContracts, readEnv } from '@weaver/config';
import {
  compareByMolecule,
  readOffers,
  type MoleculeComparison,
  type SourceContract,
} from '@weaver/core';
import {
  WeaverStore,
  type IncidentEventRecord,
  type IncidentRecord,
  type RunRecord,
} from '@weaver/db';
import type { Finding } from '@weaver/core';

export interface SourceOverview {
  readonly contract: SourceContract;
  readonly latestRun: RunRecord | undefined;
  readonly findings: readonly Finding[];
  readonly runs: readonly RunRecord[];
}

export interface DashboardData {
  readonly sources: readonly SourceOverview[];
  readonly incidents: readonly IncidentRecord[];
  readonly summary: {
    readonly runCount: number;
    readonly rowCount: number;
    readonly openIncidents: number;
  };
  readonly mode: string;
  readonly healPolicy: string;
  readonly resolvedIncidents: readonly IncidentRecord[];
}

/**
 * Open the store for one request, then close it.
 *
 * A long-lived connection would be faster, but a file-backed SQLite database
 * opened per request keeps the dev server, `next build` and the CLI from fighting
 * over a handle — and at this scale the cost is unmeasurable.
 */
async function withStore<T>(read: (store: WeaverStore) => Promise<T>): Promise<T> {
  const env = readEnv();
  const store = await WeaverStore.open(env.dbPath);
  try {
    return await read(store);
  } finally {
    store.close();
  }
}

export function sourceContracts(): readonly SourceContract[] {
  return loadSourceContracts(process.env.WEAVER_SOURCES_DIR ?? 'sources');
}

export async function loadDashboard(): Promise<DashboardData> {
  const env = readEnv();
  const contracts = sourceContracts();

  return await withStore(async (store) => {
    const sources: SourceOverview[] = [];

    for (const contract of contracts) {
      const runs = await store.listRuns(contract.id, 12);
      const latestRun = runs[0];
      sources.push({
        contract,
        latestRun,
        findings: latestRun === undefined ? [] : await store.findingsForRun(latestRun.id),
        runs,
      });
    }

    const incidents = await store.listIncidents(20);

    return {
      sources,
      incidents,
      resolvedIncidents: incidents.filter((incident) => incident.status === 'resolved'),
      summary: await store.summary(),
      mode: env.mode,
      healPolicy: env.healPolicy,
    };
  });
}

export interface SourceDetail extends SourceOverview {
  readonly fieldStats: readonly {
    readonly field: string;
    readonly description: string;
    readonly required: boolean;
    readonly fillRate: number;
    readonly distinctCount: number;
    readonly invalidCount: number;
    readonly median: number | null;
  }[];
  readonly sampleRows: readonly unknown[];
}

export async function loadSource(id: string): Promise<SourceDetail | undefined> {
  const contract = sourceContracts().find((candidate) => candidate.id === id);
  if (contract === undefined) return undefined;

  return await withStore(async (store) => {
    const runs = await store.listRuns(contract.id, 12);
    const latestRun = runs[0];

    if (latestRun === undefined) {
      return { contract, latestRun: undefined, findings: [], runs, fieldStats: [], sampleRows: [] };
    }

    const payload = await store.rawPayload(latestRun.id);
    const { computeRunStatistics } = await import('@weaver/core');
    const statistics = computeRunStatistics(contract, payload);

    return {
      contract,
      latestRun,
      runs,
      findings: await store.findingsForRun(latestRun.id),
      fieldStats: contract.schema.map((field) => {
        const stats = statistics.fields[field.field];
        return {
          field: field.field,
          description: field.description,
          required: field.required,
          fillRate: stats?.fillRate ?? 0,
          distinctCount: stats?.distinctCount ?? 0,
          invalidCount: stats?.invalidCount ?? 0,
          median: stats?.numeric?.median ?? null,
        };
      }),
      sampleRows: payload.slice(0, 3),
    };
  });
}

export interface IncidentDetail {
  readonly incident: IncidentRecord;
  readonly timeline: readonly IncidentEventRecord[];
  readonly contract: SourceContract | undefined;
}

export async function loadIncident(id: string): Promise<IncidentDetail | undefined> {
  return await withStore(async (store) => {
    const incident = (await store.listIncidents(100)).find((candidate) => candidate.id === id);
    if (incident === undefined) return undefined;

    return {
      incident,
      timeline: await store.incidentTimeline(id),
      contract: sourceContracts().find((candidate) => candidate.id === incident.sourceId),
    };
  });
}

export async function loadPriceComparisons(): Promise<readonly MoleculeComparison[]> {
  return await withStore(async (store) =>
    compareByMolecule(readOffers(await store.latestRowsPerSource())),
  );
}
