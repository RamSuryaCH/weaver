/**
 * Every chaos mutation must produce the finding it claims to.
 *
 * This is the test that makes the chaos harness trustworthy: if a mutation
 * stopped triggering its finding, the harness would quietly become a demo prop
 * instead of a test.
 */
import { describe, expect, it } from 'vitest';
import { applyChaos, ChaosConfigurationError, CHAOS_MUTATIONS, describeMutation } from './chaos.js';
import { parseSourceContract, type SourceContract } from './contract.js';
import { buildBaseline, detectDrift, MIN_BASELINE_RUNS } from './drift.js';
import type { FindingCode, Severity } from './findings.js';
import { computeRunStatistics } from './statistics.js';

function contract(): SourceContract {
  return parseSourceContract({
    id: 'truemeds',
    name: 'Truemeds',
    type: 'pdp',
    target_url: 'https://www.truemeds.in',
    description: 'Extract medicine product details from a product page.',
    row_key: ['product_url'],
    expectations: { min_rows: 8, max_row_drop_pct: 30 },
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
        description: 'the printed maximum retail price in rupees before any discount',
        type: 'number',
        required: true,
        validate: { gt: 0, lt: 100000 },
        drift: { median_shift_pct: 30, flag_constant: true },
      },
    ],
  });
}

function healthyRows(count = 12): Record<string, unknown>[] {
  return Array.from({ length: count }, (_unused, index) => ({
    product_url: `https://www.truemeds.in/medicine/product-${index}`,
    mrp: 100 + index * 7,
  }));
}

function analyse(rows: readonly unknown[]): { codes: FindingCode[]; severity: Severity } {
  const sourceContract = contract();
  const history = Array.from({ length: MIN_BASELINE_RUNS }, () =>
    computeRunStatistics(sourceContract, healthyRows()),
  );

  const report = detectDrift({
    contract: sourceContract,
    statistics: computeRunStatistics(sourceContract, rows),
    baseline: buildBaseline(history),
    generatedAt: '2026-08-18T18:00:00.000Z',
  });

  return { codes: report.findings.map((finding) => finding.code), severity: report.severity };
}

describe('applyChaos', () => {
  it('never modifies the payload it was given', () => {
    const original = healthyRows(3);
    const snapshot = JSON.stringify(original);

    applyChaos(original, { mutation: 'null-field', field: 'mrp' });

    expect(JSON.stringify(original)).toBe(snapshot);
  });

  it('demands a field for mutations that need one', () => {
    expect(() => applyChaos(healthyRows(), { mutation: 'drop-field' })).toThrow(
      ChaosConfigurationError,
    );
  });

  it('describes every mutation, so the CLI can explain itself', () => {
    for (const mutation of CHAOS_MUTATIONS) {
      expect(describeMutation(mutation).length).toBeGreaterThan(20);
    }
  });
});

describe('each mutation triggers the finding it simulates', () => {
  it('drop-field is detected as an absent field', () => {
    const result = analyse(applyChaos(healthyRows(), { mutation: 'drop-field', field: 'mrp' }));

    expect(result.codes).toContain('field_absent');
    expect(result.severity).toBe('broken');
  });

  it('null-field is detected as an absent field', () => {
    const result = analyse(applyChaos(healthyRows(), { mutation: 'null-field', field: 'mrp' }));

    expect(result.codes).toContain('field_absent');
    expect(result.severity).toBe('broken');
  });

  it('rename-field is detected as both an absent field and an unknown key', () => {
    const result = analyse(applyChaos(healthyRows(), { mutation: 'rename-field', field: 'mrp' }));

    expect(result.codes).toContain('field_absent');
    expect(result.codes).toContain('unknown_field');
  });

  it('constant-field is detected as a constant value', () => {
    const result = analyse(applyChaos(healthyRows(), { mutation: 'constant-field', field: 'mrp' }));

    expect(result.codes).toContain('constant_value');
    expect(result.severity).toBe('broken');
  });

  it('truncate-rows is detected as a row count problem', () => {
    const result = analyse(applyChaos(healthyRows(), { mutation: 'truncate-rows', keep: 4 }));

    expect(result.codes).toContain('row_count_below_minimum');
  });

  it('rescale-field is detected as a shifted median', () => {
    const result = analyse(
      applyChaos(healthyRows(), { mutation: 'rescale-field', field: 'mrp', factor: 100 }),
    );

    // The rupees-to-paise mistake: every value is individually plausible, and
    // only the distribution reveals the error.
    expect(result.codes).toContain('median_shifted');
  });

  it('stringify-field is detected as a type mismatch', () => {
    const result = analyse(
      applyChaos(healthyRows(), { mutation: 'stringify-field', field: 'mrp' }),
    );

    expect(result.codes).toContain('type_mismatch');
  });

  it('empty-snapshot is detected as an empty snapshot', () => {
    const result = analyse(applyChaos(healthyRows(), { mutation: 'empty-snapshot' }));

    expect(result.codes).toEqual(['empty_snapshot']);
    expect(result.severity).toBe('broken');
  });

  it('leaves a healthy payload healthy when no mutation is applied', () => {
    expect(analyse(healthyRows()).severity).toBe('ok');
  });
});
