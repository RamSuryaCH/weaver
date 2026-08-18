import { describe, expect, it } from 'vitest';
import { applyChaos } from './chaos.js';
import { HEAL_PROMPT_MAX_CHARS, parseSourceContract, type SourceContract } from './contract.js';
import { buildBaseline, detectDrift, MIN_BASELINE_RUNS, type RunReport } from './drift.js';
import { chooseStrategy, NothingToHealError, synthesizeHealPrompt } from './heal-prompt.js';
import { computeRunStatistics } from './statistics.js';

function contract(): SourceContract {
  return parseSourceContract({
    id: 'truemeds',
    name: 'Truemeds',
    type: 'pdp',
    target_url: 'https://www.truemeds.in',
    collector_id: 'c_mpohus372o5tmid1jk',
    description: 'Extract medicine product details from a product page.',
    row_key: ['product_url'],
    expectations: { min_rows: 10, max_row_drop_pct: 30 },
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
        description: 'the printed maximum retail price in rupees, before any discount is applied',
        type: 'number',
        required: true,
        validate: { gt: 0, lt: 100000 },
        drift: { median_shift_pct: 30, flag_constant: true },
      },
      {
        field: 'selling_price',
        description: 'the price in rupees a customer actually pays today, after any discount',
        type: 'number',
        required: true,
        validate: { gt: 0, lt: 100000 },
        drift: { median_shift_pct: 30, flag_constant: true },
      },
      {
        field: 'composition',
        description: 'the active ingredients of the medicine, exactly as listed on the page',
        type: 'string',
        required: true,
        min_fill_rate: 0.8,
      },
    ],
  });
}

function healthyRows(count = 12): Record<string, unknown>[] {
  return Array.from({ length: count }, (_unused, index) => ({
    product_url: `https://www.truemeds.in/medicine/product-${index}`,
    mrp: 120 + index * 11,
    selling_price: 100 + index * 9,
    composition: `salt-${index}`,
  }));
}

function reportFor(rows: readonly unknown[]): RunReport {
  const sourceContract = contract();
  const history = Array.from({ length: MIN_BASELINE_RUNS }, () =>
    computeRunStatistics(sourceContract, healthyRows()),
  );

  return detectDrift({
    contract: sourceContract,
    statistics: computeRunStatistics(sourceContract, rows),
    baseline: buildBaseline(history),
    generatedAt: '2026-08-18T18:00:00.000Z',
  });
}

function promptFor(
  rows: readonly unknown[],
  options: { attempt?: number; previousFailure?: string } = {},
) {
  const report = reportFor(rows);
  return synthesizeHealPrompt({
    contract: contract(),
    findings: report.findings,
    statistics: report.statistics,
    attempt: options.attempt ?? 1,
    ...(options.previousFailure === undefined ? {} : { previousFailure: options.previousFailure }),
  });
}

