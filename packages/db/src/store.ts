/**
 * The store: every read and write Weaver performs against SQLite.
 *
 * Deliberately a single class with task-shaped methods (`recordRun`,
 * `loadBaselineHistory`, `openIncident`) rather than a thin repository per
 * table. Callers should never have to know that a run report is spread across
 * three tables, or remember to write `field_stats` after `runs`.
 *
 * Migrations are applied on open, so `pnpm db:push` and a fresh clone converge
 * on the same schema with no manual step.
 */
import { createHash, randomUUID } from 'node:crypto';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createClient, type Client } from '@libsql/client';
import { and, desc, eq, inArray, sql } from 'drizzle-orm';
import { drizzle, type LibSQLDatabase } from 'drizzle-orm/libsql';
import { migrate } from 'drizzle-orm/libsql/migrator';
import type { Finding, RunReport, RunStatistics, Severity, SourceContract } from '@weaver/core';
import {
  collectedRows,
  fieldStats,
  findings as findingsTable,
  incidentEvents,
  incidents,
  runs,
  sources,
} from './schema.js';

export type RunMode = 'live' | 'replay' | 'chaos';

export interface RunRecord {
  readonly id: string;
  readonly sourceId: string;
  readonly collectionId: string | null;
  readonly mode: RunMode;
  readonly startedAt: string;
  readonly finishedAt: string;
  readonly durationMs: number;
  readonly rowCount: number;
  readonly severity: Severity;
}

export interface RecordRunInput {
  readonly contract: SourceContract;
  readonly mode: RunMode;
  readonly collectionId: string | null;
  readonly rows: readonly unknown[];
  readonly report: RunReport;
  readonly startedAt: string;
  readonly finishedAt: string;
  readonly durationMs: number;
}

export type IncidentStatus = 'open' | 'healing' | 'awaiting_approval' | 'resolved' | 'escalated';

export type IncidentEventKind =
  | 'detected'
  | 'heal_requested'
  | 'preview_received'
  | 'preview_verified'
  | 'preview_rejected'
  | 'approved'
  | 'rejected'
  | 'reverified'
  | 'resolved'
  | 'escalated';

export interface IncidentRecord {
  readonly id: string;
  readonly sourceId: string;
  readonly collectorId: string | null;
  readonly status: IncidentStatus;
  readonly severity: 'degraded' | 'broken';
  readonly summary: string;
  readonly healAttempts: number;
  readonly openedAt: string;
  readonly closedAt: string | null;
  readonly mttrMs: number | null;
}

export interface IncidentEventRecord {
  readonly id: string;
  readonly incidentId: string;
  readonly at: string;
  readonly kind: IncidentEventKind;
  readonly message: string;
  readonly detail: unknown;
}

/**
 * Migrations live beside the source, one directory up.
 *
 * Built by hand from `import.meta.url` rather than with `new URL('../migrations',
 * import.meta.url)`, because bundlers treat that form as a static asset reference
 * and try to resolve it at build time — which fails, since a directory is not a
 * module. An environment override exists for deployments that relocate them.
 */
const MIGRATIONS_DIR =
  process.env.WEAVER_MIGRATIONS_DIR ??
  join(dirname(fileURLToPath(import.meta.url)), '..', 'migrations');

export class WeaverStore {
  private constructor(
    private readonly db: LibSQLDatabase<Record<string, never>>,
    private readonly client: Client,
  ) {}

  /** Open (creating if needed) the database at `path` and apply migrations. */
  static async open(path: string): Promise<WeaverStore> {
    const client = createClient({ url: toFileUrl(path) });
    const db = drizzle(client);
    await migrate(db, { migrationsFolder: MIGRATIONS_DIR });
    await client.execute('PRAGMA foreign_keys = ON');
    return new WeaverStore(db, client);
  }

  close(): void {
    this.client.close();
  }

  /**
   * Mirror a contract into the database.
   *
   * The contract hash is stored so run history can show that expectations
   * changed, which matters when a heal was triggered by the contract moving
   * ahead of the scraper rather than by the site changing.
   */
  async syncSource(contract: SourceContract, now = new Date().toISOString()): Promise<void> {
    const hash = hashContract(contract);

    await this.db
      .insert(sources)
      .values({
        id: contract.id,
        name: contract.name,
        type: contract.type,
        collectorId: contract.collectorId,
        targetUrl: contract.targetUrl,
        contractHash: hash,
        fieldCount: contract.schema.length,
        createdAt: now,
        updatedAt: now,
      })
      .onConflictDoUpdate({
        target: sources.id,
        set: {
          name: contract.name,
          type: contract.type,
          collectorId: contract.collectorId,
          targetUrl: contract.targetUrl,
          contractHash: hash,
          fieldCount: contract.schema.length,
          updatedAt: now,
        },
      });
  }

