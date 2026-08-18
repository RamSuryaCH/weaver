/**
 * End-to-end engine tests.
 *
 * These run the real store, the real detection engine and the real fixture
 * store against a temp directory. Only Bright Data itself is stubbed, and only
 * at the `fetch` seam — so the assertions cover the whole pipeline a live
 * collection takes, including incident lifecycle and MTTR.
 */
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { parseSourceContract, type SourceContract } from '@weaver/core';
import { BrightDataCollectionClient, type FetchLike } from '@weaver/brightdata';
import { WeaverStore } from '@weaver/db';
import {
  collectSource,
  collectorInputs,
  FixtureStore,
  LiveModeUnavailableError,
  MissingCollectorError,
  type EngineDeps,
} from './index.js';

const COLLECTOR_ID = 'c_mpohus372o5tmid1jk';

function contract(overrides: Record<string, unknown> = {}): SourceContract {
  return parseSourceContract({
    id: 'truemeds',
    name: 'Truemeds',
    type: 'pdp',
    target_url: 'https://www.truemeds.in',
    collector_id: COLLECTOR_ID,
    description: 'Extract medicine product details from a product page.',
    row_key: ['product_url'],
    expectations: { min_rows: 4, max_row_drop_pct: 30 },
    inputs: {
      urls: [
        'https://www.truemeds.in/medicine/a',
        'https://www.truemeds.in/medicine/b',
        'https://www.truemeds.in/medicine/c',
        'https://www.truemeds.in/medicine/d',
        'https://www.truemeds.in/medicine/e',
      ],
    },
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
        description: 'the printed maximum retail price in rupees before any discount',
        type: 'number',
        required: true,
        validate: { gt: 0, lt: 100000 },
        drift: { median_shift_pct: 30, flag_constant: true },
      },
    ],
    ...overrides,
  });
}

function healthyRows(count = 5): Record<string, unknown>[] {
  return Array.from({ length: count }, (_unused, index) => ({
    product_url: `https://www.truemeds.in/medicine/product-${index}`,
    mrp: 120 + index * 9,
  }));
}

