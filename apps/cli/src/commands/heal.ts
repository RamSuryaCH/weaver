/**
 * `weaver heal` — diagnose the latest run and repair the collector.
 *
 * The output is written to be watched. Each attempt shows the prompt that was
 * sent, how many preview rows came back, and the reason the gate approved or
 * rejected it, because that reasoning is the whole point of the command.
 */
import { effectivePolicy, healSource, type HealOutcome } from '@weaver/engine';
import { openContext, selectContracts } from '../context.js';
import { createGithubEscalation } from '../escalate.js';
import { glyph, style } from '../ui.js';

export interface HealCommandOptions {
  readonly sourcesDir: string;
  readonly fixturesDir?: string;
  readonly source?: string;
  readonly all?: boolean;
  readonly dryRun?: boolean;
  readonly attempts?: number;
  /** Skip the post-approval re-collection. Useful when out of credits. */
  readonly noVerify?: boolean;
}

export async function runHeal(options: HealCommandOptions): Promise<number> {
  const context = await openContext({
    sourcesDir: options.sourcesDir,
    ...(options.fixturesDir === undefined ? {} : { fixturesDir: options.fixturesDir }),
    onEvent: (event) => {
      process.stdout.write(`  ${style.dim(event.kind.padEnd(18))}${event.message}\n`);
    },
  });

  try {
    const contracts = selectContracts(context.contracts, options);
    const escalate = createGithubEscalation({ repo: context.env.escalationRepo });
    let failed = 0;

    for (const contract of contracts) {
      const policy = effectivePolicy(context.env.healPolicy, contract.policy.heal);

      process.stdout.write(`\n${style.bold(contract.name)} ${style.dim(`(policy: ${policy})`)}\n`);

      try {
        const outcome = await healSource(
          {
            ...context.deps,
            cli: context.cli,
            ...(escalate === undefined ? {} : { escalate }),
          },
          {
            contract,
            policy,
            ...(options.dryRun === true ? { dryRun: true } : {}),
            ...(options.attempts === undefined ? {} : { maxAttempts: options.attempts }),
            ...(options.noVerify === true ? { verify: false } : {}),
          },
        );

        process.stdout.write(render(outcome));
        if (outcome.status === 'exhausted' || outcome.status === 'approved_but_unverified') {
          failed += 1;
        }
      } catch (error) {
        process.stdout.write(`  ${glyph.fail} ${style.red(describe(error))}\n`);
        failed += 1;
      }
    }

    return failed === 0 ? 0 : 1;
  } finally {
    context.close();
  }
}

function render(outcome: HealOutcome): string {
  const lines: string[] = [];

  switch (outcome.status) {
    case 'not_needed':
      lines.push(`  ${glyph.ok} the latest run is healthy; nothing to heal.`);
      break;

    case 'policy_manual':
      lines.push(
        `  ${glyph.info} policy is manual, so nothing was sent. ` +
          `Use --dry-run to see the prompt Weaver would write.`,
      );
      break;

    case 'dry_run':
      lines.push(`  ${glyph.info} this is the prompt Weaver would send, and nothing was spent:\n`);
      lines.push(indent(outcome.prompt ?? '', 6));
      lines.push('');
      lines.push(
        `  ${style.dim(`${String((outcome.prompt ?? '').length)} of 1000 characters allowed by the CLI`)}`,
      );
      break;

    case 'healed':
    case 'approved_but_unverified':
    case 'exhausted':
      for (const attempt of outcome.attempts) {
        const verdict =
          attempt.verdict === 'approved'
            ? `${glyph.ok} ${style.green('approved')}`
            : `${glyph.fail} ${style.red('rejected')}`;

        lines.push('');
        lines.push(
          `  ${style.bold(`attempt ${String(attempt.attempt)}`)} ` +
            `${style.dim(attempt.strategy)}  ${verdict}`,
        );
        lines.push(indent(attempt.prompt, 6));
        lines.push(
          `      ${style.dim('preview')}  ${String(attempt.previewRows)} row(s) — ${attempt.reason}`,
        );
      }

      lines.push('');
      lines.push(`  ${statusLine(outcome)}`);
      if (outcome.escalationUrl !== undefined) {
        lines.push(`  ${glyph.warn} escalated to ${style.underline(outcome.escalationUrl)}`);
      }
  }

  return `${lines.join('\n')}\n`;
}

function statusLine(outcome: HealOutcome): string {
  switch (outcome.status) {
    case 'healed':
      return `${glyph.ok} ${style.green('healed')} — the re-run satisfies the contract and the incident is closed.`;
    case 'approved_but_unverified':
      return `${glyph.warn} ${style.yellow('approved, but the re-run still fails')} — an approved fix that does not satisfy the contract is not a fix.`;
    case 'exhausted':
      return `${glyph.fail} ${style.red('heal budget exhausted')} — the collector is unchanged; every proposed fix was rejected.`;
    case 'not_needed':
    case 'dry_run':
    case 'policy_manual':
      return `${glyph.info} ${outcome.status}`;
  }
}

function indent(text: string, spaces: number): string {
  const pad = ' '.repeat(spaces);
  return text
    .split('\n')
    .map((line) => style.dim(`${pad}${line}`))
    .join('\n');
}

function describe(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