  /**
   * Persist one run: the raw payload, the normalised rows, the per-field
   * statistics and every finding, as one unit.
   *
   * Re-recording the same rows is safe: rows are keyed by (run, row key), so a
   * retried ingest updates rather than duplicates.
   */
  async recordRun(input: RecordRunInput): Promise<RunRecord> {
    const runId = randomUUID();
    const now = new Date().toISOString();

    const record: RunRecord = {
      id: runId,
      sourceId: input.contract.id,
      collectionId: input.collectionId,
      mode: input.mode,
      startedAt: input.startedAt,
      finishedAt: input.finishedAt,
      durationMs: input.durationMs,
      rowCount: input.report.statistics.rowCount,
      severity: input.report.severity,
    };

    await this.db.insert(runs).values({
      ...record,
      rawPayloadJson: JSON.stringify(input.rows),
      createdAt: now,
    });

    await this.insertRows(runId, input);
    await this.insertFieldStats(runId, input.contract.id, input.report.statistics, now);
    await this.insertFindings(runId, input.contract.id, input.report.findings, now);

    return record;
  }

  private async insertRows(runId: string, input: RecordRunInput): Promise<void> {
    const values = input.rows.filter(isRecord).map((row) => ({
      id: randomUUID(),
      runId,
      sourceId: input.contract.id,
      rowKey: rowKeyFor(input.contract, row),
      dataJson: JSON.stringify(row),
      collectedAt: input.finishedAt,
    }));

    // Two inputs can collapse onto the same row key when a site redirects; keep
    // the first and move on rather than failing the whole run.
    const seen = new Set<string>();
    const unique = values.filter((value) => {
      if (seen.has(value.rowKey)) return false;
      seen.add(value.rowKey);
      return true;
    });

    if (unique.length > 0) await this.db.insert(collectedRows).values(unique);
  }

  private async insertFieldStats(
    runId: string,
    sourceId: string,
    statistics: RunStatistics,
    now: string,
  ): Promise<void> {
    const values = Object.values(statistics.fields).map((stats) => ({
      id: randomUUID(),
      runId,
      sourceId,
      field: stats.field,
      presentCount: stats.presentCount,
      missingCount: stats.missingCount,
      fillRate: stats.fillRate,
      distinctCount: stats.distinctCount,
      invalidCount: stats.invalidCount,
      median: stats.numeric?.median ?? null,
      minimum: stats.numeric?.minimum ?? null,
      maximum: stats.numeric?.maximum ?? null,
      createdAt: now,
    }));

    if (values.length > 0) await this.db.insert(fieldStats).values(values);
  }

  private async insertFindings(
    runId: string,
    sourceId: string,
    items: readonly Finding[],
    now: string,
  ): Promise<void> {
    if (items.length === 0) return;

    await this.db.insert(findingsTable).values(
      items.map((finding) => ({
        id: randomUUID(),
        runId,
        sourceId,
        code: finding.code,
        field: finding.field,
        severity: finding.severity,
        message: finding.message,
        observed: finding.observed,
        expected: finding.expected,
        createdAt: now,
      })),
    );
  }

  /**
   * The statistics of recent healthy runs, newest first, shaped for
   * `buildBaseline`.
   *
   * Only `ok` runs contribute. Including a broken run would teach the baseline
   * that broken is normal, which is how monitoring systems go quiet.
   *
   * The reconstructed `RunStatistics` carry only the fields a baseline reads —
   * row count, fill rate and median. Samples and validation details are not
   * needed to decide what "normal" looks like.
   */
  async loadBaselineHistory(sourceId: string, limit = 10): Promise<readonly RunStatistics[]> {
    const healthyRuns = await this.db
      .select({ id: runs.id, rowCount: runs.rowCount })
      .from(runs)
      .where(and(eq(runs.sourceId, sourceId), eq(runs.severity, 'ok')))
      .orderBy(desc(runs.startedAt))
      .limit(limit);

    if (healthyRuns.length === 0) return [];

    const stats = await this.db
      .select()
      .from(fieldStats)
      .where(
        inArray(
          fieldStats.runId,
          healthyRuns.map((run) => run.id),
        ),
      );

    return healthyRuns.map((run) => {
      const fields: Record<string, RunStatistics['fields'][string]> = {};
      for (const row of stats.filter((item) => item.runId === run.id)) {
        fields[row.field] = {
          field: row.field,
          presentCount: row.presentCount,
          missingCount: row.missingCount,
          invalidCount: row.invalidCount,
          coercedCount: 0,
          fillRate: row.fillRate,
          distinctCount: row.distinctCount,
          numeric:
            row.median === null
              ? undefined
              : {
                  count: row.presentCount,
                  median: row.median,
                  minimum: row.minimum ?? row.median,
                  maximum: row.maximum ?? row.median,
                },
          samples: [],
          firstInvalid: undefined,
        };
      }
      return { rowCount: run.rowCount, fields, absentFields: [], unknownKeys: [] };
    });
  }

