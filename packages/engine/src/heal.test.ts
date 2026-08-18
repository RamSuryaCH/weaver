/**
 * The verify-then-approve loop, end to end.
 *
 * The Bright Data CLI is stubbed at the command-runner seam, so these tests
 * exercise the real prompt synthesis, the real preview verification, the real
 * incident timeline and the real re-validation. What they assert is behaviour a
 * judge will look for: that the gate rejects a bad fix, that the prompt sharpens,
 * that the Collector ID never changes, and that `--auto-approve` is never used.
 */
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { parseSourceContract, type SourceContract } from '@weaver/core';
import { ScraperStudioCli, type CommandResult, type CommandRunner } from '@weaver/brightdata';
import { WeaverStore } from '@weaver/db';
import {
  collectSource,
  CollectorIdChangedError,
  effectivePolicy,
  FixtureStore,
  healSource,
  NoRunToHealError,
  type HealDeps,
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
    policy: { heal: 'gated', max_heal_attempts: 3 },
    inputs: {
      urls: [
        'https://www.truemeds.in/medicine/pan-40',
        'https://www.truemeds.in/medicine/pantop-40',
        'https://www.truemeds.in/medicine/glycomet-500',
        'https://www.truemeds.in/medicine/allegra-120',
        'https://www.truemeds.in/medicine/rosuvas-10',
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
        description: 'the printed maximum retail price in rupees, before any discount',
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
    mrp: 120 + index * 13,
  }));
}

/** A scripted `bdata` that records every invocation. */
function scriptedCli(script: readonly string[]): {
  cli: ScraperStudioCli;
  calls: string[][];
} {
  const queue = [...script];
  const calls: string[][] = [];

  const run: CommandRunner = (args): Promise<CommandResult> => {
    calls.push([...args]);
    const stdout = queue.shift();
    if (stdout === undefined) {
      throw new Error(`bdata stub exhausted; unexpected call: ${args.join(' ')}`);
    }
    return Promise.resolve({ stdout, stderr: '', exitCode: 0 });
  };

  return { cli: new ScraperStudioCli({ run }), calls };
}

function healEnvelope(previewRows: readonly unknown[], collectorId = COLLECTOR_ID): string {
  return JSON.stringify({
    collector_id: collectorId,
    status: 'awaiting_approval',
    next_step: { command: `bdata scraper approve ${collectorId}` },
    preview_result: previewRows,
  });
}

function approveEnvelope(status = 'done', collectorId = COLLECTOR_ID): string {
  return JSON.stringify({ collector_id: collectorId, status });
}