describe('collectSource', () => {
  let dir: string;
  let store: WeaverStore;
  let fixtures: FixtureStore;
  let clock: Date;
  let deps: EngineDeps;

  beforeEach(async () => {
    dir = mkdtempSync(join(tmpdir(), 'weaver-engine-'));
    store = await WeaverStore.open(join(dir, 'test.db'));
    fixtures = new FixtureStore(join(dir, 'fixtures'));
    clock = new Date('2026-08-18T10:00:00.000Z');
    deps = { store, fixtures, now: () => clock };
  });

  afterEach(() => {
    store.close();
    rmSync(dir, { recursive: true, force: true });
  });

  function advance(minutes: number): void {
    clock = new Date(clock.getTime() + minutes * 60_000);
  }

  describe('replay mode', () => {
    beforeEach(() => {
      fixtures.record({
        sourceId: 'truemeds',
        collectorId: COLLECTOR_ID,
        collectedAt: '2026-08-18T09:00:00.000Z',
        rows: healthyRows(),
      });
    });

    it('records a healthy run and opens no incident', async () => {
      const outcome = await collectSource(deps, { contract: contract(), mode: 'replay' });

      expect(outcome.report.severity).toBe('ok');
      expect(outcome.incidentId).toBeUndefined();
      expect(outcome.run.mode).toBe('replay');
      expect((await store.summary()).runCount).toBe(1);
    });

    it('spends nothing, because no client is configured at all', async () => {
      // The absence of a collection client is the proof: replay cannot reach the
      // network even if it wanted to.
      expect(deps.collectionClient).toBeUndefined();

      await expect(
        collectSource(deps, { contract: contract(), mode: 'replay' }),
      ).resolves.toBeDefined();
    });

    it('fails helpfully when there is no recorded run to replay', async () => {
      await expect(
        collectSource(deps, { contract: contract({ id: 'dawaadost' }), mode: 'replay' }),
      ).rejects.toThrow(/no recorded run/);
    });
  });

  describe('the incident lifecycle', () => {
    beforeEach(() => {
      fixtures.record({
        sourceId: 'truemeds',
        collectorId: COLLECTOR_ID,
        collectedAt: '2026-08-18T09:00:00.000Z',
        rows: healthyRows(),
      });
    });

    it('opens an incident when a chaos run breaks the contract', async () => {
      const outcome = await collectSource(deps, {
        contract: contract(),
        mode: 'chaos',
        chaos: { mutation: 'null-field', field: 'mrp' },
      });

      expect(outcome.report.severity).toBe('broken');
      expect(outcome.incidentId).toBeDefined();

      const incident = await store.openIncidentFor('truemeds');
      expect(incident?.status).toBe('open');
      expect(incident?.summary).toContain('mrp');

      const timeline = await store.incidentTimeline(incident!.id);
      expect(timeline.map((event) => event.kind)).toEqual(['detected']);
    });

    it('stores a chaos run as chaos, so it can never be mistaken for real data', async () => {
      const outcome = await collectSource(deps, {
        contract: contract(),
        mode: 'chaos',
        chaos: { mutation: 'empty-snapshot' },
      });

      expect(outcome.run.mode).toBe('chaos');
      expect(outcome.run.collectionId).toBeNull();
    });

    it('adds to the existing incident rather than filing a second one', async () => {
      const first = await collectSource(deps, {
        contract: contract(),
        mode: 'chaos',
        chaos: { mutation: 'null-field', field: 'mrp' },
      });
      advance(360);
      const second = await collectSource(deps, {
        contract: contract(),
        mode: 'chaos',
        chaos: { mutation: 'null-field', field: 'mrp' },
      });

      expect(second.incidentId).toBe(first.incidentId);
      expect(await store.listIncidents()).toHaveLength(1);

      const timeline = await store.incidentTimeline(first.incidentId!);
      expect(timeline).toHaveLength(2);
      expect(timeline[1]?.message).toContain('still broken');
    });

    it('closes the incident and records MTTR when the source recovers', async () => {
      const broken = await collectSource(deps, {
        contract: contract(),
        mode: 'chaos',
        chaos: { mutation: 'null-field', field: 'mrp' },
      });
      advance(12);
      const recovered = await collectSource(deps, { contract: contract(), mode: 'replay' });

      expect(recovered.report.severity).toBe('ok');
      expect(recovered.incidentId).toBe(broken.incidentId);
      expect(await store.openIncidentFor('truemeds')).toBeUndefined();

      const [incident] = await store.listIncidents();
      expect(incident?.status).toBe('resolved');
      expect(incident?.mttrMs).toBe(12 * 60_000);

      const timeline = await store.incidentTimeline(incident!.id);
      expect(timeline.at(-1)?.kind).toBe('resolved');
    });

    it('reports progress events a live console can stream', async () => {
      const events: string[] = [];
      const outcome = await collectSource(
        { ...deps, log: (event) => events.push(event.kind) },
        { contract: contract(), mode: 'chaos', chaos: { mutation: 'drop-field', field: 'mrp' } },
      );

      expect(outcome.report.severity).toBe('broken');
      expect(events).toEqual([
        'source_started',
        'rows_received',
        'report_ready',
        'incident_opened',
        'source_finished',
      ]);
    });
  });

  describe('live mode', () => {
    it('refuses to run without an api key, naming the two ways to supply one', async () => {
      await expect(collectSource(deps, { contract: contract(), mode: 'live' })).rejects.toThrow(
        LiveModeUnavailableError,
      );
    });

    it('refuses to run a source whose scraper has not been created', async () => {
      const client = new BrightDataCollectionClient({ apiKey: 'k', fetch: neverCalled });

      await expect(
        collectSource(
          { ...deps, collectionClient: client },
          { contract: contract({ collector_id: null }), mode: 'live' },
        ),
      ).rejects.toThrow(MissingCollectorError);
    });

    it('collects, records, and writes a fixture so the run can be replayed later', async () => {
      const rows = healthyRows();
      const responses = [jsonResponse({ collection_id: 'j_live1' }), jsonResponse(rows)];
      const client = new BrightDataCollectionClient({
        apiKey: 'k',
        fetch: () => Promise.resolve(responses.shift()!),
        sleep: () => Promise.resolve(),
      });

      const outcome = await collectSource(
        { ...deps, collectionClient: client },
        { contract: contract(), mode: 'live' },
      );

      expect(outcome.run.mode).toBe('live');
      expect(outcome.run.collectionId).toBe('j_live1');
      expect(outcome.report.severity).toBe('ok');

      // The recorded fixture is the payload Bright Data actually returned.
      const [path] = fixtures.list('truemeds');
      expect(path).toBeDefined();
      const recorded: unknown = JSON.parse(readFileSync(path!, 'utf8'));
      expect((recorded as { rows: unknown[] }).rows).toEqual(rows);
    });

    it('sends only the first n inputs when limited', async () => {
      const bodies: string[] = [];
      const responses = [jsonResponse({ collection_id: 'j_live2' }), jsonResponse(healthyRows())];
      const fetch: FetchLike = (_url, init) => {
        if (typeof init?.body === 'string') bodies.push(init.body);
        return Promise.resolve(responses.shift()!);
      };
      const client = new BrightDataCollectionClient({ apiKey: 'k', fetch });

      await collectSource(
        { ...deps, collectionClient: client },
        { contract: contract(), mode: 'live', limit: 2 },
      );

      expect(JSON.parse(bodies[0] ?? '[]')).toHaveLength(2);
    });
  });
});

describe('collectorInputs', () => {
  it('maps urls, keywords and sitemaps onto Collection API inputs', () => {
    const search = parseSourceContract({
      id: 'truemeds-search',
      name: 'Truemeds search',
      type: 'search',
      target_url: 'https://www.truemeds.in',
      description: 'Find medicines matching a keyword.',
      row_key: ['product_url'],
      inputs: { keywords: ['pantoprazole 40mg', 'metformin 500'] },
      schema: [
        {
          field: 'product_url',
          description: 'the canonical URL of the matching product page',
          type: 'url',
          required: true,
        },
      ],
    });

    // A Search collector takes a keyword and no URL at all.
    expect(collectorInputs(search)).toEqual([
      { keyword: 'pantoprazole 40mg' },
      { keyword: 'metformin 500' },
    ]);
  });

  it('respects a limit', () => {
    expect(collectorInputs(contract(), 2)).toHaveLength(2);
  });
});

function jsonResponse(body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { 'Content-Type': 'application/json' },
  });
}

const neverCalled: FetchLike = () => {
  throw new Error('the network must not be touched in this test');
};
