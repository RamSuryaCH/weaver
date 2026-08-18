/**
 * MCP tool tests, driven through a real MCP client over an in-memory transport.
 *
 * Calling the registered tools rather than the functions behind them is the whole
 * point: it verifies the tool names, the input schemas and the guard rails an
 * agent will actually meet. A test that called `healSource` directly would prove
 * nothing about what an agent can and cannot do.
 */
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { parseSourceContract, type SourceContract } from '@weaver/core';
import { ScraperStudioCli, type CommandRunner } from '@weaver/brightdata';
import { WeaverStore } from '@weaver/db';
import { collectSource, FixtureStore } from '@weaver/engine';
import type { WeaverEnv } from '@weaver/config';
import { createWeaverServer } from './server.js';

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
    expectations: { min_rows: 3, max_row_drop_pct: 30 },
    inputs: {
      urls: [
        'https://www.truemeds.in/medicine/pan-40',
        'https://www.truemeds.in/medicine/glycomet-500',
        'https://www.truemeds.in/medicine/allegra-120',
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
        drift: { flag_constant: true },
      },
    ],
    ...overrides,
  });
}

function pharmacyRows(sourceId: string, price: number): Record<string, unknown>[] {
  const host = sourceId === 'truemeds' ? 'www.truemeds.in' : 'www.dawaadost.com';
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
      selling_price: price / 4,
    },
    {
      product_url: `https://${host}/medicine/allegra-120-tablet-10s`,
      product_name: 'Allegra 120 Tablet 10s',
      composition: 'fexofenadine 120mg',
      selling_price: price * 1.2,
    },
  ];
}

const env: WeaverEnv = {
  mode: 'replay',
  dbPath: 'unused',
  healPolicy: 'gated',
  escalationRepo: undefined,
  hasApiKey: false,
};

