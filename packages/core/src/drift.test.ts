/**
 * Golden tests for the drift engine.
 *
 * Every failure mode Weaver claims to detect has a test here that constructs the
 * exact payload a broken collector would return. These are the tests that decide
 * whether the product works, so they are written as scenarios rather than as unit
 * assertions on internals.
 */
import { describe, expect, it } from 'vitest';
import { parseSourceContract, type SourceContract } from './contract.js';
import { buildBaseline, detectDrift, MIN_BASELINE_RUNS, type RunReport } from './drift.js';
import { isHealable, type FindingCode } from './findings.js';
import { computeRunStatistics } from './statistics.js';

const GENERATED_AT = '2026-08-18T18:00:00.000Z';

function contract(): SourceContract {
  return parseSourceContract({
    id: 'truemeds',
    name: 'Truemeds',
    type: 'pdp',
    target_url: 'https://www.truemeds.in',
    description: 'Extract medicine product details from a product page.',
    row_key: ['product_url'],
    expectations: { min_rows: 8, max_row_drop_pct: 30 },
    inputs: { urls: ['https://www.truemeds.in/medicine/pan-40-mg-tablet-10-tm-tacr1-030124'] },
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
        field: 'mrp',
        description: 'the printed maximum retail price in rupees, before any discount',
        type: 'number',
        required: true,
        validate: { gt: 0, lt: 100000 },
        drift: { median_shift_pct: 30, flag_constant: true },
      },
      {
        field: 'discount_pct',
        description: 'the advertised discount percentage off MRP, when shown',
        type: 'number',
        validate: { gte: 0, lte: 100 },
      },
    ],
  });
}

/** A healthy run: ten products, all fields populated, prices varying. */
function healthyRows(count = 10): Record<string, unknown>[] {
  return Array.from({ length: count }, (_unused, index) => ({
    product_url: `https://www.truemeds.in/medicine/product-${index}`,
    product_name: `Medicine ${index}`,
    mrp: 100 + index * 10,
    discount_pct: index % 2 === 0 ? 12 : null,
    input: { url: `https://www.truemeds.in/medicine/product-${index}` },
  }));
}

function report(
  rows: readonly unknown[],
  history: readonly (readonly unknown[])[] = [],
): RunReport {
  const sourceContract = contract();
  return detectDrift({
    contract: sourceContract,
    statistics: computeRunStatistics(sourceContract, rows),
    baseline: buildBaseline(
      history.map((historicRows) => computeRunStatistics(sourceContract, historicRows)),
    ),
    generatedAt: GENERATED_AT,
  });
}

function codes(result: RunReport): FindingCode[] {
  return result.findings.map((finding) => finding.code);
}

/** Enough healthy history for baseline comparisons to switch on. */
function healthyHistory(): readonly (readonly unknown[])[] {
  return Array.from({ length: MIN_BASELINE_RUNS }, () => healthyRows());
}

describe('a healthy run', () => {
  it('is ok with no findings', () => {
    const result = report(healthyRows(), healthyHistory());

    expect(result.severity).toBe('ok');
    expect(result.findings).toEqual([]);
  });

  it('carries the injected timestamp rather than reading a clock', () => {
    expect(report(healthyRows()).generatedAt).toBe(GENERATED_AT);
  });

  it('tolerates a field that is legitimately absent from some rows', () => {
    // discount_pct is optional and null on half the rows. That is normal for a
    // best-effort AI schema and must not be reported.
    const result = report(healthyRows(), healthyHistory());

    expect(codes(result)).not.toContain('fill_rate_below_contract');
  });
});

