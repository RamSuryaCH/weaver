import { describe, expect, it } from 'vitest';
import {
  BrightDataShapeError,
  ScraperStudioCli,
  ScraperStudioCliError,
  extractJson,
  extractPreviewRows,
  isAwaitingApproval,
  type CommandResult,
  type CommandRunner,
} from './index.js';

const COLLECTOR_ID = 'c_mpohus372o5tmid1jk';
const PRODUCT_URL = 'https://www.truemeds.in/medicine/pan-40-mg-tablet-10-tm-tacr1-030124';

/** Records the args it was called with and replays a canned CLI result. */
function stubRunner(result: Partial<CommandResult>): {
  run: CommandRunner;
  calls: readonly string[][];
} {
  const calls: string[][] = [];
  const run: CommandRunner = (args) => {
    calls.push([...args]);
    return Promise.resolve({
      stdout: result.stdout ?? '{}',
      stderr: result.stderr ?? '',
      exitCode: result.exitCode ?? 0,
    });
  };
  return { run, calls };
}

/** stdout as `bdata` actually emits it: progress lines, then the envelope. */
const HEAL_STDOUT = `Triggering self-healing.
Step: user_intent_analyzer - polling (attempt 1/600)
Step: code_generator - polling (attempt 84/600)
{
  "collector_id": "${COLLECTOR_ID}",
  "status": "awaiting_approval",
  "prompt": "The mrp field returns null for every row.",
  "next_step": {
    "command": "bdata scraper approve ${COLLECTOR_ID} --url ${PRODUCT_URL}"
  },
  "preview_result": [
    { "product_url": "${PRODUCT_URL}", "mrp": 214.5, "selling_price": 182.3 }
  ]
}`;

describe('extractJson', () => {
  it('parses output that is only JSON', () => {
    expect(extractJson('{"status":"done"}')).toEqual({ status: 'done' });
  });

  it('finds the envelope after human-readable progress lines', () => {
    const parsed = extractJson(HEAL_STDOUT) as Record<string, unknown>;

    expect(parsed.status).toBe('awaiting_approval');
    expect(parsed.collector_id).toBe(COLLECTOR_ID);
  });

  it('handles a JSON array envelope', () => {
    expect(extractJson('progress\n[{"price":1}]')).toEqual([{ price: 1 }]);
  });

  it('fails clearly when there is no JSON at all', () => {
    expect(() => extractJson('Logged in successfully.')).toThrow(BrightDataShapeError);
  });

  it('fails clearly on empty output', () => {
    expect(() => extractJson('   ')).toThrow(/no output/);
  });
});

describe('ScraperStudioCli.create', () => {
  it('passes the url and description through and returns the collector id', async () => {
    const { run, calls } = stubRunner({
      stdout: `Template created: ${COLLECTOR_ID}\n{"collector_id":"${COLLECTOR_ID}","status":"done"}`,
    });

    const envelope = await new ScraperStudioCli({ run }).create({
      url: 'https://www.truemeds.in',
      description: 'Extract product name and price from this medicine page.',
      name: 'weaver-truemeds-pdp',
    });

    expect(envelope.collector_id).toBe(COLLECTOR_ID);
    expect(calls[0]).toEqual([
      'scraper',
      'create',
      'https://www.truemeds.in',
      'Extract product name and price from this medicine page.',
      '--json',
      '--name',
      'weaver-truemeds-pdp',
    ]);
  });

  it('refuses a description over the 500-character CLI limit before spending 15 minutes', async () => {
    const { run, calls } = stubRunner({});

    await expect(
      new ScraperStudioCli({ run }).create({
        url: 'https://www.truemeds.in',
        description: 'x'.repeat(501),
      }),
    ).rejects.toThrow(/500/);
    expect(calls).toHaveLength(0);
  });
});

