/**
 * The drift engine.
 *
 * A run is compared against two things: the contract (absolute expectations that
 * the author wrote down) and a baseline (what previous healthy runs actually
 * achieved). Both matter, and for different reasons.
 *
 * The contract catches "this was never acceptable". The baseline catches "this
 * used to work and now does not", which is the failure this project exists for
 * and which no fixed threshold can express — a field that has always been 60%
 * populated is fine at 60% and broken at 5%, and only history knows that.
 *
 * Pure functions throughout: `detectDrift` takes the timestamp as an argument
 * rather than reading a clock, so every scenario below is reproducible.
 */
import type { FieldContract, SourceContract } from './contract.js';
import { isNumericType } from './contract.js';
import { worstSeverity, type Finding, type FindingCode, type Severity } from './findings.js';
import { percentChange, type FieldStatistics, type RunStatistics } from './statistics.js';

/** What previous healthy runs looked like. */
export interface Baseline {
  readonly runCount: number;
  readonly medianRowCount: number;
  readonly fields: Readonly<Record<string, BaselineField>>;
}

export interface BaselineField {
  readonly medianFillRate: number;
  readonly medianValue: number | undefined;
}

export interface RunReport {
  readonly sourceId: string;
  readonly severity: Severity;
  readonly findings: readonly Finding[];
  readonly statistics: RunStatistics;
  /** How many healthy runs the baseline was built from. 0 means no history. */
  readonly baselineRuns: number;
  readonly generatedAt: string;
}

/**
 * Minimum healthy runs before baseline comparisons are trusted.
 *
 * With fewer than three, one unlucky run becomes "normal" and every subsequent
 * run drifts against noise. Contract checks still apply from the very first run,
 * so a brand-new source is not unguarded.
 */
export const MIN_BASELINE_RUNS = 3;

/**
 * Build a baseline from the statistics of previous healthy runs.
 *
 * Medians rather than means: one bad run should not drag the baseline, and
 * scraped price data is exactly the kind of data that produces outliers.
 */
export function buildBaseline(history: readonly RunStatistics[]): Baseline {
  if (history.length === 0) {
    return { runCount: 0, medianRowCount: 0, fields: {} };
  }

  const fieldNames = new Set<string>();
  for (const run of history) {
    for (const name of Object.keys(run.fields)) fieldNames.add(name);
  }

  const fields: Record<string, BaselineField> = {};
  for (const name of fieldNames) {
    const fillRates: number[] = [];
    const medians: number[] = [];

    for (const run of history) {
      const stats = run.fields[name];
      if (stats === undefined) continue;
      fillRates.push(stats.fillRate);
      if (stats.numeric !== undefined) medians.push(stats.numeric.median);
    }

    fields[name] = {
      medianFillRate: medianOf(fillRates),
      medianValue: medians.length === 0 ? undefined : medianOf(medians),
    };
  }

  return {
    runCount: history.length,
    medianRowCount: medianOf(history.map((run) => run.rowCount)),
    fields,
  };
}

export interface DetectDriftInput {
  readonly contract: SourceContract;
  readonly statistics: RunStatistics;
  readonly baseline: Baseline;
  /** Injected rather than read from a clock, so reports are reproducible. */
  readonly generatedAt: string;
}

export function detectDrift(input: DetectDriftInput): RunReport {
  const { contract, statistics, baseline } = input;
  const findings: Finding[] = [];
  const baselineUsable = baseline.runCount >= MIN_BASELINE_RUNS;

  findings.push(...checkRowCount(contract, statistics, baseline, baselineUsable));

  for (const field of contract.schema) {
    const stats = statistics.fields[field.field];
    if (stats === undefined) continue;
    findings.push(
      ...checkField(field, stats, statistics, baseline.fields[field.field], baselineUsable),
    );
  }

  for (const key of statistics.unknownKeys) {
    findings.push({
      code: 'unknown_field',
      severity: 'degraded',
      field: key,
      message: `the collector returned "${key}", which the contract does not describe`,
      observed: `present in the payload`,
      expected: `a field declared in ${contract.id}.yaml`,
    });
  }

  return {
    sourceId: contract.id,
    severity: worstSeverity(findings.map((finding) => finding.severity)),
    findings,
    statistics,
    baselineRuns: baseline.runCount,
    generatedAt: input.generatedAt,
  };
}

