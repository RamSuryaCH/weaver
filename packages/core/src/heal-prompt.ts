/**
 * Turning a finding into a heal prompt.
 *
 * `bdata scraper heal` takes plain language and rewrites the scraper. What you
 * say to it decides whether the repair works, and Bright Data's own
 * troubleshooting guidance is specific about why prompts fail:
 *
 *   - vague prompt          -> re-prompt with specific field names and an example
 *   - preview still empty   -> include the expected markup or element
 *   - refactor runs too long -> break it up, one field at a time
 *
 * Those three remedies are encoded as three escalating strategies. Attempt one
 * describes every broken field; attempt two adds the reason the last preview was
 * rejected plus a markup hint; attempt three narrows to a single field.
 *
 * Everything here is pure text assembly, so the prompts are snapshot-testable
 * and identical in CI, in the terminal and in the demo.
 */
import { HEAL_PROMPT_MAX_CHARS, type FieldContract, type SourceContract } from './contract.js';
import { findField } from './contract.js';
import { isHealable, type Finding } from './findings.js';
import type { RunStatistics } from './statistics.js';

export type HealStrategy = 'describe-all' | 'sharpen' | 'single-field';

export interface HealPromptInput {
  readonly contract: SourceContract;
  /** All findings from the run; unhealable ones are filtered out here. */
  readonly findings: readonly Finding[];
  readonly statistics: RunStatistics;
  /** 1 for the first attempt. Later attempts escalate the strategy. */
  readonly attempt: number;
  /** Why the previous preview failed the contract, if there was one. */
  readonly previousFailure?: string;
}

export interface HealPrompt {
  readonly text: string;
  /** Fields this prompt asks Bright Data to repair. */
  readonly fields: readonly string[];
  readonly strategy: HealStrategy;
  readonly attempt: number;
}

export class NothingToHealError extends Error {
  constructor(sourceId: string) {
    super(
      `nothing healable in the findings for "${sourceId}". ` +
        'Value shifts and unknown fields are reported but never sent to a code refactorer.',
    );
    this.name = 'NothingToHealError';
  }
}

/**
 * Fields described in one prompt on the first attempt.
 *
 * More than three and the prompt stops being specific enough to act on, which is
 * the failure mode Bright Data warns about.
 */
const MAX_FIELDS_PER_PROMPT = 3;

export function chooseStrategy(attempt: number): HealStrategy {
  if (attempt <= 1) return 'describe-all';
  if (attempt === 2) return 'sharpen';
  return 'single-field';
}

export function synthesizeHealPrompt(input: HealPromptInput): HealPrompt {
  const healable = input.findings.filter(isHealable);
  if (healable.length === 0) throw new NothingToHealError(input.contract.id);

  const strategy = chooseStrategy(input.attempt);
  const selected = selectFindings(healable, strategy);
  const fields = unique(selected.map((finding) => finding.field ?? ''));

  const text = assemble({
    contract: input.contract,
    findings: selected,
    statistics: input.statistics,
    strategy,
    ...(input.previousFailure === undefined ? {} : { previousFailure: input.previousFailure }),
  });

  return { text, fields, strategy, attempt: input.attempt };
}

/**
 * Findings are ordered so the most severe, most specific break leads.
 *
 * A prompt that opens with "mrp is missing from all 15 rows" gets a better
 * repair than one that opens with an optional field's fill rate.
 */
function selectFindings(healable: readonly Finding[], strategy: HealStrategy): readonly Finding[] {
  const ordered = [...healable].sort(byImportance);
  return strategy === 'single-field'
    ? ordered.slice(0, 1)
    : ordered.slice(0, MAX_FIELDS_PER_PROMPT);
}

const CODE_PRIORITY: Readonly<Record<string, number>> = {
  field_absent: 0,
  constant_value: 1,
  fill_rate_below_contract: 2,
  value_invalid: 3,
  type_mismatch: 4,
  fill_rate_dropped: 5,
};

function byImportance(a: Finding, b: Finding): number {
  if (a.severity !== b.severity) return a.severity === 'broken' ? -1 : 1;
  return (CODE_PRIORITY[a.code] ?? 9) - (CODE_PRIORITY[b.code] ?? 9);
}

interface AssembleInput {
  readonly contract: SourceContract;
  readonly findings: readonly Finding[];
  readonly statistics: RunStatistics;
  readonly strategy: HealStrategy;
  readonly previousFailure?: string;
}

