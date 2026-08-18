/**
 * The verify-then-approve heal loop.
 *
 * The shape of one attempt:
 *
 *   synthesize prompt -> bdata scraper heal -> approval gate returns a preview
 *   -> verify the preview against the SAME contract that detected the break
 *   -> pass? approve. fail? reject, sharpen the prompt from the specific reason,
 *      and try again within a bounded budget.
 *
 * Then re-collect and re-validate, because an approved fix that still does not
 * satisfy the contract is not a fix. Only that second check closes the incident.
 *
 * Two rules this module exists to enforce:
 *
 *   - `--auto-approve` is never passed to the CLI. The gate is the product.
 *   - The Collector ID must be identical before and after. Everything downstream
 *     depends on that, so it is asserted rather than assumed.
 */
import {
  computeRunStatistics,
  describeVerdict,
  synthesizeHealPrompt,
  verifyPreview,
  NothingToHealError,
  type Finding,
  type HealPolicy,
  type HealStrategy,
  type RunStatistics,
  type SourceContract,
} from '@weaver/core';
import {
  extractPreviewRows,
  isAwaitingApproval,
  type HealEnvelope,
  type ScraperStudioCli,
} from '@weaver/brightdata';
import type { RunMode } from '@weaver/db';
import type { EngineDeps, EngineEvent } from './collect.js';
import { collectSource } from './collect.js';

export interface HealDeps extends EngineDeps {
  readonly cli: ScraperStudioCli;
  /** Called when the heal budget is exhausted. Wired to `gh issue create`. */
  readonly escalate?: (input: EscalationInput) => Promise<string | undefined>;
}

export interface EscalationInput {
  readonly contract: SourceContract;
  readonly incidentId: string;
  readonly attempts: readonly HealAttempt[];
  readonly findings: readonly Finding[];
}

export interface HealOptions {
  readonly contract: SourceContract;
  /** Effective policy: the stricter of the environment default and the contract. */
  readonly policy: HealPolicy;
  readonly maxAttempts?: number;
  /** Print the prompt and stop, spending nothing. */
  readonly dryRun?: boolean;
  /** Re-collect after approval to confirm the fix. Off only for tests. */
  readonly verify?: boolean;
  /**
   * How to re-collect for that confirmation. Follows the configured run mode, so
   * a replay-mode demo can complete the whole loop without spending a credit
   * while a live run verifies against the real site.
   */
  readonly verifyMode?: RunMode;
}

export interface HealAttempt {
  readonly attempt: number;
  readonly strategy: HealStrategy;
  readonly prompt: string;
  readonly fields: readonly string[];
  readonly previewRows: number;
  readonly verdict: 'approved' | 'rejected';
  readonly reason: string;
}

export type HealStatus =
  | 'not_needed'
  | 'dry_run'
  | 'policy_manual'
  | 'healed'
  | 'approved_but_unverified'
  | 'exhausted';

export interface HealOutcome {
  readonly status: HealStatus;
  readonly attempts: readonly HealAttempt[];
  readonly incidentId: string | undefined;
  /** Set for a dry run, where nothing was sent. */
  readonly prompt: string | undefined;
  readonly escalationUrl: string | undefined;
}

export class CollectorIdChangedError extends Error {
  constructor(before: string, after: string) {
    super(
      `the collector id changed during healing, from ${before} to ${after}. ` +
        'Healing is supposed to be in place; everything downstream depends on it.',
    );
    this.name = 'CollectorIdChangedError';
  }
}

export class NoRunToHealError extends Error {
  constructor(sourceId: string) {
    super(
      `no recorded run for "${sourceId}", so there is nothing to diagnose. ` +
        `Run: weaver collect --source ${sourceId}`,
    );
    this.name = 'NoRunToHealError';
  }
}