describe('the loud failures', () => {
  it('reports an empty snapshot as broken', () => {
    const result = report([]);

    expect(result.severity).toBe('broken');
    expect(codes(result)).toEqual(['empty_snapshot']);
  });

  it('reports too few rows against the contract minimum', () => {
    const result = report(healthyRows(3));

    expect(result.severity).toBe('broken');
    expect(codes(result)).toContain('row_count_below_minimum');
  });

  it('reports a required field that vanished from every row', () => {
    const rows = healthyRows().map(({ mrp: _dropped, ...rest }) => rest);

    const result = report(rows, healthyHistory());

    expect(result.severity).toBe('broken');
    expect(codes(result)).toContain('field_absent');
    const finding = result.findings.find((item) => item.code === 'field_absent');
    expect(finding?.field).toBe('mrp');
    expect(finding?.message).toContain('all 10 rows');
    // The expectation quotes the contract description, which is what the heal
    // prompt will be built from.
    expect(finding?.expected).toContain('maximum retail price');
  });

  it('reports a field that is nulled in most rows', () => {
    const rows = healthyRows().map((row, index) => ({
      ...row,
      mrp: index < 9 ? null : row.mrp,
    }));

    const result = report(rows, healthyHistory());

    expect(result.severity).toBe('broken');
    expect(codes(result)).toContain('fill_rate_below_contract');
    expect(result.findings[0]?.message).toContain('10%');
  });

  it('reports values that break the contract validation rules', () => {
    const rows = healthyRows().map((row) => ({ ...row, mrp: -5 }));

    const result = report(rows, healthyHistory());

    expect(codes(result)).toContain('value_invalid');
    expect(result.severity).toBe('broken');
  });

  it('reports a URL field that stopped being a URL', () => {
    const rows = healthyRows().map((row) => ({ ...row, product_url: 'product-1' }));

    const result = report(rows, healthyHistory());

    expect(codes(result)).toContain('value_invalid');
  });
});

describe('the quiet failures', () => {
  it('reports a field that is the same value in every row', () => {
    // Extraction still "works": it has latched onto a static element, so every
    // product now reports the same price. Nothing else would catch this.
    const rows = healthyRows().map((row) => ({ ...row, mrp: 249 }));

    const result = report(rows, healthyHistory());

    expect(codes(result)).toContain('constant_value');
    expect(result.severity).toBe('broken');
    expect(result.findings.find((item) => item.code === 'constant_value')?.message).toContain(
      'latched onto',
    );
  });

  it('does not cry constant on a handful of rows that happen to match', () => {
    const rows = healthyRows(3).map((row) => ({ ...row, mrp: 249 }));

    const result = report(rows);

    expect(codes(result)).not.toContain('constant_value');
  });

  it('reports a median that moved further than the contract tolerates', () => {
    // Prices doubling overnight across the catalogue is a unit or currency bug,
    // not a sale.
    const rows = healthyRows().map((row) => ({ ...row, mrp: Number(row.mrp) * 2.5 }));

    const result = report(rows, healthyHistory());

    expect(codes(result)).toContain('median_shifted');
    expect(result.severity).toBe('degraded');
  });

  it('reports values that are systematically the wrong type', () => {
    const rows = healthyRows().map((row) => ({ ...row, mrp: `₹${String(row.mrp)}` }));

    const result = report(rows, healthyHistory());

    expect(codes(result)).toContain('type_mismatch');
  });

  it('accepts occasional formatting noise without reporting a type mismatch', () => {
    const rows = healthyRows().map((row, index) => (index === 0 ? { ...row, mrp: '₹100' } : row));

    const result = report(rows, healthyHistory());

    expect(codes(result)).not.toContain('type_mismatch');
  });

  it('reports a field the collector invented', () => {
    const rows = healthyRows().map((row) => ({ ...row, price_per_unit: 12 }));

    const result = report(rows, healthyHistory());

    expect(codes(result)).toContain('unknown_field');
    expect(result.severity).toBe('degraded');
  });

  it('ignores the input echo Bright Data adds to every row', () => {
    const result = report(healthyRows(), healthyHistory());

    expect(result.statistics.unknownKeys).toEqual([]);
  });
});

