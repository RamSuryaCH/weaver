/**
 * Source contracts: the single source of truth for every field Weaver collects.
 *
 * The `description` on a field is deliberately load-bearing. The same sentence
 * is used three times:
 *
 *   1. to CREATE the scraper  (`bdata scraper create <url> "<description>"`)
 *   2. to VALIDATE every run  (this module, plus `drift.ts`)
 *   3. to REPAIR the scraper  (`bdata scraper heal <id> "<prompt>"`)
 *
 * That is the whole idea behind Weaver: the contract that built the scraper is
 * the contract that fixes it. Everything else here exists to make that sentence
 * machine-checkable.
 *
 * YAML uses snake_case because that is the convention in the Bright Data API
 * and in config files generally. The parsed domain objects use camelCase
 * because that is the convention in TypeScript. The transforms below are the
 * only place those two worlds meet.
 */
import { z } from 'zod';

/** Field value types Weaver can check. Deliberately small. */
export const FIELD_TYPES = ['string', 'number', 'integer', 'boolean', 'url'] as const;
export type FieldType = (typeof FIELD_TYPES)[number];

/**
 * The five Scraper Studio scraper types.
 *
 * Weaver treats these as metadata rather than behaviour: every type returns
 * rows, and rows are validated identically. The type only decides how inputs
 * are supplied (URLs, keywords or sitemaps).
 */
export const SCRAPER_TYPES = ['pdp', 'discovery', 'search', 'sitemap', 'browser'] as const;
export type ScraperType = (typeof SCRAPER_TYPES)[number];

/** What Weaver is allowed to do on its own when a contract is violated. */
export const HEAL_POLICIES = ['manual', 'gated', 'auto'] as const;
export type HealPolicy = (typeof HEAL_POLICIES)[number];

/**
 * Bright Data Collector IDs look like `c_mpohus372o5tmid1jk`. Healing keeps the
 * ID stable, which is exactly why it is safe to treat it as a permanent handle.
 */
export const COLLECTOR_ID_PATTERN = /^c_[a-z0-9]+$/i;

/** Max length of the description accepted by `bdata scraper create`. */
export const CREATE_DESCRIPTION_MAX_CHARS = 500;

/** Max length of the prompt accepted by `bdata scraper heal`. */
export const HEAL_PROMPT_MAX_CHARS = 1000;

const validationRulesYaml = z
  .object({
    gt: z.number().optional(),
    gte: z.number().optional(),
    lt: z.number().optional(),
    lte: z.number().optional(),
    min_length: z.number().int().nonnegative().optional(),
    max_length: z.number().int().positive().optional(),
    pattern: z.string().optional(),
    one_of: z.array(z.string()).min(1).optional(),
  })
  .strict();

export interface ValidationRules {
  readonly gt?: number;
  readonly gte?: number;
  readonly lt?: number;
  readonly lte?: number;
  readonly minLength?: number;
  readonly maxLength?: number;
  readonly pattern?: string;
  readonly oneOf?: readonly string[];
}

const driftRulesYaml = z
  .object({
    /** Flag when the median of a numeric field moves more than this percentage. */
    median_shift_pct: z.number().positive().optional(),
    /**
     * Flag when every row suddenly carries the same value. This is the quiet
     * failure mode: extraction "works", but has latched onto a static label
     * instead of the real value.
     */
    flag_constant: z.boolean().optional(),
    /** Flag when fill rate drops more than this many percentage points below baseline. */
    fill_rate_drop_pct: z.number().positive().optional(),
  })
  .strict();

export interface DriftRules {
  readonly medianShiftPct?: number;
  readonly flagConstant?: boolean;
  readonly fillRateDropPct?: number;
}