/**
 * Build the prompt from prioritised sections and drop the least important ones
 * until it fits.
 *
 * The order below is the priority order: the symptom and the field description
 * always survive, examples and hints are given up first. Truncating mid-sentence
 * would be worse than saying less.
 */
function assemble(input: AssembleInput): string {
  const essential = [symptomSection(input.findings), descriptionSection(input)];
  const optional = [
    input.previousFailure === undefined ? null : previousFailureSection(input.previousFailure),
    exampleSection(input),
    markupHintSection(input),
    instructionSection(input),
  ].filter((section): section is string => section !== null);

  for (let drop = 0; drop <= optional.length; drop += 1) {
    const sections = [...essential, ...optional.slice(0, optional.length - drop)].filter(
      (section) => section.trim() !== '',
    );
    const text = sections.join(' ');
    if (text.length <= HEAL_PROMPT_MAX_CHARS) return text;
  }

  // Even the essential sections are too long: keep the symptom alone.
  return essential[0]?.slice(0, HEAL_PROMPT_MAX_CHARS) ?? '';
}

function symptomSection(findings: readonly Finding[]): string {
  return findings.map((finding) => `${capitalise(finding.message)}.`).join(' ');
}

function descriptionSection(input: AssembleInput): string {
  const described = input.findings
    .map((finding) => {
      const field = finding.field === null ? undefined : findField(input.contract, finding.field);
      return field === undefined ? null : `"${field.field}" is ${field.description}`;
    })
    .filter((line): line is string => line !== null);

  return described.length === 0 ? '' : `${described.join('; ')}.`;
}

function previousFailureSection(reason: string): string {
  return `A previous fix was rejected because ${reason}.`;
}

/**
 * An example of what the page actually returned.
 *
 * Bright Data's guidance is explicit that a prompt with an example error value
 * outperforms one without, so this is the last optional section to be dropped.
 */
function exampleSection(input: AssembleInput): string {
  const parts: string[] = [];

  for (const finding of input.findings) {
    if (finding.field === null) continue;
    const stats = input.statistics.fields[finding.field];
    if (stats === undefined) continue;

    if (stats.firstInvalid !== undefined) {
      parts.push(`"${finding.field}" came back as ${format(stats.firstInvalid.raw)}`);
    } else if (stats.presentCount === 0) {
      parts.push(`"${finding.field}" came back empty`);
    } else if (stats.samples[0] !== undefined) {
      parts.push(`"${finding.field}" came back as ${format(stats.samples[0])}`);
    }
  }

  return parts.length === 0 ? '' : `Observed: ${parts.join('; ')}.`;
}

/**
 * Where to look on the page.
 *
 * All three pharmacy sources publish schema.org product data, which is far more
 * stable than their class names — so pointing the refactorer at it is both a
 * better repair and a more durable one.
 */
function markupHintSection(input: AssembleInput): string {
  if (input.strategy === 'describe-all') return '';
  return (
    'Prefer the values in the embedded JSON-LD structured data on the page ' +
    '(schema.org Product or Offer) over CSS class names, which change often.'
  );
}

function instructionSection(input: AssembleInput): string {
  const fieldList = input.findings
    .map((finding) => `"${finding.field ?? ''}"`)
    .filter((name) => name !== '""')
    .join(', ');

  const typeNote = numericFields(input)
    .map((field) => `Return ${`"${field.field}"`} as a plain number with no currency symbol.`)
    .join(' ');

  const scope =
    input.strategy === 'single-field'
      ? `Fix only ${fieldList} in this pass; leave every other field untouched.`
      : `Re-capture ${fieldList} from the current markup and leave every other field untouched.`;

  return typeNote === '' ? scope : `${scope} ${typeNote}`;
}

function numericFields(input: AssembleInput): readonly FieldContract[] {
  return input.findings
    .map((finding) =>
      finding.field === null ? undefined : findField(input.contract, finding.field),
    )
    .filter(
      (field): field is FieldContract =>
        field !== undefined && (field.type === 'number' || field.type === 'integer'),
    );
}

function format(value: unknown): string {
  if (value === null) return 'null';
  if (value === undefined) return 'nothing';
  if (typeof value === 'string') {
    const clipped = value.length > 30 ? `${value.slice(0, 30)}...` : value;
    return `"${clipped}"`;
  }
  if (typeof value === 'number' || typeof value === 'boolean') return String(value);
  return 'an unexpected object';
}

function capitalise(text: string): string {
  return text.length === 0 ? text : text[0]!.toUpperCase() + text.slice(1);
}

function unique(values: readonly string[]): readonly string[] {
  return [...new Set(values.filter((value) => value !== ''))];
}
