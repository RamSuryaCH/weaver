/**
 * Store tests run against a real SQLite file in a temp directory.
 *
 * Mocking a database would test the mock. These tests are fast anyway (libSQL
 * opens a file in milliseconds) and they catch the things that actually break:
 * migrations, unique constraints and the window function behind
 * `latestRowsPerSource`.
 */
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  buildBaseline,
  detectDrift,
  computeRunStatistics,
  parseSourceContract,
  type SourceContract,
} from '@weaver/core';
import { rowKeyFor, WeaverStore } from './store.js';

function contract(): SourceContract {
  return parseSourceContract({
    id: 'truemeds',
    name: 'Truemeds',
    type: 'pdp',
    target_url: 'https://www.truemeds.in',
    collector_id: 'c_mpohus372o5tmid1jk',
    description: 'Extract medicine product details from a product page.',
    row_key: ['product_url'],
    expectations: { min_rows: 2, max_row_drop_pct: 30 },
    inputs: { urls: ['https://www.truemeds.in/medicine/a'] },
    schema: [
      {
        field: 'product_url',
        description: 'the canonical URL of this medicine product page',
        type: 'url',
        required: true,
        min_fill_rate: 1,
      },
      {
        field: 'mrp',
        description: 'the printed maximum retail price in rupees before discount',
        type: 'number',
        required: true,
        validate: { gt: 0, lt: 100000 },
      },
    ],
  });
}

function rows(count: number, priceBase = 100): Record<string, unknown>[] {
  return Array.from({ length: count }, (_unused, index) => ({
    product_url: `https://www.truemeds.in/medicine/product-${index}`,
    mrp: priceBase + index,
  }));
}

async function record(
  store: WeaverStore,
  payload: readonly Record<string, unknown>[],
  startedAt: string,
): Promise<{ runId: string; severity: string }> {
  const sourceContract = contract();
  const statistics = computeRunStatistics(sourceContract, payload);
  const history = await store.loadBaselineHistory(sourceContract.id);
  const report = detectDrift({
    contract: sourceContract,
    statistics,
    baseline: buildBaseline(history),
    generatedAt: startedAt,
  });

  const run = await store.recordRun({
    contract: sourceContract,
    mode: 'replay',
    collectionId: null,
    rows: payload,
    report,
    startedAt,
    finishedAt: startedAt,
    durationMs: 1234,
  });

  return { runId: run.id, severity: run.severity };
}