function checkRowCount(
  contract: SourceContract,
  statistics: RunStatistics,
  baseline: Baseline,
  baselineUsable: boolean,
): readonly Finding[] {
  if (statistics.rowCount === 0) {
    return [
      {
        code: 'empty_snapshot',
        severity: 'broken',
        field: null,
        message: 'the run returned no rows at all',
        observed: '0 rows',
        expected: `at least ${contract.expectations.minRows} rows`,
      },
    ];
  }

  const findings: Finding[] = [];

  if (statistics.rowCount < contract.expectations.minRows) {
    findings.push({
      code: 'row_count_below_minimum',
      severity: 'broken',
      field: null,
      message: `the run returned ${statistics.rowCount} rows, below the contract minimum of ${contract.expectations.minRows}`,
      observed: `${statistics.rowCount} rows`,
      expected: `at least ${contract.expectations.minRows} rows`,
    });
  }

  if (baselineUsable && baseline.medianRowCount > 0) {
    const dropPct = -percentChange(baseline.medianRowCount, statistics.rowCount);
    if (dropPct > contract.expectations.maxRowDropPct) {
      findings.push({
        code: 'row_count_dropped',
        severity: 'degraded',
        field: null,
        message: `row count fell ${dropPct.toFixed(0)}% below the ${baseline.runCount}-run baseline of ${baseline.medianRowCount}`,
        observed: `${statistics.rowCount} rows`,
        expected: `within ${contract.expectations.maxRowDropPct}% of ${baseline.medianRowCount} rows`,
      });
    }
  }

  return findings;
}

