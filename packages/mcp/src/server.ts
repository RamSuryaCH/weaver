/**
 * The Weaver MCP server.
 *
 * Bright Data's guidance for this workflow is that the terminal is the UI and the
 * dashboard is for a glance. Weaver takes that literally: the entire reliability
 * loop — collect, diagnose, heal, compare — is exposed as MCP tools, so a coding
 * agent can operate it conversationally with no dashboard open at all.
 *
 * The tools are deliberately shaped as tasks rather than as a thin wrapper over
 * the database. An agent should be able to ask "is anything broken and what would
 * you do about it?" in one call, because that is the question a human asks.
 *
 * Safety is structural rather than advisory:
 *
 *   - `weaver_diagnose` is read-only and always shows the prompt it *would* send.
 *   - `weaver_heal` refuses to run under a `manual` policy, and refuses to run at
 *     all unless the caller passes `confirm: true`. An agent cannot approve a
 *     change to a live collector by accident.
 *   - The verify-then-approve gate is inside the engine, so it applies to an
 *     agent exactly as it applies to the CLI. There is no bypass to expose.
 */
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import {
  compareByMolecule,
  computeRunStatistics,
  readOffers,
  synthesizeHealPrompt,
  type SourceContract,
} from '@weaver/core';
import { effectivePolicy, healSource, type HealDeps } from '@weaver/engine';
import { collectSource } from '@weaver/engine';
import type { WeaverEnv } from '@weaver/config';

export interface WeaverToolDeps extends HealDeps {
  readonly env: WeaverEnv;
  readonly contracts: readonly SourceContract[];
}

export const WEAVER_TOOL_NAMES = [
  'weaver_list_sources',
  'weaver_collect',
  'weaver_diagnose',
  'weaver_heal',
  'weaver_compare_prices',
] as const;

/** Text-only tool result, which is what every MCP client can render. */
function text(body: string): { content: [{ type: 'text'; text: string }] } {
  return { content: [{ type: 'text', text: body }] };
}