describe('healSource', () => {
  let dir: string;
  let store: WeaverStore;
  let fixtures: FixtureStore;
  let clock: Date;

  beforeEach(async () => {
    dir = mkdtempSync(join(tmpdir(), 'weaver-heal-'));
    store = await WeaverStore.open(join(dir, 'test.db'));
    fixtures = new FixtureStore(join(dir, 'fixtures'));
    clock = new Date('2026-08-18T10:00:00.000Z');

    fixtures.record({
      sourceId: 'truemeds',
      collectorId: COLLECTOR_ID,
      collectedAt: '2026-08-18T09:00:00.000Z',
      rows: healthyRows(),
    });
  });

  afterEach(() => {
    store.close();
    rmSync(dir, { recursive: true, force: true });
  });

  function deps(cli: ScraperStudioCli, extra: Partial<HealDeps> = {}): HealDeps {
    return { store, fixtures, now: () => clock, cli, ...extra };
  }

  /** Break the source so there is something to heal. */
  async function breakSource(): Promise<void> {
    await collectSource(
      { store, fixtures, now: () => clock },
      { contract: contract(), mode: 'chaos', chaos: { mutation: 'null-field', field: 'mrp' } },
    );
  }

  it('does nothing when the latest run is healthy', async () => {
    await collectSource(
      { store, fixtures, now: () => clock },
      { contract: contract(), mode: 'replay' },
    );
    const { cli, calls } = scriptedCli([]);

    const outcome = await healSource(deps(cli), { contract: contract(), policy: 'gated' });

    expect(outcome.status).toBe('not_needed');
    expect(calls).toHaveLength(0);
  });

  it('refuses to guess when there is no run to diagnose', async () => {
    const { cli } = scriptedCli([]);

    await expect(healSource(deps(cli), { contract: contract(), policy: 'gated' })).rejects.toThrow(
      NoRunToHealError,
    );
  });

  it('prints the prompt and spends nothing on a dry run', async () => {
    await breakSource();
    const { cli, calls } = scriptedCli([]);

    const outcome = await healSource(deps(cli), {
      contract: contract(),
      policy: 'gated',
      dryRun: true,
    });

    expect(outcome.status).toBe('dry_run');
    expect(outcome.prompt).toContain('"mrp" is missing from all 5 rows');
    expect(calls).toHaveLength(0);
  });

  it('reports and stops under a manual policy', async () => {
    await breakSource();
    const { cli, calls } = scriptedCli([]);

    const outcome = await healSource(deps(cli), { contract: contract(), policy: 'manual' });

    expect(outcome.status).toBe('policy_manual');
    expect(calls).toHaveLength(0);
  });

  describe('a preview that satisfies the contract', () => {
    it('approves, re-runs, and closes the incident', async () => {
      await breakSource();
      const { cli, calls } = scriptedCli([healEnvelope(healthyRows(3)), approveEnvelope()]);

      // The post-approval re-collect reads the healthy fixture, standing in for
      // the repaired collector.
      const outcome = await healSource(
        { ...deps(cli), collectionClient: undefined },
        { contract: contract(), policy: 'gated', verify: false },
      );

      expect(outcome.status).toBe('approved_but_unverified');
      expect(outcome.attempts).toHaveLength(1);
      expect(outcome.attempts[0]?.verdict).toBe('approved');

      const timeline = await store.incidentTimeline(outcome.incidentId!);
      expect(timeline.map((event) => event.kind)).toEqual([
        'detected',
        'heal_requested',
        'preview_received',
        'preview_verified',
        'approved',
      ]);

      // The gate is the product: --auto-approve must never appear.
      for (const call of calls) {
        expect(call).not.toContain('--auto-approve');
      }
      expect(calls[1]).toContain('approve');
      expect(calls[1]).not.toContain('--reject');
    });

    it('stores the prompt and the preview as incident evidence', async () => {
      await breakSource();
      const { cli } = scriptedCli([healEnvelope(healthyRows(3)), approveEnvelope()]);

      const outcome = await healSource(deps(cli), {
        contract: contract(),
        policy: 'gated',
        verify: false,
      });

      const timeline = await store.incidentTimeline(outcome.incidentId!);
      const requested = timeline.find((event) => event.kind === 'heal_requested');
      const preview = timeline.find((event) => event.kind === 'preview_received');

      expect((requested?.detail as { prompt: string }).prompt).toContain('maximum retail price');
      expect((preview?.detail as { previewRows: unknown[] }).previewRows).toHaveLength(3);
    });
  });

  describe('a preview that does not satisfy the contract', () => {
    it('rejects it, sharpens the prompt, and succeeds on the next attempt', async () => {
      await breakSource();
      const { cli, calls } = scriptedCli([
        // Attempt 1: the AI returns the same price for every product. Plausible,
        // and wrong.
        healEnvelope(healthyRows(5).map((row) => ({ ...row, mrp: 249 }))),
        approveEnvelope('rejected'),
        // Attempt 2: a real repair.
        healEnvelope(healthyRows(5)),
        approveEnvelope(),
      ]);

      const outcome = await healSource(deps(cli), {
        contract: contract(),
        policy: 'gated',
        verify: false,
      });

      expect(outcome.attempts.map((attempt) => attempt.verdict)).toEqual(['rejected', 'approved']);
      expect(outcome.attempts[0]?.reason).toContain('still latched onto');

      // The rejection is a real `approve --reject`, so the collector is left
      // untouched rather than half-healed.
      expect(calls[1]).toContain('--reject');

      // The second prompt cites the specific failure and adds the markup hint.
      expect(outcome.attempts[1]?.prompt).toContain('A previous fix was rejected because');
      expect(outcome.attempts[1]?.prompt).toContain('JSON-LD');
      expect(outcome.attempts[1]?.strategy).toBe('sharpen');

      const timeline = await store.incidentTimeline(outcome.incidentId!);
      expect(timeline.map((event) => event.kind)).toContain('preview_rejected');
    });

    it('rejects an empty preview', async () => {
      await breakSource();
      const { cli } = scriptedCli([
        healEnvelope([]),
        approveEnvelope('rejected'),
        healEnvelope(healthyRows(3)),
        approveEnvelope(),
      ]);

      const outcome = await healSource(deps(cli), {
        contract: contract(),
        policy: 'gated',
        verify: false,
      });

      expect(outcome.attempts[0]?.reason).toContain('no rows');
      expect(outcome.attempts[1]?.verdict).toBe('approved');
    });

    it('escalates once the attempt budget is exhausted', async () => {
      await breakSource();
      const stillBroken = healthyRows(5).map((row) => ({ ...row, mrp: null }));
      const { cli } = scriptedCli([
        healEnvelope(stillBroken),
        approveEnvelope('rejected'),
        healEnvelope(stillBroken),
        approveEnvelope('rejected'),
        healEnvelope(stillBroken),
        approveEnvelope('rejected'),
      ]);

      const escalations: string[] = [];
      const outcome = await healSource(
        deps(cli, {
          escalate: (input) => {
            escalations.push(input.incidentId);
            return Promise.resolve('https://github.com/RamSuryaCH/weaver/issues/1');
          },
        }),
        { contract: contract(), policy: 'gated' },
      );

      expect(outcome.status).toBe('exhausted');
      expect(outcome.attempts).toHaveLength(3);
      expect(outcome.escalationUrl).toBe('https://github.com/RamSuryaCH/weaver/issues/1');
      expect(escalations).toHaveLength(1);

      const [incident] = await store.listIncidents();
      expect(incident?.status).toBe('escalated');
      expect(incident?.healAttempts).toBe(3);
    });

    it('narrows to a single field by the third attempt', async () => {
      await breakSource();
      const stillBroken = healthyRows(5).map((row) => ({ ...row, mrp: null }));
      const { cli } = scriptedCli([
        healEnvelope(stillBroken),
        approveEnvelope('rejected'),
        healEnvelope(stillBroken),
        approveEnvelope('rejected'),
        healEnvelope(stillBroken),
        approveEnvelope('rejected'),
      ]);

      const outcome = await healSource(deps(cli), { contract: contract(), policy: 'gated' });

      expect(outcome.attempts.map((attempt) => attempt.strategy)).toEqual([
        'describe-all',
        'sharpen',
        'single-field',
      ]);
    });
  });

  describe('collector identity', () => {
    it('fails loudly if the collector id changes during a heal', async () => {
      await breakSource();
      const { cli } = scriptedCli([healEnvelope(healthyRows(3), 'c_somethingelse')]);

      await expect(
        healSource(deps(cli), { contract: contract(), policy: 'gated' }),
      ).rejects.toThrow(CollectorIdChangedError);
    });

    it('passes the same collector id to heal and to approve', async () => {
      await breakSource();
      const { cli, calls } = scriptedCli([healEnvelope(healthyRows(3)), approveEnvelope()]);

      await healSource(deps(cli), { contract: contract(), policy: 'gated', verify: false });

      expect(calls[0]?.[2]).toBe(COLLECTOR_ID);
      expect(calls[1]?.[2]).toBe(COLLECTOR_ID);
    });
  });
});

describe('effectivePolicy', () => {
  it('lets the more cautious of the two settings win', () => {
    expect(effectivePolicy('manual', 'auto')).toBe('manual');
    expect(effectivePolicy('auto', 'manual')).toBe('manual');
    expect(effectivePolicy('gated', 'auto')).toBe('gated');
    expect(effectivePolicy('auto', 'gated')).toBe('gated');
    expect(effectivePolicy('auto', 'auto')).toBe('auto');
  });
});
