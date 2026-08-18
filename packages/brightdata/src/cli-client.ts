/**
 * The `bdata` CLI, wrapped.
 *
 * Weaver uses two doors into Bright Data, on purpose:
 *
 *   - the Collection API (`collection-client.ts`) to RUN collectors, because it
 *     needs no Node process spawn and works unchanged in CI
 *   - this CLI adapter to CREATE and HEAL collectors, because `scraper create`
 *     and `scraper heal` drive Bright Data's AI Flow, and the CLI is the
 *     supported surface for it
 *
 * The command runner is injected, so every test here is a pure function of a
 * recorded stdout string. No subprocess is spawned during `pnpm test`.
 */
import { execFile } from 'node:child_process';
import { z } from 'zod';
import { BrightDataShapeError, ScraperStudioCliError, redact } from './errors.js';

export interface CommandResult {
  readonly stdout: string;
  readonly stderr: string;
  readonly exitCode: number | null;
}

/** Runs `bdata <args>` and resolves regardless of exit code. */
export type CommandRunner = (
  args: readonly string[],
  options: { readonly timeoutMs: number },
) => Promise<CommandResult>;

/** Max prompt length accepted by `bdata scraper heal`. */
export const HEAL_PROMPT_MAX_CHARS = 1000;

/** Max description length accepted by `bdata scraper create`. */
export const CREATE_DESCRIPTION_MAX_CHARS = 500;

/**
 * The heal envelope.
 *
 * Only the fields Weaver depends on are named; the rest are kept via passthrough
 * so the raw envelope can be stored as incident evidence without loss. The
 * shape is deliberately loose about `preview_result` because that payload
 * mirrors the collector's own output schema, which differs per source.
 */
const healEnvelopeSchema = z
  .object({
    collector_id: z.string().min(1),
    status: z.string().min(1),
    prompt: z.string().optional(),
    next_step: z.unknown().optional(),
    preview_result: z.unknown().optional(),
  })
  .loose();

export type HealEnvelope = z.infer<typeof healEnvelopeSchema>;

const createEnvelopeSchema = z
  .object({
    collector_id: z.string().min(1),
    name: z.string().optional(),
    status: z.string().optional(),
  })
  .loose();

export type CreateEnvelope = z.infer<typeof createEnvelopeSchema>;

/** Statuses that mean "a proposed fix is waiting at the approval gate". */
const AWAITING_APPROVAL_STATUSES = new Set(['awaiting_approval', 'pending_answer']);

export function isAwaitingApproval(envelope: HealEnvelope): boolean {
  return AWAITING_APPROVAL_STATUSES.has(envelope.status);
}

export interface ScraperStudioCliOptions {
  readonly run?: CommandRunner;
  /** Passed through as `-k`, so the CLI works without a browser login. */
  readonly apiKey?: string;
  readonly createTimeoutMs?: number;
  readonly healTimeoutMs?: number;
}

export class ScraperStudioCli {
  private readonly run: CommandRunner;
  private readonly apiKey: string | undefined;
  private readonly createTimeoutMs: number;
  private readonly healTimeoutMs: number;

  constructor(options: ScraperStudioCliOptions = {}) {
    this.run = options.run ?? defaultCommandRunner;
    this.apiKey = options.apiKey;
    // Generation is documented at 5 to 25 minutes. Allow 30, then give up.
    this.createTimeoutMs = options.createTimeoutMs ?? 1_800_000;
    this.healTimeoutMs = options.healTimeoutMs ?? 1_200_000;
  }

  /** `bdata scraper create <url> "<description>"` */
  async create(request: {
    readonly url: string;
    readonly description: string;
    readonly name?: string;
  }): Promise<CreateEnvelope> {
    if (request.description.length > CREATE_DESCRIPTION_MAX_CHARS) {
      throw new BrightDataShapeError(
        'scraper create',
        `description is ${request.description.length} chars; the CLI limit is ${CREATE_DESCRIPTION_MAX_CHARS}`,
      );
    }

    const args = ['scraper', 'create', request.url, request.description, '--json'];
    if (request.name !== undefined) args.push('--name', request.name);

    const output = await this.exec(args, this.createTimeoutMs, 'scraper create');
    return parseEnvelope(createEnvelopeSchema, output, 'scraper create');
  }

  /**
   * `bdata scraper heal <collector_id> "<prompt>" --url <url>`
   *
   * Never passes `--auto-approve`. Stopping at the gate is the entire point:
   * Weaver validates the preview against the contract before approving.
   */
  async heal(request: {
    readonly collectorId: string;
    readonly prompt: string;
    readonly url?: string;
  }): Promise<HealEnvelope> {
    if (request.prompt.length > HEAL_PROMPT_MAX_CHARS) {
      throw new BrightDataShapeError(
        'scraper heal',
        `prompt is ${request.prompt.length} chars; the CLI limit is ${HEAL_PROMPT_MAX_CHARS}`,
      );
    }

    const args = ['scraper', 'heal', request.collectorId, request.prompt, '--json'];
    if (request.url !== undefined) args.push('--url', request.url);

    const output = await this.exec(args, this.healTimeoutMs, 'scraper heal');
    return parseEnvelope(healEnvelopeSchema, output, 'scraper heal');
  }