export async function healSource(deps: HealDeps, options: HealOptions): Promise<HealOutcome> {
  const { contract } = options;
  const log = deps.log ?? (() => undefined);
  const maxAttempts = options.maxAttempts ?? contract.policy.maxHealAttempts;

  const run = await deps.store.latestRun(contract.id);
  if (run === undefined) throw new NoRunToHealError(contract.id);

  if (run.severity === 'ok') {
    return {
      status: 'not_needed',
      attempts: [],
      incidentId: undefined,
      prompt: undefined,
      escalationUrl: undefined,
    };
  }

  const findings = await deps.store.findingsForRun(run.id);
  const statistics = await statisticsForRun(deps, contract, run.id);
  const incident = await deps.store.openIncidentFor(contract.id);

  // A dry run answers "what would you say?" without spending a credit.
  if (options.dryRun === true) {
    const prompt = synthesizeHealPrompt({ contract, findings, statistics, attempt: 1 });
    return {
      status: 'dry_run',
      attempts: [],
      incidentId: incident?.id,
      prompt: prompt.text,
      escalationUrl: undefined,
    };
  }

  if (options.policy === 'manual') {
    return {
      status: 'policy_manual',
      attempts: [],
      incidentId: incident?.id,
      prompt: undefined,
      escalationUrl: undefined,
    };
  }

  const collectorId = requireCollectorId(contract);
  const attempts: HealAttempt[] = [];
  let previousFailure: string | undefined;

  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    const prompt = synthesizeHealPrompt({
      contract,
      findings,
      statistics,
      attempt,
      ...(previousFailure === undefined ? {} : { previousFailure }),
    });

    log(event('heal_requested', contract.id, `attempt ${attempt} (${prompt.strategy})`));
    await record(deps, incident?.id, 'heal_requested', `attempt ${attempt}: ${prompt.strategy}`, {
      prompt: prompt.text,
      fields: prompt.fields,
    });
    if (incident !== undefined) {
      await deps.store.setIncidentStatus({
        incidentId: incident.id,
        status: 'healing',
        healAttempts: attempt,
      });
    }

    const healed = await deps.cli.heal({
      collectorId,
      prompt: prompt.text,
      url: verifyUrl(contract),
    });
    assertSameCollector(collectorId, healed);

    if (!isAwaitingApproval(healed)) {
      // The CLI reached a terminal state without a gate. Nothing to verify, so
      // fall through to the re-collect check, which is the real arbiter anyway.
      await record(
        deps,
        incident?.id,
        'preview_received',
        `heal returned ${healed.status}`,
        healed,
      );
      break;
    }

    const previewRows = extractPreviewRows(healed);
    await record(
      deps,
      incident?.id,
      'preview_received',
      `preview returned ${previewRows.length} row(s)`,
      { previewRows, envelope: healed },
    );
    if (incident !== undefined) {
      await deps.store.setIncidentStatus({
        incidentId: incident.id,
        status: 'awaiting_approval',
        healAttempts: attempt,
      });
    }

    const verdict = verifyPreview({ contract, fields: prompt.fields, rows: previewRows });
    const reason = describeVerdict(verdict);

    if (verdict.ok) {
      log(event('preview_verified', contract.id, reason));
      await record(deps, incident?.id, 'preview_verified', reason, verdict);

      const approved = await deps.cli.approve({ collectorId, url: verifyUrl(contract) });
      assertSameCollector(collectorId, approved);
      await record(deps, incident?.id, 'approved', `approved: ${approved.status}`, approved);

      attempts.push({
        attempt,
        strategy: prompt.strategy,
        prompt: prompt.text,
        fields: prompt.fields,
        previewRows: previewRows.length,
        verdict: 'approved',
        reason,
      });
      break;
    }

    // The preview failed the contract. Reject it, so the collector is left
    // exactly as it was, and sharpen the next prompt from this specific reason.
    log(event('preview_rejected', contract.id, reason));
    await record(deps, incident?.id, 'preview_rejected', reason, verdict);

    await rejectQuietly(deps, incident?.id, collectorId);

    attempts.push({
      attempt,
      strategy: prompt.strategy,
      prompt: prompt.text,
      fields: prompt.fields,
      previewRows: previewRows.length,
      verdict: 'rejected',
      reason,
    });
    previousFailure = reason;
  }

  const approvedOne = attempts.some((item) => item.verdict === 'approved');

  if (!approvedOne) {
    const escalationUrl = await escalate(deps, contract, incident?.id, attempts, findings);
    return {
      status: 'exhausted',
      attempts,
      incidentId: incident?.id,
      prompt: undefined,
      escalationUrl,
    };
  }

  if (options.verify === false) {
    return {
      status: 'approved_but_unverified',
      attempts,
      incidentId: incident?.id,
      prompt: undefined,
      escalationUrl: undefined,
    };
  }

  // An approved fix still has to satisfy the contract on a real run. This is the
  // check that closes the incident, and it is the reason `--auto-approve` is not
  // enough on its own.
  const recollected = await collectSource(deps, {
    contract,
    mode: options.verifyMode ?? 'live',
  });
  await record(
    deps,
    incident?.id,
    'reverified',
    `re-run after approval: ${recollected.report.severity}`,
    { runId: recollected.run.id, severity: recollected.report.severity },
  );

  if (recollected.report.severity === 'ok') {
    return {
      status: 'healed',
      attempts,
      incidentId: incident?.id,
      prompt: undefined,
      escalationUrl: undefined,
    };
  }

  const escalationUrl = await escalate(deps, contract, incident?.id, attempts, findings);
  return {
    status: 'approved_but_unverified',
    attempts,
    incidentId: incident?.id,
    prompt: undefined,
    escalationUrl,
  };
}