  async listRuns(sourceId?: string, limit = 20): Promise<readonly RunRecord[]> {
    const query = this.db
      .select({
        id: runs.id,
        sourceId: runs.sourceId,
        collectionId: runs.collectionId,
        mode: runs.mode,
        startedAt: runs.startedAt,
        finishedAt: runs.finishedAt,
        durationMs: runs.durationMs,
        rowCount: runs.rowCount,
        severity: runs.severity,
      })
      .from(runs)
      .orderBy(desc(runs.startedAt))
      .limit(limit);

    return sourceId === undefined ? query : query.where(eq(runs.sourceId, sourceId));
  }

  async findingsForRun(runId: string): Promise<readonly Finding[]> {
    const rows = await this.db.select().from(findingsTable).where(eq(findingsTable.runId, runId));

    return rows.map((row) => ({
      code: row.code as Finding['code'],
      severity: row.severity,
      field: row.field,
      message: row.message,
      observed: row.observed ?? '',
      expected: row.expected ?? '',
    }));
  }

  /** The raw payload of a run, for replay and for before/after diffs. */
  async rawPayload(runId: string): Promise<readonly unknown[]> {
    const [row] = await this.db
      .select({ payload: runs.rawPayloadJson })
      .from(runs)
      .where(eq(runs.id, runId))
      .limit(1);

    if (row === undefined) return [];
    const parsed: unknown = JSON.parse(row.payload);
    return Array.isArray(parsed) ? (parsed as readonly unknown[]) : [];
  }

  /** The most recent run for a source, whatever its severity. */
  async latestRun(sourceId: string): Promise<RunRecord | undefined> {
    const [run] = await this.listRuns(sourceId, 1);
    return run;
  }

  async openIncident(input: {
    readonly sourceId: string;
    readonly collectorId: string | null;
    readonly severity: 'degraded' | 'broken';
    readonly summary: string;
    readonly detectedRunId: string;
    readonly openedAt: string;
  }): Promise<IncidentRecord> {
    const incident: IncidentRecord = {
      id: randomUUID(),
      sourceId: input.sourceId,
      collectorId: input.collectorId,
      status: 'open',
      severity: input.severity,
      summary: input.summary,
      healAttempts: 0,
      openedAt: input.openedAt,
      closedAt: null,
      mttrMs: null,
    };

    await this.db.insert(incidents).values({
      ...incident,
      detectedRunId: input.detectedRunId,
      resolvedRunId: null,
    });

    return incident;
  }

  /** The open incident for a source, if there is one. */
  async openIncidentFor(sourceId: string): Promise<IncidentRecord | undefined> {
    const [row] = await this.db
      .select()
      .from(incidents)
      .where(
        and(
          eq(incidents.sourceId, sourceId),
          inArray(incidents.status, ['open', 'healing', 'awaiting_approval']),
        ),
      )
      .orderBy(desc(incidents.openedAt))
      .limit(1);

    return row === undefined ? undefined : toIncidentRecord(row);
  }

  async appendIncidentEvent(input: {
    readonly incidentId: string;
    readonly kind: IncidentEventKind;
    readonly message: string;
    readonly detail?: unknown;
    readonly at: string;
  }): Promise<void> {
    await this.db.insert(incidentEvents).values({
      id: randomUUID(),
      incidentId: input.incidentId,
      at: input.at,
      kind: input.kind,
      message: input.message,
      detailJson: input.detail === undefined ? null : JSON.stringify(input.detail),
    });
  }