  /** `bdata scraper approve <collector_id> [--reject] [--url <url>]` */
  async approve(request: {
    readonly collectorId: string;
    readonly reject?: boolean;
    readonly url?: string;
    readonly autoSave?: boolean;
  }): Promise<HealEnvelope> {
    const args = ['scraper', 'approve', request.collectorId, '--json'];
    if (request.reject === true) args.push('--reject');
    if (request.autoSave === true) args.push('--auto-save');
    if (request.url !== undefined) args.push('--url', request.url);

    const output = await this.exec(args, this.healTimeoutMs, 'scraper approve');
    return parseEnvelope(healEnvelopeSchema, output, 'scraper approve');
  }

  private async exec(args: readonly string[], timeoutMs: number, label: string): Promise<string> {
    const withAuth = this.apiKey === undefined ? args : [...args, '-k', this.apiKey];
    const result = await this.run(withAuth, { timeoutMs });

    if (result.exitCode !== 0) {
      throw new ScraperStudioCliError(
        label,
        result.exitCode,
        redact(result.stderr || result.stdout, this.apiKey),
      );
    }
    return result.stdout;
  }
}

/**
 * Extract the JSON envelope from CLI output.
 *
 * `bdata` prints human-readable progress lines while the AI pipeline runs and
 * then the JSON envelope, so the whole of stdout is rarely valid JSON. Rather
 * than guess at the progress format, this walks backwards from the end of the
 * output for the last thing that parses — the envelope is always last.
 */
export function extractJson(stdout: string): unknown {
  const text = stdout.trim();
  if (text === '') {
    throw new BrightDataShapeError('bdata', 'command produced no output');
  }

  const direct = tryParse(text);
  if (direct.ok) return direct.value;

  const lines = text.split('\n');
  for (let start = 0; start < lines.length; start += 1) {
    const candidate = lines.slice(start).join('\n').trim();
    if (!candidate.startsWith('{') && !candidate.startsWith('[')) continue;
    const attempt = tryParse(candidate);
    if (attempt.ok) return attempt.value;
  }

  throw new BrightDataShapeError('bdata', 'no JSON envelope found in CLI output');
}

function tryParse(text: string): { ok: true; value: unknown } | { ok: false } {
  try {
    return { ok: true, value: JSON.parse(text) as unknown };
  } catch {
    return { ok: false };
  }
}

function parseEnvelope<T extends z.ZodType>(schema: T, stdout: string, label: string): z.infer<T> {
  const json = extractJson(stdout);
  const parsed = schema.safeParse(json);
  if (!parsed.success) {
    throw new BrightDataShapeError(label, parsed.error.issues.map(describeIssue).join('; '));
  }
  return parsed.data as z.infer<T>;
}

function describeIssue(issue: z.core.$ZodIssue): string {
  const path = issue.path.length === 0 ? '(root)' : issue.path.join('.');
  return `${path}: ${issue.message}`;
}

/**
 * Rows out of a heal preview.
 *
 * `preview_result` mirrors the collector's own output schema, so it can arrive
 * as an array, as an object wrapping an array, or as a JSON string. All three
 * are handled because the alternative is an incident report that says
 * "preview unavailable" at the exact moment the operator needs to see it.
 */
export function extractPreviewRows(envelope: HealEnvelope): readonly unknown[] {
  return collectRows(envelope.preview_result);
}

function collectRows(value: unknown): readonly unknown[] {
  if (value === null || value === undefined) return [];
  if (Array.isArray(value)) return value;

  if (typeof value === 'string') {
    const parsed = tryParse(value);
    return parsed.ok ? collectRows(parsed.value) : [];
  }

  if (typeof value === 'object') {
    const record = value as Record<string, unknown>;
    for (const key of ['data', 'rows', 'result', 'results', 'output', 'preview']) {
      if (key in record) {
        const nested = collectRows(record[key]);
        if (nested.length > 0) return nested;
      }
    }
    // A single row object is still a preview of one row.
    return [value];
  }

  return [];
}

const defaultCommandRunner: CommandRunner = (args, options) =>
  new Promise((resolve) => {
    execFile(
      'npx',
      ['-y', '-p', '@brightdata/cli', 'bdata', ...args],
      { timeout: options.timeoutMs, maxBuffer: 32 * 1024 * 1024, encoding: 'utf8' },
      (error, stdout, stderr) => {
        const exitCode = error === null ? 0 : typeof error.code === 'number' ? error.code : null;
        resolve({ stdout, stderr, exitCode });
      },
    );
  });
