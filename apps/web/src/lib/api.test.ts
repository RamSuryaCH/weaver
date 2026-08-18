/**
 * Tests for the dashboard's read path and its JSON API.
 *
 * The routes are exercised as functions against a real temp database, which
 * covers the part that can break silently: the status code the health endpoint
 * returns. A machine polling `/api/v1/health` must not read a broken pipeline as
 * healthy, and that is a behaviour, not a detail of rendering.
 */
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { parseSourceContract, type SourceContract } from '@weaver/core';
import { WeaverStore } from '@weaver/db';
import { collectSource, FixtureStore } from '@weaver/engine';

let dir: string;

function contract(id: string, name: string): SourceContract {
  return parseSourceContract({
    id,
    name,
    type: 'pdp',
    target_url: `https://${id}.test`,
    collector_id: 'c_mpohus372o5tmid1jk',
    description: 'Extract medicine product details from a product page.',
    row_key: ['product_url'],
    expectations: { min_rows: 2, max_row_drop_pct: 30 },
    inputs: { urls: [`https://${id}.test/medicine/a`, `https://${id}.test/medicine/b`] },
    schema: [
      {
        field: 'product_url',
        description: 'the canonical URL of this medicine product page',
        type: 'url',
        required: true,
        min_fill_rate: 1,
      },
      {
        field: 'product_name',
        description: 'the brand name of the medicine as printed on the page',
        type: 'string',
        required: true,
      },
      {
        field: 'composition',
        description: 'the active ingredients of the medicine as listed on the page',
        type: 'string',
        required: true,
      },
      {
        field: 'selling_price',
        description: 'the price in rupees a customer actually pays today',
        type: 'number',
        required: true,
        validate: { gt: 0, lt: 100000 },
      },
    ],
  });
}

function rows(host: string, price: number): Record<string, unknown>[] {
  return [
    {
      product_url: `https://${host}/medicine/pan-40-tablet-15s`,
      product_name: 'Pan 40 Tablet 15s',
      composition: 'pantoprazole 40mg',
      selling_price: price,
    },
    {
      product_url: `https://${host}/medicine/glycomet-500-tablet-10s`,
      product_name: 'Glycomet 500 Tablet 10s',
      composition: 'metformin 500mg',
      selling_price: price / 3,
    },
  ];
}

beforeAll(async () => {
  dir = mkdtempSync(join(tmpdir(), 'weaver-web-'));
  process.env.WEAVER_DB_PATH = join(dir, 'test.db');
  process.env.WEAVER_MODE = 'replay';

  const store = await WeaverStore.open(process.env.WEAVER_DB_PATH);
  const fixtures = new FixtureStore(join(dir, 'fixtures'));
  const now = () => new Date('2026-08-18T10:00:00.000Z');

  for (const [id, name, price] of [
    ['truemeds', 'Truemeds', 210],
    ['dawaadost', 'Dawaa Dost', 168],
  ] as const) {
    fixtures.record({
      sourceId: id,
      collectorId: 'c_mpohus372o5tmid1jk',
      collectedAt: '2026-08-18T09:00:00.000Z',
      rows: rows(`${id}.test`, price),
    });
    await collectSource({ store, fixtures, now }, { contract: contract(id, name), mode: 'replay' });
  }

  store.close();
});

afterAll(() => {
  rmSync(dir, { recursive: true, force: true });
});

describe('GET /api/v1/prices', () => {
  it('serves comparisons normalised to price per unit', async () => {
    const { GET } = await import('../app/api/v1/prices/route.js');

    const response = await GET(new Request('http://localhost/api/v1/prices'));
    const body = (await response.json()) as {
      count: number;
      comparisons: { molecule: string; cheapest: { sourceId: string }; savingsPct: number }[];
    };

    expect(response.status).toBe(200);
    expect(body.count).toBeGreaterThan(0);

    const pantoprazole = body.comparisons.find((item) => item.molecule.includes('pantoprazole'));
    expect(pantoprazole?.cheapest.sourceId).toBe('dawaadost');
    expect(pantoprazole?.savingsPct).toBeGreaterThan(0);
  });

  it('filters by molecule', async () => {
    const { GET } = await import('../app/api/v1/prices/route.js');

    const response = await GET(new Request('http://localhost/api/v1/prices?molecule=metformin'));
    const body = (await response.json()) as { comparisons: { molecule: string }[] };

    expect(body.comparisons).toHaveLength(1);
    expect(body.comparisons[0]?.molecule).toContain('metformin');
  });

  it('reports an empty result rather than failing on an unknown molecule', async () => {
    const { GET } = await import('../app/api/v1/prices/route.js');

    const response = await GET(new Request('http://localhost/api/v1/prices?molecule=ibuprofen'));
    const body = (await response.json()) as { count: number };

    expect(response.status).toBe(200);
    expect(body.count).toBe(0);
  });
});

describe('GET /api/v1/health', () => {
  it('reports ok with 200 when every source that has run satisfies its contract', async () => {
    const { GET } = await import('../app/api/v1/health/route.js');

    const response = await GET();
    const body = (await response.json()) as {
      status: string;
      sources: { id: string; severity: string | null }[];
    };

    expect(response.status).toBe(200);
    expect(body.status).toBe('ok');

    // Every configured contract appears, including ones that have never run —
    // a source with no runs is a real state and hiding it would be misleading.
    const seeded = body.sources.filter((source) => source.severity !== null);
    expect(seeded.map((source) => source.id).sort()).toEqual(['dawaadost', 'truemeds']);
    expect(seeded.every((source) => source.severity === 'ok')).toBe(true);
  });

  it('answers 503 once a source is broken, so a poller cannot read it as healthy', async () => {
    const store = await WeaverStore.open(process.env.WEAVER_DB_PATH!);
    const fixtures = new FixtureStore(join(dir, 'fixtures'));
    await collectSource(
      { store, fixtures, now: () => new Date('2026-08-18T12:00:00.000Z') },
      {
        contract: contract('truemeds', 'Truemeds'),
        mode: 'chaos',
        chaos: { mutation: 'null-field', field: 'selling_price' },
      },
    );
    store.close();

    const { GET } = await import('../app/api/v1/health/route.js');
    const response = await GET();
    const body = (await response.json()) as { status: string; openIncidents: number };

    expect(response.status).toBe(503);
    expect(body.status).toBe('broken');
    expect(body.openIncidents).toBe(1);
  });
});