export function createWeaverServer(deps: WeaverToolDeps): McpServer {
  const server = new McpServer({ name: 'weaver', version: '0.1.0' });

  server.registerTool(
    'weaver_list_sources',
    {
      title: 'List Weaver sources',
      description:
        'Every website Weaver watches, with its Bright Data Collector ID, the scraper type, ' +
        'and the severity of its most recent run.',
      inputSchema: {},
      annotations: { readOnlyHint: true, openWorldHint: false },
    },
    async () => {
      const lines: string[] = [];

      for (const contract of deps.contracts) {
        const run = await deps.store.latestRun(contract.id);
        lines.push(
          `- ${contract.id} (${contract.name}, ${contract.type}): ` +
            `collector ${contract.collectorId ?? 'not created yet'}, ` +
            `${
              run === undefined
                ? 'no runs recorded'
                : `last run ${run.severity} at ${run.startedAt} with ${String(run.rowCount)} rows`
            }`,
        );
      }

      return text(lines.length === 0 ? 'No sources configured.' : lines.join('\n'));
    },
  );

  server.registerTool(
    'weaver_collect',
    {
      title: 'Collect from a source',
      description:
        'Trigger a Bright Data collector (mode "live") or replay the last recorded run ' +
        '(mode "replay"), then validate the result against the source contract. ' +
        'Live mode spends Bright Data credits.',
      inputSchema: {
        source: z.string().describe('source id, as listed by weaver_list_sources'),
        mode: z.enum(['live', 'replay']).optional().describe('defaults to the configured mode'),
        limit: z.number().int().positive().optional().describe('use only the first n inputs'),
      },
      annotations: { readOnlyHint: false, openWorldHint: true },
    },
    async ({ source, mode, limit }) => {
      const contract = findContract(deps, source);
      const outcome = await collectSource(deps, {
        contract,
        mode: mode ?? deps.env.mode,
        ...(limit === undefined ? {} : { limit }),
      });

      const lines = [
        `${contract.name}: ${outcome.report.severity} — ${String(outcome.report.statistics.rowCount)} rows.`,
      ];
      for (const finding of outcome.report.findings) {
        lines.push(`- ${finding.field ?? 'run'}: ${finding.message}`);
      }
      if (outcome.incidentId !== undefined && outcome.report.severity !== 'ok') {
        lines.push(`Incident ${outcome.incidentId} is open. Call weaver_diagnose next.`);
      }

      return text(lines.join('\n'));
    },
  );

  server.registerTool(
    'weaver_diagnose',
    {
      title: 'Diagnose a source',
      description:
        'Explain the latest run for a source: every contract violation with the observed and ' +
        'expected values, and the exact heal prompt Weaver would send. Read-only: it never ' +
        'contacts Bright Data and never changes a collector.',
      inputSchema: {
        source: z.string().describe('source id, as listed by weaver_list_sources'),
      },
      annotations: { readOnlyHint: true, openWorldHint: false },
    },
    async ({ source }) => {
      const contract = findContract(deps, source);
      const run = await deps.store.latestRun(contract.id);

      if (run === undefined) {
        return text(`No runs recorded for ${contract.id}. Call weaver_collect first.`);
      }

      const findings = await deps.store.findingsForRun(run.id);
      const lines = [
        `${contract.name} — last run ${run.severity} at ${run.startedAt} (${run.mode}, ${String(run.rowCount)} rows).`,
      ];

      if (findings.length === 0) {
        lines.push('No contract violations. Nothing to heal.');
        return text(lines.join('\n'));
      }

      for (const finding of findings) {
        lines.push('');
        lines.push(`${finding.field ?? 'run'} — ${finding.code} (${finding.severity})`);
        lines.push(`  ${finding.message}`);
        lines.push(`  observed: ${finding.observed}`);
        lines.push(`  expected: ${finding.expected}`);
      }

      try {
        const statistics = computeRunStatistics(contract, await deps.store.rawPayload(run.id));
        const prompt = synthesizeHealPrompt({ contract, findings, statistics, attempt: 1 });
        lines.push('');
        lines.push('The heal prompt Weaver would send:');
        lines.push(prompt.text);
      } catch {
        lines.push('');
        lines.push(
          'Nothing here is healable: value shifts and unknown fields are reported but never ' +
            'sent to a code refactorer, because no code change would fix them.',
        );
      }

      return text(lines.join('\n'));
    },
  );

  server.registerTool(
    'weaver_heal',
    {
      title: 'Heal a source',
      description:
        'Run the verify-then-approve loop: synthesize a heal prompt, call bdata scraper heal, ' +
        'validate the returned preview against the same contract that detected the break, and ' +
        'approve only if it passes. Rejected fixes leave the collector untouched. ' +
        'Requires confirm: true, and refuses to run when the heal policy is "manual".',
      inputSchema: {
        source: z.string().describe('source id, as listed by weaver_list_sources'),
        confirm: z
          .boolean()
          .describe('must be true; this changes a live Bright Data collector and spends credits'),
        attempts: z.number().int().positive().max(5).optional(),
      },
      annotations: { readOnlyHint: false, destructiveHint: true, openWorldHint: true },
    },
    async ({ source, confirm, attempts }) => {
      const contract = findContract(deps, source);
      const policy = effectivePolicy(deps.env.healPolicy, contract.policy.heal);

      // An agent must not be able to change a production collector by inferring
      // that it would be helpful. Refusing here is the point of the tool.
      if (!confirm) {
        return text(
          `Refusing to heal ${contract.id} without confirm: true. This would send a prompt to ` +
            'Bright Data and may change the collector. Call weaver_diagnose to see the prompt first.',
        );
      }

      if (policy === 'manual') {
        return text(
          `The effective heal policy for ${contract.id} is "manual", so Weaver will not heal ` +
            'automatically. Change WEAVER_HEAL_POLICY or the contract policy to "gated" to allow it.',
        );
      }

      const outcome = await healSource(deps, {
        contract,
        policy,
        verifyMode: deps.env.mode,
        ...(attempts === undefined ? {} : { maxAttempts: attempts }),
      });

      const lines = [`${contract.name}: ${outcome.status}.`];
      for (const attempt of outcome.attempts) {
        lines.push('');
        lines.push(`Attempt ${String(attempt.attempt)} (${attempt.strategy}) — ${attempt.verdict}`);
        lines.push(`  prompt: ${attempt.prompt}`);
        lines.push(`  preview: ${String(attempt.previewRows)} row(s) — ${attempt.reason}`);
      }
      if (outcome.escalationUrl !== undefined) {
        lines.push('');
        lines.push(`Escalated to ${outcome.escalationUrl}`);
      }

      return text(lines.join('\n'));
    },
  );

  server.registerTool(
    'weaver_compare_prices',
    {
      title: 'Compare medicine prices',
      description:
        'Compare the latest collected prices across pharmacies for the same molecule, ' +
        'normalised to price per unit so different pack sizes are comparable. ' +
        'Read-only: it reads collected data and contacts nothing.',
      inputSchema: {
        molecule: z
          .string()
          .optional()
          .describe('filter by molecule or brand, for example "pantoprazole"'),
        limit: z.number().int().positive().max(50).optional(),
      },
      annotations: { readOnlyHint: true, openWorldHint: false },
    },
    async ({ molecule, limit }) => {
      const offers = readOffers(await deps.store.latestRowsPerSource());
      const all = compareByMolecule(offers);

      const needle = molecule?.trim().toLowerCase();
      const filtered =
        needle === undefined || needle === ''
          ? all
          : all.filter(
              (comparison) =>
                comparison.molecule.includes(needle) ||
                comparison.offers.some((offer) => offer.productName.toLowerCase().includes(needle)),
            );

      if (filtered.length === 0) {
        return text(
          offers.length === 0
            ? 'No collected rows yet. Call weaver_collect first.'
            : `No molecule available from more than one pharmacy matches "${molecule ?? ''}".`,
        );
      }

      const lines: string[] = [];
      for (const comparison of filtered.slice(0, limit ?? 10)) {
        lines.push('');
        lines.push(
          `${comparison.molecule} — cheapest at ${comparison.cheapest.sourceId}, ` +
            `saving ${String(comparison.savingsPct)}% per unit`,
        );
        for (const offer of comparison.offers) {
          lines.push(
            `  ${offer.sourceId.padEnd(16)} ${offer.currency} ${offer.pricePerUnit.toFixed(2)}/unit ` +
              `(${offer.currency} ${offer.sellingPrice.toFixed(2)} for ${String(offer.packCount)}, ` +
              `pack size ${offer.packSource}) — ${offer.productName}`,
          );
        }
      }

      return text(lines.join('\n').trim());
    },
  );

  return server;
}

export class UnknownSourceError extends Error {
  constructor(id: string, known: readonly string[]) {
    super(`unknown source "${id}". Known sources: ${known.join(', ')}`);
    this.name = 'UnknownSourceError';
  }
}

function findContract(deps: WeaverToolDeps, id: string): SourceContract {
  const contract = deps.contracts.find((candidate) => candidate.id === id);
  if (contract === undefined) {
    throw new UnknownSourceError(
      id,
      deps.contracts.map((candidate) => candidate.id),
    );
  }
  return contract;
}