describe('synthesizeHealPrompt', () => {
  it('names the field, the symptom with real numbers, and the contract description', () => {
    const prompt = promptFor(applyChaos(healthyRows(), { mutation: 'null-field', field: 'mrp' }));

    expect(prompt.text).toContain('"mrp" is missing from all 12 rows');
    // The description that created the field is the description that repairs it.
    expect(prompt.text).toContain('the printed maximum retail price in rupees');
    expect(prompt.fields).toEqual(['mrp']);
  });

  it('never exceeds the 1000-character CLI limit', () => {
    // Every field broken at once is the worst case for prompt length.
    const wrecked = healthyRows().map((row) => ({ ...row, mrp: null, selling_price: null }));
    const prompt = promptFor(wrecked, {
      attempt: 2,
      previousFailure:
        'the preview still returned null for mrp on every row, and selling_price was a string',
    });

    expect(prompt.text.length).toBeLessThanOrEqual(HEAL_PROMPT_MAX_CHARS);
  });

  it('asks for a plain number when the field is numeric', () => {
    const prompt = promptFor(
      applyChaos(healthyRows(), { mutation: 'stringify-field', field: 'mrp' }),
    );

    expect(prompt.text).toContain('plain number with no currency symbol');
  });

  it('includes an example of what the page actually returned', () => {
    const prompt = promptFor(
      applyChaos(healthyRows(), { mutation: 'stringify-field', field: 'mrp' }),
    );

    expect(prompt.text).toContain('Observed:');
  });

  it('describes at most three fields, so the instruction stays specific', () => {
    const wrecked = healthyRows().map(() => ({}));

    const prompt = promptFor(wrecked);

    expect(prompt.fields.length).toBeLessThanOrEqual(3);
  });

  it('leads with the most severe, most specific break', () => {
    // mrp has vanished (broken); selling_price merely arrives as a string
    // (degraded). The instruction has to open with the one that matters.
    const wrecked = healthyRows().map((row) => ({
      ...row,
      mrp: null,
      selling_price: `₹${String(row.selling_price)}`,
    }));

    const prompt = promptFor(wrecked);

    expect(prompt.text.indexOf('"mrp"')).toBeLessThan(prompt.text.indexOf('"selling_price"'));
    expect(prompt.fields[0]).toBe('mrp');
  });

  it('refuses to heal a value shift, which no code change could fix', () => {
    const rescaled = applyChaos(healthyRows(), {
      mutation: 'rescale-field',
      field: 'mrp',
      factor: 100,
    });

    expect(() => promptFor(rescaled)).toThrow(NothingToHealError);
  });

  it('refuses to heal an unknown field on its own', () => {
    const rows = healthyRows().map((row) => ({ ...row, price_per_unit: 4 }));

    expect(() => promptFor(rows)).toThrow(NothingToHealError);
  });

  it('tells the refactorer to leave other fields alone', () => {
    const prompt = promptFor(applyChaos(healthyRows(), { mutation: 'null-field', field: 'mrp' }));

    expect(prompt.text).toContain('leave every other field untouched');
  });
});

describe('prompt sharpening', () => {
  it('escalates strategy with each attempt', () => {
    expect(chooseStrategy(1)).toBe('describe-all');
    expect(chooseStrategy(2)).toBe('sharpen');
    expect(chooseStrategy(3)).toBe('single-field');
    expect(chooseStrategy(7)).toBe('single-field');
  });

  it('quotes why the previous preview was rejected', () => {
    const prompt = promptFor(applyChaos(healthyRows(), { mutation: 'null-field', field: 'mrp' }), {
      attempt: 2,
      previousFailure: 'the preview returned mrp as 0 on every row',
    });

    expect(prompt.text).toContain('A previous fix was rejected because');
    expect(prompt.text).toContain('returned mrp as 0');
  });

  it('adds a markup hint on the second attempt but not the first', () => {
    const rows = applyChaos(healthyRows(), { mutation: 'null-field', field: 'mrp' });

    expect(promptFor(rows, { attempt: 1 }).text).not.toContain('JSON-LD');
    // Bright Data's own advice: when the preview is still empty, say where to look.
    expect(promptFor(rows, { attempt: 2 }).text).toContain('JSON-LD');
  });

  it('narrows to a single field by the third attempt', () => {
    const wrecked = healthyRows().map((row) => ({ ...row, mrp: null, selling_price: null }));

    const broad = promptFor(wrecked, { attempt: 1 });
    const narrow = promptFor(wrecked, { attempt: 3 });

    expect(broad.fields.length).toBeGreaterThan(1);
    expect(narrow.fields).toHaveLength(1);
    expect(narrow.text).toContain('Fix only');
  });

  it('is deterministic, so the same break always produces the same prompt', () => {
    const rows = applyChaos(healthyRows(), { mutation: 'null-field', field: 'mrp' });

    expect(promptFor(rows).text).toBe(promptFor(rows).text);
  });
});

describe('the prompt a judge will read on screen', () => {
  it('reads as an instruction a human would write', () => {
    const prompt = promptFor(
      applyChaos(healthyRows(), { mutation: 'constant-field', field: 'selling_price' }),
      { attempt: 2, previousFailure: 'the preview returned the same price for every product' },
    );

    expect(prompt.text).toMatchInlineSnapshot(
      `""selling_price" is the same value in all 12 rows, which suggests extraction latched onto a fixed element. "selling_price" is the price in rupees a customer actually pays today, after any discount. A previous fix was rejected because the preview returned the same price for every product. Observed: "selling_price" came back as 100. Prefer the values in the embedded JSON-LD structured data on the page (schema.org Product or Offer) over CSS class names, which change often. Re-capture "selling_price" from the current markup and leave every other field untouched. Return "selling_price" as a plain number with no currency symbol."`,
    );
  });
});