const fieldContractYaml = z
  .object({
    field: z
      .string()
      .min(1)
      .regex(/^[a-z][a-z0-9_]*$/, 'field names must be lower_snake_case'),
    description: z.string().min(10, 'a field description must be a usable sentence'),
    type: z.enum(FIELD_TYPES).default('string'),
    required: z.boolean().default(false),
    min_fill_rate: z.number().min(0).max(1).optional(),
    unit: z.string().min(1).optional(),
    validate: validationRulesYaml.optional(),
    drift: driftRulesYaml.optional(),
  })
  .strict();

export interface FieldContract {
  readonly field: string;
  /** Plain-language description. Used to create, validate and heal the field. */
  readonly description: string;
  readonly type: FieldType;
  readonly required: boolean;
  /**
   * Minimum fraction of rows that must carry a usable value.
   * Defaults to 0.9 for required fields and 0 for optional ones, because the
   * Scraper Studio AI schema is best-effort per row: a legitimately absent
   * field is omitted rather than nulled, so absolute thresholds on optional
   * fields produce false positives.
   */
  readonly minFillRate: number;
  readonly unit?: string;
  readonly validate?: ValidationRules;
  readonly drift?: DriftRules;
}

const expectationsYaml = z
  .object({
    min_rows: z.number().int().positive().default(1),
    max_row_drop_pct: z.number().min(0).max(100).default(50),
  })
  .strict();

export interface Expectations {
  readonly minRows: number;
  /** Flag when row count falls more than this percentage below baseline. */
  readonly maxRowDropPct: number;
}

const policyYaml = z
  .object({
    heal: z.enum(HEAL_POLICIES).default('gated'),
    max_heal_attempts: z.number().int().positive().max(10).default(3),
  })
  .strict();

export interface SourcePolicy {
  readonly heal: HealPolicy;
  readonly maxHealAttempts: number;
}

const inputsYaml = z
  .object({
    urls: z.array(z.url()).optional(),
    keywords: z.array(z.string().min(1)).optional(),
    sitemaps: z.array(z.url()).optional(),
  })
  .strict();

export interface SourceInputs {
  readonly urls?: readonly string[];
  readonly keywords?: readonly string[];
  readonly sitemaps?: readonly string[];
}

const sourceContractYaml = z
  .object({
    id: z
      .string()
      .min(1)
      .regex(/^[a-z][a-z0-9-]*$/, 'source ids must be lower-kebab-case'),
    name: z.string().min(1),
    type: z.enum(SCRAPER_TYPES),
    target_url: z.url(),
    collector_id: z.string().regex(COLLECTOR_ID_PATTERN).nullable().default(null),
    /**
     * The sentence handed to `bdata scraper create`. Capped at 500 characters
     * because the CLI rejects anything longer.
     */
    description: z.string().min(10).max(CREATE_DESCRIPTION_MAX_CHARS),
    /** Fields that together identify a row across runs, for diffing and dedupe. */
    row_key: z.array(z.string().min(1)).min(1),
    inputs: inputsYaml.default({}),
    expectations: expectationsYaml.default({ min_rows: 1, max_row_drop_pct: 50 }),
    policy: policyYaml.default({ heal: 'gated', max_heal_attempts: 3 }),
    schema: z.array(fieldContractYaml).min(1),
  })
  .strict();

export interface SourceContract {
  readonly id: string;
  readonly name: string;
  readonly type: ScraperType;
  readonly targetUrl: string;
  /** Null until `bdata scraper create` has run and returned an ID. */
  readonly collectorId: string | null;
  readonly description: string;
  readonly rowKey: readonly string[];
  readonly inputs: SourceInputs;
  readonly expectations: Expectations;
  readonly policy: SourcePolicy;
  readonly schema: readonly FieldContract[];
}

function toValidationRules(raw: z.infer<typeof validationRulesYaml>): ValidationRules {
  return {
    gt: raw.gt,
    gte: raw.gte,
    lt: raw.lt,
    lte: raw.lte,
    minLength: raw.min_length,
    maxLength: raw.max_length,
    pattern: raw.pattern,
    oneOf: raw.one_of,
  };
}