describe('the Weaver MCP server', () => {
  let dir: string;
  let store: WeaverStore;
  let fixtures: FixtureStore;
  let client: Client;
  let cliCalls: string[][];

  async function connect(options: {
    readonly env?: WeaverEnv;
    readonly contracts?: readonly SourceContract[];
    readonly cliScript?: readonly string[];
  }): Promise<void> {
    cliCalls = [];
    const queue = [...(options.cliScript ?? [])];
    const run: CommandRunner = (args) => {
      cliCalls.push([...args]);
      const stdout = queue.shift();
      if (stdout === undefined) throw new Error(`unexpected bdata call: ${args.join(' ')}`);
      return Promise.resolve({ stdout, stderr: '', exitCode: 0 });
    };

    const server = createWeaverServer({
      env: options.env ?? env,
      contracts: options.contracts ?? [contract()],
      store,
      fixtures,
      cli: new ScraperStudioCli({ run }),
      now: () => new Date('2026-08-18T12:00:00.000Z'),
    });

    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    client = new Client({ name: 'test', version: '1.0.0' });
    await Promise.all([client.connect(clientTransport), server.connect(serverTransport)]);
  }

  /** The text a tool returned, joined. */
  async function call(name: string, args: Record<string, unknown> = {}): Promise<string> {
    const result = await client.callTool({ name, arguments: args });
    const content = result.content as { type: string; text?: string }[] | undefined;
    return (content ?? [])
      .map((part) => part.text ?? '')
      .join('\n')
      .trim();
  }

  beforeEach(async () => {
    dir = mkdtempSync(join(tmpdir(), 'weaver-mcp-'));
    store = await WeaverStore.open(join(dir, 'test.db'));
    fixtures = new FixtureStore(join(dir, 'fixtures'));
    fixtures.record({
      sourceId: 'truemeds',
      collectorId: COLLECTOR_ID,
      collectedAt: '2026-08-18T09:00:00.000Z',
      rows: pharmacyRows('truemeds', 210),
    });
  });

  afterEach(async () => {
    await client.close();
    store.close();
    rmSync(dir, { recursive: true, force: true });
  });

  it('advertises exactly the five Weaver tools', async () => {
    await connect({});

    const { tools } = await client.listTools();

    expect(tools.map((tool) => tool.name).sort()).toEqual([
      'weaver_collect',
      'weaver_compare_prices',
      'weaver_diagnose',
      'weaver_heal',
      'weaver_list_sources',
    ]);
  });

  it('marks the read-only tools read-only and the heal tool destructive', async () => {
    await connect({});

    const { tools } = await client.listTools();
    const byName = new Map(tools.map((tool) => [tool.name, tool.annotations]));

    expect(byName.get('weaver_diagnose')?.readOnlyHint).toBe(true);
    expect(byName.get('weaver_compare_prices')?.readOnlyHint).toBe(true);
    // An agent should be able to see that this one changes the world.
    expect(byName.get('weaver_heal')?.destructiveHint).toBe(true);
  });

  describe('weaver_list_sources', () => {
    it('lists each source with its collector id and last run', async () => {
      await connect({});

      const before = await call('weaver_list_sources');
      expect(before).toContain('truemeds');
      expect(before).toContain(COLLECTOR_ID);
      expect(before).toContain('no runs recorded');

      await call('weaver_collect', { source: 'truemeds', mode: 'replay' });

      expect(await call('weaver_list_sources')).toContain('last run ok');
    });
  });

  describe('weaver_collect', () => {
    it('collects and reports the verdict', async () => {
      await connect({});

      const output = await call('weaver_collect', { source: 'truemeds', mode: 'replay' });

      expect(output).toContain('ok');
      expect(output).toContain('3 rows');
    });

    it('names the unknown source rather than failing silently', async () => {
      await connect({});

      const result = await client.callTool({
        name: 'weaver_collect',
        arguments: { source: 'nosuchsource' },
      });

      expect(result.isError).toBe(true);
      expect(JSON.stringify(result.content)).toContain('unknown source');
    });
  });

  describe('weaver_diagnose', () => {
    it('asks for a collection first when there is nothing to diagnose', async () => {
      await connect({});

      expect(await call('weaver_diagnose', { source: 'truemeds' })).toContain(
        'Call weaver_collect first',
      );
    });

    it('explains every violation and shows the prompt it would send', async () => {
      await connect({});
      await collectSource(
        { store, fixtures, now: () => new Date('2026-08-18T11:00:00.000Z') },
        {
          contract: contract(),
          mode: 'chaos',
          chaos: { mutation: 'null-field', field: 'selling_price' },
        },
      );

      const output = await call('weaver_diagnose', { source: 'truemeds' });

      expect(output).toContain('field_absent');
      expect(output).toContain('observed:');
      expect(output).toContain('expected:');
      expect(output).toContain('The heal prompt Weaver would send:');
      expect(output).toContain('the price in rupees a customer actually pays today');
      // Read-only means read-only: nothing was sent to Bright Data.
      expect(cliCalls).toHaveLength(0);
    });

    it('says so when a finding is real but not healable', async () => {
      await connect({});
      await collectSource(
        { store, fixtures, now: () => new Date('2026-08-18T11:00:00.000Z') },
        {
          contract: contract(),
          mode: 'chaos',
          chaos: { mutation: 'rename-field', field: 'nothing_here' },
        },
      );

      const output = await call('weaver_diagnose', { source: 'truemeds' });

      expect(output).toContain('unknown_field');
      expect(output).toContain('never sent to a code refactorer');
    });
  });

  describe('weaver_heal', () => {
    beforeEach(async () => {
      await connect({
        cliScript: [
          JSON.stringify({
            collector_id: COLLECTOR_ID,
            status: 'awaiting_approval',
            preview_result: pharmacyRows('truemeds', 210),
          }),
          JSON.stringify({ collector_id: COLLECTOR_ID, status: 'done' }),
        ],
      });

      await collectSource(
        { store, fixtures, now: () => new Date('2026-08-18T11:00:00.000Z') },
        {
          contract: contract(),
          mode: 'chaos',
          chaos: { mutation: 'null-field', field: 'selling_price' },
        },
      );
    });

    it('refuses to touch a live collector without explicit confirmation', async () => {
      const output = await call('weaver_heal', { source: 'truemeds', confirm: false });

      expect(output).toContain('Refusing to heal');
      expect(cliCalls).toHaveLength(0);
    });

    it('requires confirm rather than defaulting it', async () => {
      const result = await client.callTool({
        name: 'weaver_heal',
        arguments: { source: 'truemeds' },
      });

      // The schema makes confirmation mandatory, so an agent cannot omit it.
      expect(result.isError).toBe(true);
      expect(cliCalls).toHaveLength(0);
    });

    it('runs the verify-then-approve loop when confirmed, and reports its reasoning', async () => {
      const output = await call('weaver_heal', {
        source: 'truemeds',
        confirm: true,
        attempts: 1,
      });

      expect(output).toContain('approved');
      expect(output).toContain('prompt:');
      expect(output).toContain('preview: 3 row(s)');
      expect(output).toContain('satisfied the contract');

      // The gate is not bypassable from an agent either.
      for (const args of cliCalls) {
        expect(args).not.toContain('--auto-approve');
      }
    });
  });

  it('refuses to heal under a manual policy, and says how to change it', async () => {
    await connect({ env: { ...env, healPolicy: 'manual' } });
    await collectSource(
      { store, fixtures, now: () => new Date('2026-08-18T11:00:00.000Z') },
      {
        contract: contract(),
        mode: 'chaos',
        chaos: { mutation: 'null-field', field: 'selling_price' },
      },
    );

    const output = await call('weaver_heal', { source: 'truemeds', confirm: true });

    expect(output).toContain('"manual"');
    expect(output).toContain('WEAVER_HEAL_POLICY');
    expect(cliCalls).toHaveLength(0);
  });

  describe('weaver_compare_prices', () => {
    it('asks for a collection when there is nothing to compare', async () => {
      await connect({});

      expect(await call('weaver_compare_prices')).toContain('Call weaver_collect first');
    });

    it('compares the same molecule across pharmacies, per unit', async () => {
      const second = contract({ id: 'dawaadost', name: 'Dawaa Dost' });
      fixtures.record({
        sourceId: 'dawaadost',
        collectorId: 'c_dawaadost000000000',
        collectedAt: '2026-08-18T09:30:00.000Z',
        rows: pharmacyRows('dawaadost', 168),
      });

      await connect({ contracts: [contract(), second] });
      await call('weaver_collect', { source: 'truemeds', mode: 'replay' });
      await call('weaver_collect', { source: 'dawaadost', mode: 'replay' });

      const output = await call('weaver_compare_prices', { molecule: 'pantoprazole' });

      expect(output).toContain('pantoprazole');
      expect(output).toContain('cheapest at dawaadost');
      expect(output).toContain('/unit');
    });

    it('reports honestly that no molecule matched', async () => {
      await connect({});
      await call('weaver_collect', { source: 'truemeds', mode: 'replay' });

      expect(await call('weaver_compare_prices', { molecule: 'ibuprofen' })).toContain(
        'No molecule available from more than one pharmacy',
      );
    });
  });
});
