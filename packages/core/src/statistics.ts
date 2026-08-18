/**
 * Field statistics: turning a run's rows into numbers drift detection can reason about.
 *
 * Everything here is pure. Given the same contract and the same rows you get the
 * same statistics, which is why the drift engine can be tested exhaustively
 * without a network, a clock or a database.
 *
 * The one subtlety worth understanding is what counts as "present". Scraper
 * Studio's generated output schema is best-effort per row: when a page genuinely
 * has no discount, the field is omitted rather than set to null. So absence is
 * normal and is measured as a rate, never treated as an error on its own.
 */
import { isNumericType, type FieldContract, type SourceContract } from './contract.js';

/** How one raw cell was interpreted. */
export type FieldValue =
  | { readonly kind: 'missing' }
  | { readonly kind: 'invalid'; readonly reason: string; readonly raw: unknown }
  | {
      readonly kind: 'value';
      readonly value: string | number | boolean;
      /** True when the value had to be converted, e.g. "₹214.50" for a number field. */
      readonly coerced: boolean;
    };

export interface NumericSummary {
  readonly count: number;
  readonly median: number;
  readonly minimum: number;
  readonly maximum: number;
}

export interface FieldStatistics {
  readonly field: string;
  readonly presentCount: number;
  readonly missingCount: number;
  readonly invalidCount: number;
  readonly coercedCount: number;
  /** Present values as a fraction of all rows. 0 when there are no rows. */
  readonly fillRate: number;
  /** Distinct present values. 1 across many rows is the quiet failure mode. */
  readonly distinctCount: number;
  readonly numeric: NumericSummary | undefined;
  /** Up to three example values, for the heal prompt and the dashboard. */
  readonly samples: readonly (string | number | boolean)[];
  /** First validation failure, kept for the heal prompt. */
  readonly firstInvalid: { readonly reason: string; readonly raw: unknown } | undefined;
}

export interface RunStatistics {
  readonly rowCount: number;
  readonly fields: Readonly<Record<string, FieldStatistics>>;
  /** Contract fields that appeared in no row at all. */
  readonly absentFields: readonly string[];
  /** Keys the collector returned that the contract does not describe. */
  readonly unknownKeys: readonly string[];
}

/**
 * Interpret one raw cell against its field contract.
 *
 * Coercion is deliberate rather than lenient: real collectors return
 * `"₹214.50"` and `"1,299"` for price fields, and rejecting those outright would
 * report a break where there is only formatting. The conversion is counted, so a
 * field that is *systematically* the wrong type still gets reported.
 */
export function readFieldValue(field: FieldContract, raw: unknown): FieldValue {
  if (raw === null || raw === undefined) return { kind: 'missing' };
  if (typeof raw === 'string' && raw.trim() === '') return { kind: 'missing' };

  switch (field.type) {
    case 'number':
    case 'integer':
      return readNumber(field, raw);
    case 'boolean':
      return readBoolean(raw);
    case 'url':
      return readUrl(raw);
    case 'string':
      return readString(field, raw);
  }
}

function readNumber(field: FieldContract, raw: unknown): FieldValue {
  let value: number;
  let coerced = false;

  if (typeof raw === 'number') {
    value = raw;
  } else if (typeof raw === 'string') {
    // Strip currency symbols, thousands separators and stray whitespace.
    const cleaned = raw.replace(/[^0-9.-]/g, '');
    if (cleaned === '' || cleaned === '-' || cleaned === '.') {
      return { kind: 'invalid', reason: `"${raw}" is not a number`, raw };
    }
    value = Number(cleaned);
    coerced = true;
  } else {
    return { kind: 'invalid', reason: `expected a number, got ${typeof raw}`, raw };
  }

  if (!Number.isFinite(value)) {
    return { kind: 'invalid', reason: `"${String(raw)}" is not a finite number`, raw };
  }
  if (field.type === 'integer' && !Number.isInteger(value)) {
    return { kind: 'invalid', reason: `${value} is not an integer`, raw };
  }

  const violation = checkNumericRules(field, value);
  if (violation !== null) return { kind: 'invalid', reason: violation, raw };

  return { kind: 'value', value, coerced };
}

function checkNumericRules(field: FieldContract, value: number): string | null {
  const rules = field.validate;
  if (rules === undefined) return null;

  if (rules.gt !== undefined && !(value > rules.gt))
    return `${value} is not greater than ${rules.gt}`;
  if (rules.gte !== undefined && !(value >= rules.gte)) return `${value} is below ${rules.gte}`;
  if (rules.lt !== undefined && !(value < rules.lt)) return `${value} is not less than ${rules.lt}`;
  if (rules.lte !== undefined && !(value <= rules.lte)) return `${value} is above ${rules.lte}`;
  return null;
}