function checkField(
  field: FieldContract,
  stats: FieldStatistics,
  run: RunStatistics,
  baselineField: BaselineField | undefined,
  baselineUsable: boolean,
): readonly Finding[] {
  const findings: Finding[] = [];
  const failure: Severity = field.required ? 'broken' : 'degraded';

  // "Absent" means the collector produced nothing here at all. A field whose
  // values are present but invalid is a different problem with a different heal
  // prompt, so it must not be collapsed into this one.
  const producedNothing = stats.presentCount === 0 && stats.invalidCount === 0;

  // Absence is only remarkable when something was expected. An optional field
  // that no product happens to have is normal, and reporting it would train the
  // operator to ignore Weaver.
  const expectedPresent =
    field.required ||
    field.minFillRate > 0 ||
    (baselineUsable && (baselineField?.medianFillRate ?? 0) > BASELINE_PRESENCE_THRESHOLD);

  if (producedNothing && run.rowCount > 0 && expectedPresent) {
    findings.push({
      code: 'field_absent',
      severity: failure,
      field: field.field,
      message: `"${field.field}" is missing from all ${run.rowCount} rows`,
      observed: 'present in 0 rows',
      expected: `${field.description}, in at least ${formatRate(field.minFillRate)} of rows`,
    });
    return findings;
  }

  if (producedNothing) {
    // Nothing collected, nothing expected. Silence is the correct report.
    return findings;
  }

  if (stats.fillRate < field.minFillRate) {
    findings.push({
      code: 'fill_rate_below_contract',
      severity: failure,
      field: field.field,
      message: `"${field.field}" is present in only ${formatRate(stats.fillRate)} of rows, below the contract floor of ${formatRate(field.minFillRate)}`,
      observed: `${stats.presentCount} of ${run.rowCount} rows`,
      expected: `at least ${formatRate(field.minFillRate)} of rows`,
    });
  }

  if (baselineUsable && baselineField !== undefined) {
    const dropPoints = (baselineField.medianFillRate - stats.fillRate) * 100;
    const threshold = field.drift?.fillRateDropPct ?? DEFAULT_FILL_RATE_DROP_POINTS;
    // Only report a drop that the contract check has not already covered, so one
    // break produces one finding rather than two.
    const alreadyReported = findings.some((finding) => finding.code === 'fill_rate_below_contract');
    if (!alreadyReported && dropPoints > threshold) {
      findings.push({
        code: 'fill_rate_dropped',
        severity: 'degraded',
        field: field.field,
        message: `"${field.field}" fill rate fell ${dropPoints.toFixed(0)} points, from a baseline of ${formatRate(baselineField.medianFillRate)} to ${formatRate(stats.fillRate)}`,
        observed: formatRate(stats.fillRate),
        expected: `about ${formatRate(baselineField.medianFillRate)}`,
      });
    }
  }

  if (stats.invalidCount > 0) {
    const reason = stats.firstInvalid?.reason ?? 'failed validation';
    findings.push({
      code: 'value_invalid',
      severity: stats.invalidCount === run.rowCount ? failure : 'degraded',
      field: field.field,
      message: `"${field.field}" failed validation in ${stats.invalidCount} of ${run.rowCount} rows: ${reason}`,
      observed: describeSample(stats.firstInvalid?.raw),
      expected: field.description,
    });
  }

  // Coercion is normal in small amounts ("₹214.50" for a price). It only means
  // something when it is the rule rather than the exception.
  if (stats.presentCount > 0 && stats.coercedCount / stats.presentCount > 0.5) {
    findings.push({
      code: 'type_mismatch',
      severity: 'degraded',
      field: field.field,
      message: `"${field.field}" arrived as the wrong type in ${stats.coercedCount} of ${stats.presentCount} rows and had to be converted`,
      observed: describeSample(stats.samples[0]),
      expected: `a ${field.type} value`,
    });
  }

  // The quiet failure: extraction "works" but has latched onto a static label,
  // so every row carries the same value.
  if (
    field.drift?.flagConstant === true &&
    stats.distinctCount === 1 &&
    stats.presentCount >= CONSTANT_VALUE_MIN_ROWS
  ) {
    findings.push({
      code: 'constant_value',
      severity: failure,
      field: field.field,
      message: `"${field.field}" is the same value in all ${stats.presentCount} rows, which suggests extraction latched onto a fixed element`,
      observed: `always ${describeSample(stats.samples[0])}`,
      expected: `${field.description}, varying between products`,
    });
  }

  if (
    baselineUsable &&
    field.drift?.medianShiftPct !== undefined &&
    isNumericType(field.type) &&
    stats.numeric !== undefined &&
    baselineField?.medianValue !== undefined
  ) {
    const shift = Math.abs(percentChange(baselineField.medianValue, stats.numeric.median));
    if (shift > field.drift.medianShiftPct) {
      findings.push({
        code: 'median_shifted',
        severity: 'degraded',
        field: field.field,
        message: `"${field.field}" median moved ${shift.toFixed(0)}%, from ${baselineField.medianValue} to ${stats.numeric.median}`,
        observed: String(stats.numeric.median),
        expected: `within ${field.drift.medianShiftPct}% of ${baselineField.medianValue}`,
      });
    }
  }

  return findings;
}

/** Fill-rate drop, in percentage points, that counts as drift when unspecified. */
const DEFAULT_FILL_RATE_DROP_POINTS = 25;

/**
 * Baseline fill rate above which a field's total absence is treated as a break
 * even though the contract does not require it. If history says a quarter of
 * rows used to carry a value, zero is news.
 */
const BASELINE_PRESENCE_THRESHOLD = 0.25;

/**
 * Rows required before a single distinct value is treated as suspicious.
 *
 * Two products can legitimately cost the same. Ten cannot, not in this dataset.
 */
const CONSTANT_VALUE_MIN_ROWS = 4;

export function findingsFor(report: RunReport, code: FindingCode): readonly Finding[] {
  return report.findings.filter((finding) => finding.code === code);
}

function formatRate(rate: number): string {
  return `${Math.round(rate * 100)}%`;
}

function describeSample(value: unknown): string {
  if (value === undefined) return 'nothing';
  if (typeof value === 'string') {
    return `"${value.length > 40 ? `${value.slice(0, 40)}...` : value}"`;
  }
  if (typeof value === 'number' || typeof value === 'boolean' || value === null) {
    return String(value);
  }
  return JSON.stringify(value) ?? 'an object';
}

function medianOf(values: readonly number[]): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);
  if (sorted.length % 2 === 1) return sorted[middle] ?? 0;
  return ((sorted[middle - 1] ?? 0) + (sorted[middle] ?? 0)) / 2;
}
