/**
 * Findings: the vocabulary Weaver uses to say what is wrong.
 *
 * Each code is a distinct failure mode with a distinct remedy, because the heal
 * prompt is generated from the code. "Something is wrong with mrp" cannot be
 * turned into an instruction; "mrp was present in 96% of rows and is now present
 * in 4%" can.
 */

export const SEVERITIES = ['ok', 'degraded', 'broken'] as const;
export type Severity = (typeof SEVERITIES)[number];

export const FINDING_CODES = [
  /** The snapshot came back with no rows at all. */
  'empty_snapshot',
  /** Fewer rows than the contract's declared minimum. */
  'row_count_below_minimum',
  /** Row count fell further below the baseline than the contract tolerates. */
  'row_count_dropped',
  /** A contract field appeared in no row. Usually a renamed or removed selector. */
  'field_absent',
  /** Fill rate is below the contract's floor for this field. */
  'fill_rate_below_contract',
  /** Fill rate is well below what previous healthy runs achieved. */
  'fill_rate_dropped',
  /** Values are present but fail the contract's validation rules. */
  'value_invalid',
  /** Values are present but systematically the wrong type. */
  'type_mismatch',
  /** Every row carries the same value — extraction latched onto a static label. */
  'constant_value',
  /** The median moved more than the contract tolerates. */
  'median_shifted',
  /** The collector returned a field the contract does not describe. */
  'unknown_field',
] as const;
export type FindingCode = (typeof FINDING_CODES)[number];

export interface Finding {
  readonly code: FindingCode;
  readonly severity: Severity;
  /** Null for findings about the run as a whole rather than one field. */
  readonly field: string | null;
  /** One sentence, with the numbers in it. Goes straight into the heal prompt. */
  readonly message: string;
  readonly observed: string;
  readonly expected: string;
}

const SEVERITY_RANK: Readonly<Record<Severity, number>> = {
  ok: 0,
  degraded: 1,
  broken: 2,
};

export function worstSeverity(severities: readonly Severity[]): Severity {
  return severities.reduce<Severity>(
    (worst, current) => (SEVERITY_RANK[current] > SEVERITY_RANK[worst] ? current : worst),
    'ok',
  );
}

export function isAtLeast(severity: Severity, threshold: Severity): boolean {
  return SEVERITY_RANK[severity] >= SEVERITY_RANK[threshold];
}

/**
 * Findings that describe a broken extraction, as opposed to a shifted value.
 *
 * Only these are worth healing. A price that legitimately moved 40% is a
 * finding, but sending it to an AI code refactorer would be absurd.
 */
const HEALABLE_CODES: ReadonlySet<FindingCode> = new Set([
  'field_absent',
  'fill_rate_below_contract',
  'fill_rate_dropped',
  'value_invalid',
  'type_mismatch',
  'constant_value',
]);

export function isHealable(finding: Finding): boolean {
  return finding.field !== null && HEALABLE_CODES.has(finding.code);
}