function readBoolean(raw: unknown): FieldValue {
  if (typeof raw === 'boolean') return { kind: 'value', value: raw, coerced: false };

  if (typeof raw === 'string') {
    const normalised = raw.trim().toLowerCase();
    if (['true', 'yes', 'in stock', 'available', '1'].includes(normalised)) {
      return { kind: 'value', value: true, coerced: true };
    }
    if (['false', 'no', 'out of stock', 'unavailable', '0'].includes(normalised)) {
      return { kind: 'value', value: false, coerced: true };
    }
  }
  return { kind: 'invalid', reason: `"${String(raw)}" is not a boolean`, raw };
}

function readUrl(raw: unknown): FieldValue {
  if (typeof raw !== 'string') {
    return { kind: 'invalid', reason: `expected a URL string, got ${typeof raw}`, raw };
  }
  try {
    const parsed = new URL(raw);
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
      return { kind: 'invalid', reason: `"${raw}" is not an http(s) URL`, raw };
    }
  } catch {
    return { kind: 'invalid', reason: `"${raw}" is not a valid URL`, raw };
  }
  return { kind: 'value', value: raw, coerced: false };
}

function readString(field: FieldContract, raw: unknown): FieldValue {
  const value = typeof raw === 'string' ? raw : String(raw);
  const coerced = typeof raw !== 'string';
  const rules = field.validate;

  if (rules !== undefined) {
    if (rules.minLength !== undefined && value.length < rules.minLength) {
      return { kind: 'invalid', reason: `"${value}" is shorter than ${rules.minLength}`, raw };
    }
    if (rules.maxLength !== undefined && value.length > rules.maxLength) {
      return { kind: 'invalid', reason: `value is longer than ${rules.maxLength}`, raw };
    }
    if (rules.pattern !== undefined && !new RegExp(rules.pattern).test(value)) {
      return { kind: 'invalid', reason: `"${value}" does not match ${rules.pattern}`, raw };
    }
    if (rules.oneOf !== undefined && !rules.oneOf.includes(value)) {
      return { kind: 'invalid', reason: `"${value}" is not one of ${rules.oneOf.join(', ')}`, raw };
    }
  }

  return { kind: 'value', value, coerced };
}

/** Compute statistics for every field in the contract across a run's rows. */
export function computeRunStatistics(
  contract: SourceContract,
  rows: readonly unknown[],
): RunStatistics {
  const records = rows.filter(isRecord);
  const fields: Record<string, FieldStatistics> = {};

  for (const field of contract.schema) {
    fields[field.field] = computeFieldStatistics(field, records);
  }

  const declared = new Set(contract.schema.map((field) => field.field));
  const seen = new Set<string>();
  for (const record of records) {
    for (const key of Object.keys(record)) {
      // Bright Data echoes the request under `input`; that is transport, not data.
      if (key === 'input') continue;
      if (!declared.has(key)) seen.add(key);
    }
  }

  const absentFields = contract.schema
    .filter((field) => (fields[field.field]?.presentCount ?? 0) === 0)
    .map((field) => field.field);

  return {
    rowCount: records.length,
    fields,
    absentFields,
    unknownKeys: [...seen].sort(),
  };
}

function computeFieldStatistics(
  field: FieldContract,
  records: readonly Record<string, unknown>[],
): FieldStatistics {
  let presentCount = 0;
  let missingCount = 0;
  let invalidCount = 0;
  let coercedCount = 0;
  const distinct = new Set<string>();
  const numbers: number[] = [];
  const samples: (string | number | boolean)[] = [];
  let firstInvalid: { reason: string; raw: unknown } | undefined;

  for (const record of records) {
    const read = readFieldValue(field, record[field.field]);

    switch (read.kind) {
      case 'missing':
        missingCount += 1;
        break;
      case 'invalid':
        invalidCount += 1;
        firstInvalid ??= { reason: read.reason, raw: read.raw };
        break;
      case 'value':
        presentCount += 1;
        if (read.coerced) coercedCount += 1;
        distinct.add(String(read.value));
        if (typeof read.value === 'number') numbers.push(read.value);
        if (samples.length < 3) samples.push(read.value);
        break;
    }
  }

  return {
    field: field.field,
    presentCount,
    missingCount,
    invalidCount,
    coercedCount,
    fillRate: records.length === 0 ? 0 : presentCount / records.length,
    distinctCount: distinct.size,
    numeric: isNumericType(field.type) ? summarise(numbers) : undefined,
    samples,
    firstInvalid,
  };
}

function summarise(values: readonly number[]): NumericSummary | undefined {
  if (values.length === 0) return undefined;
  return {
    count: values.length,
    median: median(values),
    minimum: Math.min(...values),
    maximum: Math.max(...values),
  };
}

/** Median of a numeric list. Returns 0 for an empty list rather than NaN. */
export function median(values: readonly number[]): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);
  if (sorted.length % 2 === 1) return sorted[middle] ?? 0;
  return ((sorted[middle - 1] ?? 0) + (sorted[middle] ?? 0)) / 2;
}

/** Percentage change from `before` to `after`, guarding against a zero baseline. */
export function percentChange(before: number, after: number): number {
  if (before === 0) return after === 0 ? 0 : 100;
  return ((after - before) / Math.abs(before)) * 100;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