/**
 * Reject a proposed fix, and do not let the rejection itself derail the loop.
 *
 * Rejection exists to leave the collector alone. Observed against the live API,
 * `bdata scraper approve --reject` can answer 500 with
 * `sprintf invalid format %j` — a fault inside Bright Data's own job resumption —
 * while still reporting that the scraper is unchanged and still works.
 *
 * That outcome is what a rejection is for, so treating the error as fatal would
 * abandon the repair over a cosmetic upstream failure. Weaver records what
 * happened as incident evidence and moves on to the sharpened prompt. The
 * collector is not modified either way: only `approve` commits a change, and
 * approve is never called on a preview that failed the contract.
 */
async function rejectQuietly(
  deps: HealDeps,
  incidentId: string | undefined,
  collectorId: string,
): Promise<void> {
  try {
    const rejected = await deps.cli.approve({ collectorId, reject: true });
    assertSameCollector(collectorId, rejected);
    await record(
      deps,
      incidentId,
      'rejected',
      'proposed fix rejected, collector unchanged',
      rejected,
    );
  } catch (error) {
    if (error instanceof CollectorIdChangedError) throw error;

    await record(
      deps,
      incidentId,
      'rejected',
      'reject call failed upstream; the collector was never modified, so it is unchanged',
      { error: error instanceof Error ? error.message : String(error) },
    );
  }
}

/**
 * The narrower of the environment policy and the contract policy wins.
 *
 * A contract that asks for manual review must not be overridden by an
 * environment variable, and vice versa: whoever is more cautious is right.
 */
export function effectivePolicy(environment: HealPolicy, contract: HealPolicy): HealPolicy {
  const rank: Record<HealPolicy, number> = { manual: 0, gated: 1, auto: 2 };
  return rank[environment] <= rank[contract] ? environment : contract;
}

async function escalate(
  deps: HealDeps,
  contract: SourceContract,
  incidentId: string | undefined,
  attempts: readonly HealAttempt[],
  findings: readonly Finding[],
): Promise<string | undefined> {
  const at = deps.now().toISOString();
  const summary = `heal budget exhausted after ${attempts.length} attempt(s)`;

  if (incidentId !== undefined) {
    await deps.store.appendIncidentEvent({
      incidentId,
      kind: 'escalated',
      message: summary,
      detail: { attempts },
      at,
    });
    await deps.store.setIncidentStatus({ incidentId, status: 'escalated' });
  }

  (deps.log ?? (() => undefined))(event('escalated', contract.id, summary));

  if (deps.escalate === undefined || incidentId === undefined) return undefined;
  return await deps.escalate({ contract, incidentId, attempts, findings });
}

/**
 * Append an incident event, and never let bookkeeping destroy the repair.
 *
 * The heal loop's expensive work happens inside Bright Data: a five-to-fifteen
 * minute AI refactor whose result exists whether or not Weaver manages to write a
 * row about it. Letting an insert failure propagate would throw that away — which
 * is exactly what happened in development when the database was recreated while a
 * heal was in flight and the incident's foreign key vanished underneath it.
 *
 * So evidence is best-effort and the loop is not. The failure is reported on
 * stderr rather than swallowed silently, because a store that cannot write is a
 * real problem, just not one worth losing a repair over.
 */
async function record(
  deps: HealDeps,
  incidentId: string | undefined,
  kind: Parameters<EngineDeps['store']['appendIncidentEvent']>[0]['kind'],
  message: string,
  detail?: unknown,
): Promise<void> {
  if (incidentId === undefined) return;

  try {
    await deps.store.appendIncidentEvent({
      incidentId,
      kind,
      message,
      detail,
      at: deps.now().toISOString(),
    });
  } catch (error) {
    (deps.log ?? (() => undefined))(
      event(
        'heal_requested',
        incidentId,
        `could not record "${kind}" evidence: ${error instanceof Error ? error.message : String(error)}`,
      ),
    );
  }
}

/**
 * Rebuild the statistics of a stored run.
 *
 * The heal prompt needs example values, and examples are not persisted in
 * `field_stats` — so they are recomputed from the raw payload, which is.
 */
async function statisticsForRun(
  deps: EngineDeps,
  contract: SourceContract,
  runId: string,
): Promise<RunStatistics> {
  return computeRunStatistics(contract, await deps.store.rawPayload(runId));
}

function requireCollectorId(contract: SourceContract): string {
  if (contract.collectorId === null) {
    throw new Error(`source "${contract.id}" has no collector_id, so there is nothing to heal.`);
  }
  return contract.collectorId;
}

function verifyUrl(contract: SourceContract): string {
  return contract.inputs.urls?.[0] ?? contract.targetUrl;
}

function assertSameCollector(expected: string, envelope: HealEnvelope): void {
  if (envelope.collector_id !== expected) {
    throw new CollectorIdChangedError(expected, envelope.collector_id);
  }
}

function event(kind: EngineEvent['kind'], sourceId: string, message: string): EngineEvent {
  return { kind, sourceId, message };
}

export { NothingToHealError };