function toDriftRules(raw: z.infer<typeof driftRulesYaml>): DriftRules {
  return {
    medianShiftPct: raw.median_shift_pct,
    flagConstant: raw.flag_constant,
    fillRateDropPct: raw.fill_rate_drop_pct,
  };
}

function toFieldContract(raw: z.infer<typeof fieldContractYaml>): FieldContract {
  return {
    field: raw.field,
    description: raw.description,
    type: raw.type,
    required: raw.required,
    minFillRate: raw.min_fill_rate ?? (raw.required ? 0.9 : 0),
    unit: raw.unit,
    validate: raw.validate === undefined ? undefined : toValidationRules(raw.validate),
    drift: raw.drift === undefined ? undefined : toDriftRules(raw.drift),
  };
}

/**
 * Parse an already-deserialised YAML/JSON value into a SourceContract.
 *
 * Kept separate from file reading so the whole contract layer stays pure and
 * testable. `loadSourceContract` in `@weaver/cli` supplies the I/O.
 */
export function parseSourceContract(input: unknown): SourceContract {
  const raw = sourceContractYaml.parse(input);
  const contract: SourceContract = {
    id: raw.id,
    name: raw.name,
    type: raw.type,
    targetUrl: raw.target_url,
    collectorId: raw.collector_id,
    description: raw.description,
    rowKey: raw.row_key,
    inputs: {
      urls: raw.inputs.urls,
      keywords: raw.inputs.keywords,
      sitemaps: raw.inputs.sitemaps,
    },
    expectations: {
      minRows: raw.expectations.min_rows,
      maxRowDropPct: raw.expectations.max_row_drop_pct,
    },
    policy: {
      heal: raw.policy.heal,
      maxHealAttempts: raw.policy.max_heal_attempts,
    },
    schema: raw.schema.map(toFieldContract),
  };
  assertContractCoherent(contract);
  return contract;
}

/**
 * Checks that cannot be expressed field-by-field in zod.
 *
 * These catch contract authoring mistakes that would otherwise show up much
 * later as confusing drift findings.
 */
function assertContractCoherent(contract: SourceContract): void {
  const fieldNames = new Set(contract.schema.map((field) => field.field));

  if (fieldNames.size !== contract.schema.length) {
    throw new Error(`source "${contract.id}": duplicate field names in schema`);
  }

  for (const key of contract.rowKey) {
    if (!fieldNames.has(key)) {
      throw new Error(`source "${contract.id}": row_key "${key}" is not a field in schema`);
    }
  }

  for (const field of contract.schema) {
    if (field.drift?.medianShiftPct !== undefined && !isNumericType(field.type)) {
      throw new Error(
        `source "${contract.id}": field "${field.field}" sets drift.median_shift_pct but is not numeric`,
      );
    }
  }

  const needsUrls = contract.type === 'pdp' || contract.type === 'discovery';
  if (needsUrls && (contract.inputs.urls === undefined || contract.inputs.urls.length === 0)) {
    throw new Error(`source "${contract.id}": type "${contract.type}" requires inputs.urls`);
  }
  if (
    contract.type === 'search' &&
    (contract.inputs.keywords === undefined || contract.inputs.keywords.length === 0)
  ) {
    throw new Error(`source "${contract.id}": type "search" requires inputs.keywords`);
  }
  if (
    contract.type === 'sitemap' &&
    (contract.inputs.sitemaps === undefined || contract.inputs.sitemaps.length === 0)
  ) {
    throw new Error(`source "${contract.id}": type "sitemap" requires inputs.sitemaps`);
  }
}

export function isNumericType(type: FieldType): boolean {
  return type === 'number' || type === 'integer';
}

/** Look up a field contract by name. */
export function findField(contract: SourceContract, fieldName: string): FieldContract | undefined {
  return contract.schema.find((field) => field.field === fieldName);
}

/** Fields that must be present for the source to be considered working at all. */
export function requiredFields(contract: SourceContract): readonly FieldContract[] {
  return contract.schema.filter((field) => field.required);
}
