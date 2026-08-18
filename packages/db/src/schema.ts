/**
 * The database schema.
 *
 * SQLite on purpose: the whole point of `WEAVER_MODE=replay` is that a judge can
 * clone this repo and see a real incident timeline without provisioning
 * anything. A file-backed database is the only choice that keeps that promise.
 *
 * Two conventions run through every table:
 *
 * - Timestamps are ISO 8601 strings, not epoch integers, because these rows are
 *   read by humans in `sqlite3` as often as by code.
 * - Anything Bright Data sent us is kept verbatim in a `*_json` column beside
 *   the parsed columns. An incident is only useful as evidence if the raw
 *   envelope survived.
 */
import { index, integer, real, sqliteTable, text, uniqueIndex } from 'drizzle-orm/sqlite-core';

/** One row per `sources/*.yaml`, mirrored so the dashboard can join against it. */
export const sources = sqliteTable('sources', {
  id: text('id').primaryKey(),
  name: text('name').notNull(),
  type: text('type').notNull(),
  collectorId: text('collector_id'),
  targetUrl: text('target_url').notNull(),
  /** Hash of the contract, so a contract change is visible in run history. */
  contractHash: text('contract_hash').notNull(),
  fieldCount: integer('field_count').notNull(),
  createdAt: text('created_at').notNull(),
  updatedAt: text('updated_at').notNull(),
});

/**
 * One execution of a collector.
 *
 * `mode` records how the rows were obtained — live, replayed from a fixture, or
 * produced by the chaos harness. Weaver refuses to present chaos output as if it
 * were a real collection, so the distinction is stored, not inferred.
 */
export const runs = sqliteTable(
  'runs',
  {
    id: text('id').primaryKey(),
    sourceId: text('source_id')
      .notNull()
      .references(() => sources.id),
    /** Bright Data's `j_*` collection id. Null for replay and chaos runs. */
    collectionId: text('collection_id'),
    mode: text('mode', { enum: ['live', 'replay', 'chaos'] }).notNull(),
    startedAt: text('started_at').notNull(),
    finishedAt: text('finished_at').notNull(),
    durationMs: integer('duration_ms').notNull(),
    rowCount: integer('row_count').notNull(),
    severity: text('severity', { enum: ['ok', 'degraded', 'broken'] }).notNull(),
    /** Verbatim payload as returned, for replay and for evidence. */
    rawPayloadJson: text('raw_payload_json').notNull(),
    createdAt: text('created_at').notNull(),
  },
  (table) => [
    index('runs_source_started_idx').on(table.sourceId, table.startedAt),
    index('runs_severity_idx').on(table.severity),
  ],
);

/**
 * One collected record.
 *
 * `rowKey` is derived from the contract's `row_key` fields, which is what makes
 * a before/after diff across runs possible.
 */
export const collectedRows = sqliteTable(
  'collected_rows',
  {
    id: text('id').primaryKey(),
    runId: text('run_id')
      .notNull()
      .references(() => runs.id),
    sourceId: text('source_id')
      .notNull()
      .references(() => sources.id),
    rowKey: text('row_key').notNull(),
    dataJson: text('data_json').notNull(),
    collectedAt: text('collected_at').notNull(),
  },
  (table) => [
    uniqueIndex('collected_rows_run_key_idx').on(table.runId, table.rowKey),
    index('collected_rows_source_key_idx').on(table.sourceId, table.rowKey),
  ],
);

/**
 * Per-field measurements for one run.
 *
 * This table is the baseline. Drift detection compares a run's statistics
 * against the trailing statistics of previous healthy runs, rather than against
 * fixed thresholds, because the Scraper Studio AI schema omits absent fields
 * per row instead of nulling them.
 */
export const fieldStats = sqliteTable(
  'field_stats',
  {
    id: text('id').primaryKey(),
    runId: text('run_id')
      .notNull()
      .references(() => runs.id),
    sourceId: text('source_id')
      .notNull()
      .references(() => sources.id),
    field: text('field').notNull(),
    presentCount: integer('present_count').notNull(),
    missingCount: integer('missing_count').notNull(),
    fillRate: real('fill_rate').notNull(),
    distinctCount: integer('distinct_count').notNull(),
    invalidCount: integer('invalid_count').notNull(),
    median: real('median'),
    minimum: real('minimum'),
    maximum: real('maximum'),
    createdAt: text('created_at').notNull(),
  },
  (table) => [
    uniqueIndex('field_stats_run_field_idx').on(table.runId, table.field),
    index('field_stats_source_field_idx').on(table.sourceId, table.field),
  ],
);

/** One contract violation detected in one run. */
export const findings = sqliteTable(
  'findings',
  {
    id: text('id').primaryKey(),
    runId: text('run_id')
      .notNull()
      .references(() => runs.id),
    sourceId: text('source_id')
      .notNull()
      .references(() => sources.id),
    code: text('code').notNull(),
    field: text('field'),
    severity: text('severity', { enum: ['ok', 'degraded', 'broken'] }).notNull(),
    message: text('message').notNull(),
    observed: text('observed'),
    expected: text('expected'),
    createdAt: text('created_at').notNull(),
  },
  (table) => [index('findings_run_idx').on(table.runId)],
);

/**
 * The lifecycle of one degradation, from detection to resolution.
 *
 * `mttrMs` is stored rather than computed on read so that the dashboard can
 * aggregate it without replaying every event.
 */
export const incidents = sqliteTable(
  'incidents',
  {
    id: text('id').primaryKey(),
    sourceId: text('source_id')
      .notNull()
      .references(() => sources.id),
    /** The collector ID at the time of the incident; healing must not change it. */
    collectorId: text('collector_id'),
    status: text('status', {
      enum: ['open', 'healing', 'awaiting_approval', 'resolved', 'escalated'],
    }).notNull(),
    severity: text('severity', { enum: ['degraded', 'broken'] }).notNull(),
    summary: text('summary').notNull(),
    detectedRunId: text('detected_run_id').references(() => runs.id),
    resolvedRunId: text('resolved_run_id').references(() => runs.id),
    healAttempts: integer('heal_attempts').notNull().default(0),
    openedAt: text('opened_at').notNull(),
    closedAt: text('closed_at'),
    mttrMs: integer('mttr_ms'),
  },
  (table) => [
    index('incidents_source_idx').on(table.sourceId, table.openedAt),
    index('incidents_status_idx').on(table.status),
  ],
);

/**
 * The audit trail for an incident.
 *
 * Every heal prompt, every preview, and every approve-or-reject decision with
 * its reason lands here. This table is what the dashboard's incident timeline
 * renders, and it is the evidence that the verify-then-approve gate actually ran.
 */
export const incidentEvents = sqliteTable(
  'incident_events',
  {
    id: text('id').primaryKey(),
    incidentId: text('incident_id')
      .notNull()
      .references(() => incidents.id),
    at: text('at').notNull(),
    kind: text('kind', {
      enum: [
        'detected',
        'heal_requested',
        'preview_received',
        'preview_verified',
        'preview_rejected',
        'approved',
        'rejected',
        'reverified',
        'resolved',
        'escalated',
      ],
    }).notNull(),
    message: text('message').notNull(),
    /** Prompt text, preview rows, or the raw Bright Data envelope. */
    detailJson: text('detail_json'),
  },
  (table) => [index('incident_events_incident_idx').on(table.incidentId, table.at)],
);
