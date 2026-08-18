/**
 * Verifying a heal preview against the contract.
 *
 * This is Weaver's central claim. `bdata scraper heal --auto-approve` trusts the
 * AI's proposed fix blindly. Weaver takes the `preview_result` the approval gate
 * hands back, runs it through the same contract that detected the break, and
 * only approves if the preview satisfies it. A heal is trusted because the output
 * is correct, not because an AI produced it.
 *
 * Two things make preview verification different from run verification, and
 * getting them wrong would make the gate useless:
 *
 * 1. A preview is a *sample* — often a single row. Run-level expectations like
 *    `min_rows` must not be applied, or every preview would fail.
 * 2. Only the fields the heal was asked to repair are judged. A pre-existing
 *    problem elsewhere is not this fix's fault, and failing on it would loop
 *    forever.
 */
import type { SourceContract } from './contract.js';
import { findField } from './contract.js';
import { computeRunStatistics } from './statistics.js';

export interface PreviewVerdict {
  readonly ok: boolean;
  /** Field-by-field explanation of what failed, ready for the sharpened prompt. */
  readonly reasons: readonly string[];
  readonly checkedFields: readonly string[];
  readonly rowsInspected: number;
}

/** Rows a preview needs before a single distinct value is treated as suspicious. */
const CONSTANT_CHECK_MIN_ROWS = 4;

export function verifyPreview(input: {
  readonly contract: SourceContract;
  /** The fields the heal prompt asked Bright Data to repair. */
  readonly fields: readonly string[];
  readonly rows: readonly unknown[];
}): PreviewVerdict {
  const { contract, fields, rows } = input;

  if (rows.length === 0) {
    return {
      ok: false,
      reasons: ['the preview contained no rows'],
      checkedFields: [...fields],
      rowsInspected: 0,
    };
  }

  const statistics = computeRunStatistics(contract, rows);
  const reasons: string[] = [];

  for (const name of fields) {
    const field = findField(contract, name);
    const stats = statistics.fields[name];

    if (field === undefined || stats === undefined) {
      reasons.push(`"${name}" is not a field in the contract`);
      continue;
    }

    if (stats.presentCount === 0) {
      reasons.push(
        stats.invalidCount > 0
          ? `"${name}" is present but unusable: ${stats.firstInvalid?.reason ?? 'failed validation'}`
          : `"${name}" is still empty in the preview`,
      );
      continue;
    }

    if (stats.invalidCount > 0) {
      reasons.push(
        `"${name}" failed validation in ${stats.invalidCount} of ${statistics.rowCount} preview rows: ${
          stats.firstInvalid?.reason ?? 'failed validation'
        }`,
      );
      continue;
    }

    // A repair that returns the same value for every product has not repaired
    // anything; it has moved the bug.
    if (
      field.drift?.flagConstant === true &&
      statistics.rowCount >= CONSTANT_CHECK_MIN_ROWS &&
      stats.distinctCount === 1
    ) {
      reasons.push(
        `"${name}" is the same value in all ${statistics.rowCount} preview rows, so extraction is still latched onto a fixed element`,
      );
    }
  }

  return {
    ok: reasons.length === 0,
    reasons,
    checkedFields: [...fields],
    rowsInspected: statistics.rowCount,
  };
}

/** One sentence summarising a verdict, for an incident event or the terminal. */
export function describeVerdict(verdict: PreviewVerdict): string {
  if (verdict.ok) {
    return `the preview satisfied the contract for ${verdict.checkedFields
      .map((field) => `"${field}"`)
      .join(', ')} across ${verdict.rowsInspected} row${verdict.rowsInspected === 1 ? '' : 's'}`;
  }
  return verdict.reasons.join('; ');
}