describe('baseline behaviour', () => {
  it('does not compare against a baseline built from too little history', () => {
    // Two runs is not a baseline. Contract checks still apply, so the source is
    // not unguarded — but "drifted from normal" needs a normal to exist.
    const thinHistory = [healthyRows(), healthyRows()];
    const rows = healthyRows(9).map((row) => ({ ...row, mrp: Number(row.mrp) * 3 }));

    const result = report(rows, thinHistory);

    expect(codes(result)).not.toContain('median_shifted');
    expect(result.baselineRuns).toBe(2);
  });

  it('reports a row count that collapsed relative to history', () => {
    const rows = healthyRows(9).slice(0, 9);
    const historyOfTwenty = Array.from({ length: MIN_BASELINE_RUNS }, () => healthyRows(20));

    const result = report(rows, historyOfTwenty);

    expect(codes(result)).toContain('row_count_dropped');
  });

  it('reports a fill rate that fell against history even while the contract floor is met', () => {
    // discount_pct has no contract floor, so only history can reveal that it
    // used to be populated on every row and now is populated on two in five.
    const rows = healthyRows().map((row, index) => ({
      ...row,
      discount_pct: index < 4 ? 15 : null,
    }));
    const history = Array.from({ length: MIN_BASELINE_RUNS }, () =>
      healthyRows().map((row) => ({ ...row, discount_pct: 15 })),
    );

    const result = report(rows, history);

    expect(codes(result)).toContain('fill_rate_dropped');
    expect(result.severity).toBe('degraded');
  });

  it('reports an optional field that history says used to be populated', () => {
    const rows = healthyRows().map((row) => ({ ...row, discount_pct: null }));
    const history = Array.from({ length: MIN_BASELINE_RUNS }, () =>
      healthyRows().map((row) => ({ ...row, discount_pct: 15 })),
    );

    const result = report(rows, history);

    expect(codes(result)).toContain('field_absent');
    expect(result.severity).toBe('degraded');
  });

  it('stays silent about an optional field that was never populated', () => {
    // No product in this run has a discount, and none did before. Reporting it
    // would train the operator to ignore Weaver.
    const rows = healthyRows().map((row) => ({ ...row, discount_pct: null }));
    const history = Array.from({ length: MIN_BASELINE_RUNS }, () =>
      healthyRows().map((historicRow) => ({ ...historicRow, discount_pct: null })),
    );

    const result = report(rows, history);

    expect(result.severity).toBe('ok');
    expect(result.findings).toEqual([]);
  });

  it('reports one finding per break, not two', () => {
    const rows = healthyRows().map((row) => ({ ...row, mrp: null }));
    const result = report(rows, healthyHistory());

    const mrpFindings = result.findings.filter((finding) => finding.field === 'mrp');
    expect(mrpFindings).toHaveLength(1);
    expect(mrpFindings[0]?.code).toBe('field_absent');
  });

  it('takes the median of history so one bad run does not become normal', () => {
    const history = [healthyRows(20), healthyRows(20), healthyRows(2)];
    const baseline = buildBaseline(history.map((rows) => computeRunStatistics(contract(), rows)));

    expect(baseline.medianRowCount).toBe(20);
  });
});

describe('severity', () => {
  it('treats a broken required field as broken and an optional one as degraded', () => {
    const requiredBroken = report(
      healthyRows().map(({ product_name: _dropped, ...rest }) => rest),
      healthyHistory(),
    );
    const optionalBroken = report(
      healthyRows().map((row) => ({ ...row, discount_pct: 'twelve' })),
      healthyHistory(),
    );

    expect(requiredBroken.severity).toBe('broken');
    expect(optionalBroken.severity).toBe('degraded');
  });

  it('marks extraction failures as healable and value shifts as not', () => {
    const absent = report(
      healthyRows().map(({ mrp: _dropped, ...rest }) => rest),
      healthyHistory(),
    );
    const shifted = report(
      healthyRows().map((row) => ({ ...row, mrp: Number(row.mrp) * 2.5 })),
      healthyHistory(),
    );

    expect(absent.findings.filter(isHealable)).toHaveLength(1);
    // A price that genuinely moved is a finding, but sending it to an AI code
    // refactorer would be absurd.
    expect(shifted.findings.filter(isHealable)).toHaveLength(0);
  });
});