  async setIncidentStatus(input: {
    readonly incidentId: string;
    readonly status: IncidentStatus;
    readonly healAttempts?: number;
    readonly closedAt?: string;
    readonly mttrMs?: number;
    readonly resolvedRunId?: string;
  }): Promise<void> {
    await this.db
      .update(incidents)
      .set({
        status: input.status,
        ...(input.healAttempts === undefined ? {} : { healAttempts: input.healAttempts }),
        ...(input.closedAt === undefined ? {} : { closedAt: input.closedAt }),
        ...(input.mttrMs === undefined ? {} : { mttrMs: input.mttrMs }),
        ...(input.resolvedRunId === undefined ? {} : { resolvedRunId: input.resolvedRunId }),
      })
      .where(eq(incidents.id, input.incidentId));
  }

  async listIncidents(limit = 20): Promise<readonly IncidentRecord[]> {
    const rows = await this.db
      .select()
      .from(incidents)
      .orderBy(desc(incidents.openedAt))
      .limit(limit);

    return rows.map(toIncidentRecord);
  }

  async incidentTimeline(incidentId: string): Promise<readonly IncidentEventRecord[]> {
    const rows = await this.db
      .select()
      .from(incidentEvents)
      .where(eq(incidentEvents.incidentId, incidentId))
      .orderBy(incidentEvents.at);

    return rows.map((row) => ({
      id: row.id,
      incidentId: row.incidentId,
      at: row.at,
      kind: row.kind,
      message: row.message,
      detail: row.detailJson === null ? undefined : (JSON.parse(row.detailJson) as unknown),
    }));
  }

  /**
   * The newest row per (source, row key) — the current state of the world.
   *
   * This is what the price comparison reads: one row per product per pharmacy,
   * as of the latest successful collection.
   */
  async latestRowsPerSource(): Promise<readonly { sourceId: string; data: unknown }[]> {
    const result = await this.client.execute(`
      SELECT source_id, data_json
      FROM collected_rows
      WHERE id IN (
        SELECT id FROM (
          SELECT id, ROW_NUMBER() OVER (
            PARTITION BY source_id, row_key ORDER BY collected_at DESC
          ) AS recency
          FROM collected_rows
        ) ranked
        WHERE ranked.recency = 1
      )
    `);

    return result.rows.map((row) => ({
      sourceId: asText(row.source_id),
      data: JSON.parse(asText(row.data_json)) as unknown,
    }));
  }

  /** Counts for the dashboard header, in one query per metric. */
  async summary(): Promise<{
    readonly runCount: number;
    readonly rowCount: number;
    readonly openIncidents: number;
  }> {
    const [runCount] = await this.db.select({ value: sql<number>`count(*)` }).from(runs);
    const [rowCount] = await this.db.select({ value: sql<number>`count(*)` }).from(collectedRows);
    const [openCount] = await this.db
      .select({ value: sql<number>`count(*)` })
      .from(incidents)
      .where(inArray(incidents.status, ['open', 'healing', 'awaiting_approval']));

    return {
      runCount: runCount?.value ?? 0,
      rowCount: rowCount?.value ?? 0,
      openIncidents: openCount?.value ?? 0,
    };
  }
}

/** Stable identity for a row, from the contract's `row_key` fields. */
export function rowKeyFor(contract: SourceContract, row: Record<string, unknown>): string {
  const parts = contract.rowKey.map((key) => asText(row[key]));
  const joined = parts.join('|');
  // A row with no usable key still needs a unique identity, or the whole run
  // collapses into one row.
  return joined.replace(/\|+$/, '') === '' ? `anonymous:${randomUUID()}` : joined;
}

/**
 * Render a value from SQLite or from a scraped payload as text.
 *
 * libSQL types a column value as `string | number | bigint | ArrayBuffer | null`,
 * and scraped rows are `unknown`, so neither can be handed to `String()`
 * directly without risking `[object Object]` in a primary key.
 */
function asText(value: unknown): string {
  if (value === null || value === undefined) return '';
  if (typeof value === 'string') return value;
  if (typeof value === 'number' || typeof value === 'bigint' || typeof value === 'boolean') {
    return String(value);
  }
  return JSON.stringify(value) ?? '';
}

export function hashContract(contract: SourceContract): string {
  return createHash('sha256').update(JSON.stringify(contract)).digest('hex').slice(0, 16);
}

function toIncidentRecord(row: typeof incidents.$inferSelect): IncidentRecord {
  return {
    id: row.id,
    sourceId: row.sourceId,
    collectorId: row.collectorId,
    status: row.status,
    severity: row.severity,
    summary: row.summary,
    healAttempts: row.healAttempts,
    openedAt: row.openedAt,
    closedAt: row.closedAt,
    mttrMs: row.mttrMs,
  };
}

function toFileUrl(path: string): string {
  return path.startsWith('file:') ? path : `file:${path}`;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