describe('ScraperStudioCli.heal', () => {
  it('stops at the approval gate and never passes --auto-approve', async () => {
    const { run, calls } = stubRunner({ stdout: HEAL_STDOUT });

    const envelope = await new ScraperStudioCli({ run }).heal({
      collectorId: COLLECTOR_ID,
      prompt: 'The mrp field returns null for every row.',
      url: PRODUCT_URL,
    });

    expect(isAwaitingApproval(envelope)).toBe(true);
    expect(calls[0]).toEqual([
      'scraper',
      'heal',
      COLLECTOR_ID,
      'The mrp field returns null for every row.',
      '--json',
      '--url',
      PRODUCT_URL,
    ]);
    // The whole design rests on this: the gate must not be skipped.
    expect(calls[0]).not.toContain('--auto-approve');
    expect(calls[0]).not.toContain('--auto-save');
  });

  it('refuses a prompt over the 1000-character CLI limit', async () => {
    const { run, calls } = stubRunner({});

    await expect(
      new ScraperStudioCli({ run }).heal({
        collectorId: COLLECTOR_ID,
        prompt: 'x'.repeat(1001),
      }),
    ).rejects.toThrow(/1000/);
    expect(calls).toHaveLength(0);
  });

  it('keeps the raw envelope so it can be stored as incident evidence', async () => {
    const { run } = stubRunner({ stdout: HEAL_STDOUT });

    const envelope = await new ScraperStudioCli({ run }).heal({
      collectorId: COLLECTOR_ID,
      prompt: 'The mrp field returns null for every row.',
    });

    expect(envelope.next_step).toEqual({
      command: `bdata scraper approve ${COLLECTOR_ID} --url ${PRODUCT_URL}`,
    });
  });
});

describe('ScraperStudioCli.approve', () => {
  it('approves by default', async () => {
    const { run, calls } = stubRunner({
      stdout: `{"collector_id":"${COLLECTOR_ID}","status":"done"}`,
    });

    const envelope = await new ScraperStudioCli({ run }).approve({
      collectorId: COLLECTOR_ID,
      url: PRODUCT_URL,
    });

    expect(envelope.status).toBe('done');
    expect(calls[0]).not.toContain('--reject');
    expect(calls[0]).toContain('--url');
  });

  it('rejects when told to, so a failed preview leaves the collector untouched', async () => {
    const { run, calls } = stubRunner({
      stdout: `{"collector_id":"${COLLECTOR_ID}","status":"rejected"}`,
    });

    await new ScraperStudioCli({ run }).approve({ collectorId: COLLECTOR_ID, reject: true });

    expect(calls[0]).toContain('--reject');
  });
});

describe('credential handling', () => {
  it('passes an injected api key as -k so no browser login is needed', async () => {
    const { run, calls } = stubRunner({
      stdout: `{"collector_id":"${COLLECTOR_ID}","status":"done"}`,
    });

    await new ScraperStudioCli({ run, apiKey: 'secret-token-value' }).approve({
      collectorId: COLLECTOR_ID,
    });

    expect(calls[0]).toContain('-k');
    expect(calls[0]).toContain('secret-token-value');
  });

  it('redacts the api key out of CLI failure messages', async () => {
    const { run } = stubRunner({
      exitCode: 1,
      stderr: 'request failed with key secret-token-value',
    });

    const error = await new ScraperStudioCli({ run, apiKey: 'secret-token-value' })
      .approve({ collectorId: COLLECTOR_ID })
      .catch((caught: unknown) => caught);

    expect(error).toBeInstanceOf(ScraperStudioCliError);
    expect(String(error)).not.toContain('secret-token-value');
    expect(String(error)).toContain('[redacted]');
  });
});

describe('extractPreviewRows', () => {
  it('reads a plain array preview', () => {
    const rows = extractPreviewRows({
      collector_id: COLLECTOR_ID,
      status: 'awaiting_approval',
      preview_result: [{ mrp: 214.5 }, { mrp: 99 }],
    });

    expect(rows).toHaveLength(2);
  });

  it('reads a preview wrapped in a data key', () => {
    const rows = extractPreviewRows({
      collector_id: COLLECTOR_ID,
      status: 'awaiting_approval',
      preview_result: { data: [{ mrp: 214.5 }] },
    });

    expect(rows).toEqual([{ mrp: 214.5 }]);
  });

  it('reads a preview delivered as a JSON string', () => {
    const rows = extractPreviewRows({
      collector_id: COLLECTOR_ID,
      status: 'awaiting_approval',
      preview_result: '[{"mrp":214.5}]',
    });

    expect(rows).toEqual([{ mrp: 214.5 }]);
  });

  it('treats a single row object as a one-row preview', () => {
    const rows = extractPreviewRows({
      collector_id: COLLECTOR_ID,
      status: 'awaiting_approval',
      preview_result: { mrp: 214.5 },
    });

    expect(rows).toEqual([{ mrp: 214.5 }]);
  });

  it('returns nothing when there is no preview', () => {
    expect(extractPreviewRows({ collector_id: COLLECTOR_ID, status: 'running' })).toEqual([]);
  });
});

describe('isAwaitingApproval', () => {
  it.each([
    ['awaiting_approval', true],
    ['pending_answer', true],
    ['done', false],
    ['running', false],
  ])('treats %s as awaiting=%s', (status, expected) => {
    expect(isAwaitingApproval({ collector_id: COLLECTOR_ID, status })).toBe(expected);
  });
});