describe('WeaverStore', () => {
  let dir: string;
  let store: WeaverStore;

  beforeEach(async () => {
    dir = mkdtempSync(join(tmpdir(), 'weaver-store-'));
    store = await WeaverStore.open(join(dir, 'test.db'));
    await store.syncSource(contract());
  });

  afterEach(() => {
    store.close();
    rmSync(dir, { recursive: true, force: true });
  });

  it('applies migrations on open, so a fresh clone needs no manual step', async () => {
    await expect(store.summary()).resolves.toEqual({
      runCount: 0,
      rowCount: 0,
      openIncidents: 0,
    });
  });

  it('is idempotent when the same source is synced twice', async () => {
    await store.syncSource(contract());
    await store.syncSource(contract());

    const runs = await store.listRuns();
    expect(runs).toEqual([]);
  });

  it('records a run with its rows, statistics and findings', async () => {
    const { runId, severity } = await record(store, rows(5), '2026-08-18T10:00:00.000Z');

    expect(severity).toBe('ok');
    const summary = await store.summary();
    expect(summary.runCount).toBe(1);
    expect(summary.rowCount).toBe(5);
    expect(await store.findingsForRun(runId)).toEqual([]);
  });

  it('persists findings so an incident can cite them later', async () => {
    const broken = rows(5).map(({ mrp: _dropped, ...rest }) => rest);

    const { runId, severity } = await record(store, broken, '2026-08-18T10:00:00.000Z');

    expect(severity).toBe('broken');
    const findings = await store.findingsForRun(runId);
    expect(findings).toHaveLength(1);
    expect(findings[0]?.code).toBe('field_absent');
    expect(findings[0]?.field).toBe('mrp');
  });

  it('keeps the raw payload verbatim for replay and diffs', async () => {
    const payload = rows(3);
    const { runId } = await record(store, payload, '2026-08-18T10:00:00.000Z');

    expect(await store.rawPayload(runId)).toEqual(payload);
  });

  it('collapses duplicate row keys within a run instead of failing', async () => {
    // Two inputs can redirect to the same canonical URL.
    const duplicated = [...rows(2), ...rows(2)];

    const { runId } = await record(store, duplicated, '2026-08-18T10:00:00.000Z');

    expect(await store.rawPayload(runId)).toHaveLength(4);
    expect((await store.summary()).rowCount).toBe(2);
  });

  describe('baselines', () => {
    it('builds history only from healthy runs', async () => {
      await record(store, rows(5), '2026-08-18T10:00:00.000Z');
      await record(store, rows(5), '2026-08-18T11:00:00.000Z');
      // A broken run must not teach the baseline that broken is normal.
      await record(
        store,
        rows(5).map(({ mrp: _dropped, ...rest }) => rest),
        '2026-08-18T12:00:00.000Z',
      );

      const history = await store.loadBaselineHistory('truemeds');

      expect(history).toHaveLength(2);
      expect(history.every((run) => run.fields.mrp?.fillRate === 1)).toBe(true);
    });

    it('carries the median forward so drift can be measured against it', async () => {
      for (const [index, hour] of ['10', '11', '12'].entries()) {
        await record(store, rows(5, 100 + index), `2026-08-18T${hour}:00:00.000Z`);
      }

      const baseline = buildBaseline(await store.loadBaselineHistory('truemeds'));

      expect(baseline.runCount).toBe(3);
      expect(baseline.medianRowCount).toBe(5);
      expect(baseline.fields.mrp?.medianValue).toBeCloseTo(103, 0);
    });

    it('returns nothing for a source with no healthy history', async () => {
      expect(await store.loadBaselineHistory('truemeds')).toEqual([]);
    });
  });

  describe('incidents', () => {
    it('opens an incident, records its timeline and resolves it with an MTTR', async () => {
      const { runId } = await record(
        store,
        rows(5).map(({ mrp: _dropped, ...rest }) => rest),
        '2026-08-18T10:00:00.000Z',
      );

      const incident = await store.openIncident({
        sourceId: 'truemeds',
        collectorId: 'c_mpohus372o5tmid1jk',
        severity: 'broken',
        summary: 'mrp is missing from all 5 rows',
        detectedRunId: runId,
        openedAt: '2026-08-18T10:00:00.000Z',
      });

      await store.appendIncidentEvent({
        incidentId: incident.id,
        kind: 'heal_requested',
        message: 'sent heal prompt',
        detail: { prompt: 'The mrp field returns null for every row.' },
        at: '2026-08-18T10:01:00.000Z',
      });
      await store.appendIncidentEvent({
        incidentId: incident.id,
        kind: 'preview_verified',
        message: 'preview satisfied the contract',
        at: '2026-08-18T10:08:00.000Z',
      });
      await store.setIncidentStatus({
        incidentId: incident.id,
        status: 'resolved',
        healAttempts: 1,
        closedAt: '2026-08-18T10:10:00.000Z',
        mttrMs: 600_000,
      });

      const timeline = await store.incidentTimeline(incident.id);
      expect(timeline.map((event) => event.kind)).toEqual(['heal_requested', 'preview_verified']);
      expect(timeline[0]?.detail).toEqual({
        prompt: 'The mrp field returns null for every row.',
      });

      const [stored] = await store.listIncidents();
      expect(stored?.status).toBe('resolved');
      expect(stored?.mttrMs).toBe(600_000);
      expect((await store.summary()).openIncidents).toBe(0);
    });

    it('finds the open incident for a source and ignores resolved ones', async () => {
      const { runId } = await record(store, rows(5), '2026-08-18T10:00:00.000Z');

      const resolved = await store.openIncident({
        sourceId: 'truemeds',
        collectorId: null,
        severity: 'degraded',
        summary: 'old',
        detectedRunId: runId,
        openedAt: '2026-08-17T10:00:00.000Z',
      });
      await store.setIncidentStatus({ incidentId: resolved.id, status: 'resolved' });

      expect(await store.openIncidentFor('truemeds')).toBeUndefined();

      const current = await store.openIncident({
        sourceId: 'truemeds',
        collectorId: null,
        severity: 'broken',
        summary: 'current',
        detectedRunId: runId,
        openedAt: '2026-08-18T10:00:00.000Z',
      });

      expect((await store.openIncidentFor('truemeds'))?.id).toBe(current.id);
    });
  });

  describe('latestRowsPerSource', () => {
    it('returns the newest row per product, not every row ever collected', async () => {
      await record(store, rows(3, 100), '2026-08-18T10:00:00.000Z');
      await record(store, rows(3, 200), '2026-08-18T11:00:00.000Z');

      const latest = await store.latestRowsPerSource();

      expect(latest).toHaveLength(3);
      const prices = latest.map((row) => (row.data as { mrp: number }).mrp).sort((a, b) => a - b);
      expect(prices).toEqual([200, 201, 202]);
    });
  });
});

describe('rowKeyFor', () => {
  it('joins the contract row_key fields', () => {
    const key = rowKeyFor(contract(), { product_url: 'https://a.test/p/1', mrp: 10 });

    expect(key).toBe('https://a.test/p/1');
  });

  it('gives an unkeyable row its own identity rather than merging rows', () => {
    const first = rowKeyFor(contract(), { mrp: 10 });
    const second = rowKeyFor(contract(), { mrp: 20 });

    expect(first).not.toBe(second);
    expect(first).toMatch(/^anonymous:/);
  });
});
