/**
 * The chaos harness: deliberately damaged payloads for exercising detection.
 *
 * This exists because "wait for a website to be redesigned" is not a test plan.
 * Each mutation reproduces a failure mode observed in real scrapers, and the
 * mutated rows go through the *same* detection path as live rows — there is no
 * separate code path for chaos.
 *
 * It never fabricates a collection. A run produced here is stored with
 * `mode: 'chaos'`, so nothing can later mistake it for data from the web.
 */

export const CHAOS_MUTATIONS = [
  /** The field disappears entirely, as when a class name is renamed. */
  'drop-field',
  /** The field survives but every value is null: the selector matched nothing. */
  'null-field',
  /** The field is renamed, so the contract's field is absent and a new key appears. */
  'rename-field',
  /** Every row carries the same value: extraction latched onto a static element. */
  'constant-field',
  /** Only some rows come back, as when pagination breaks. */
  'truncate-rows',
  /** Values arrive in the wrong unit, for example paise instead of rupees. */
  'rescale-field',
  /** Numbers arrive as formatted strings. */
  'stringify-field',
  /** The snapshot is empty. */
  'empty-snapshot',
] as const;

export type ChaosMutation = (typeof CHAOS_MUTATIONS)[number];

export interface ChaosOptions {
  readonly mutation: ChaosMutation;
  /** Required by every mutation except truncate-rows and empty-snapshot. */
  readonly field?: string;
  /** Rows to keep for truncate-rows. */
  readonly keep?: number;
  /** Multiplier for rescale-field. Defaults to 100, the rupees-to-paise mistake. */
  readonly factor?: number;
  /** New key name for rename-field. Defaults to `<field>_v2`. */
  readonly renameTo?: string;
}

export class ChaosConfigurationError extends Error {}

/**
 * Apply a mutation to a payload.
 *
 * Returns a new array; the input is never modified, so a fixture can be reused
 * across several mutations in one test.
 */
export function applyChaos(rows: readonly unknown[], options: ChaosOptions): readonly unknown[] {
  const records = rows.filter(isRecord).map((row) => ({ ...row }));

  switch (options.mutation) {
    case 'empty-snapshot':
      return [];

    case 'truncate-rows': {
      const keep = options.keep ?? Math.max(1, Math.floor(records.length / 3));
      return records.slice(0, keep);
    }

    case 'drop-field': {
      const field = requireField(options);
      return records.map((row) => {
        const { [field]: _removed, ...rest } = row;
        return rest;
      });
    }

    case 'null-field': {
      const field = requireField(options);
      return records.map((row) => ({ ...row, [field]: null }));
    }

    case 'rename-field': {
      const field = requireField(options);
      const renamed = options.renameTo ?? `${field}_v2`;
      return records.map((row) => {
        const { [field]: value, ...rest } = row;
        return { ...rest, [renamed]: value };
      });
    }

    case 'constant-field': {
      const field = requireField(options);
      const first = records.find((row) => row[field] !== undefined && row[field] !== null);
      const frozen = first?.[field] ?? 'Add to cart';
      return records.map((row) => ({ ...row, [field]: frozen }));
    }

    case 'rescale-field': {
      const field = requireField(options);
      const factor = options.factor ?? 100;
      return records.map((row) => {
        const value = row[field];
        return typeof value === 'number' ? { ...row, [field]: value * factor } : row;
      });
    }

    case 'stringify-field': {
      const field = requireField(options);
      return records.map((row) => {
        const value = row[field];
        if (typeof value !== 'number') return row;
        return { ...row, [field]: `₹${value.toLocaleString('en-IN')}` };
      });
    }
  }
}

/** One-line description of what a mutation simulates, for CLI help and the demo. */
export function describeMutation(mutation: ChaosMutation): string {
  switch (mutation) {
    case 'drop-field':
      return 'the field disappears from the payload, as when a class name is renamed';
    case 'null-field':
      return 'the field is present but every value is null: the selector matched nothing';
    case 'rename-field':
      return 'the field is renamed, so the contract field is absent and an unknown key appears';
    case 'constant-field':
      return 'every row carries the same value: extraction latched onto a static element';
    case 'truncate-rows':
      return 'only some rows come back, as when pagination breaks';
    case 'rescale-field':
      return 'values arrive in the wrong unit, for example paise instead of rupees';
    case 'stringify-field':
      return 'numbers arrive as formatted strings such as "₹1,214.50"';
    case 'empty-snapshot':
      return 'the collector returns no rows at all';
  }
}

function requireField(options: ChaosOptions): string {
  if (options.field === undefined || options.field.trim() === '') {
    throw new ChaosConfigurationError(`the ${options.mutation} mutation needs a --field`);
  }
  return options.field;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
