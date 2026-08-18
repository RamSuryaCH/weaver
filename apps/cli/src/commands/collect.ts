/**
 * `weaver collect` — run collectors and judge what came back.
 *
 * The same command serves three modes. `--mode live` triggers the real collector
 * through the Collection API; `replay` reads the last recorded run; `chaos`
 * damages a recorded run on purpose. All three end in the same detection code.
 */
import type { ChaosMutation, ChaosOptions } from '@weaver/core';
import { collectSource } from '@weaver/engine';
import type { RunMode } from '@weaver/db';
import { openContext, selectContracts } from '../context.js';
import { renderReport, severityLabel } from '../report-view.js';
import { glyph, style } from '../ui.js';

export interface CollectCommandOptions {
  readonly sourcesDir: string;
  readonly fixturesDir?: string;
  readonly source?: string;
  readonly all?: boolean;
  readonly mode?: RunMode;
  readonly limit?: number;
  readonly explain?: boolean;
  readonly chaos?: {
    readonly mutation: ChaosMutation;
    readonly field?: string;
    readonly keep?: number;
    readonly factor?: number;
  };
}

export async function runCollect(options: CollectCommandOptions): Promise<number> {
  const context = await openContext({
    sourcesDir: options.sourcesDir,
    ...(options.fixturesDir === undefined ? {} : { fixturesDir: options.fixturesDir }),
    onEvent: (event) => {
      process.stdout.write(`  ${style.dim(event.kind.padEnd(18))}${event.message}\n`);
    },
  });

  try {
    const contracts = selectContracts(context.contracts, options);
    const mode: RunMode =
      options.chaos !== undefined ? 'chaos' : (options.mode ?? context.env.mode);

    let worst = 0;

    for (const contract of contracts) {
      process.stdout.write(`\n${style.bold(contract.name)} ${style.dim(`(${mode})`)}\n`);

      try {
        const outcome = await collectSource(context.deps, {
          contract,
          mode,
          ...(options.limit === undefined ? {} : { limit: options.limit }),
          ...(options.chaos === undefined ? {} : { chaos: toChaosOptions(options.chaos) }),
        });

        process.stdout.write(
          `${renderReport(outcome.report, { explain: options.explain === true })}\n`,
        );

        if (outcome.incidentId !== undefined && outcome.report.severity !== 'ok') {
          process.stdout.write(
            `\n  ${glyph.pending} incident ${style.dim(outcome.incidentId)} is open. ` +
              `Next: pnpm weaver heal --source ${contract.id}\n`,
          );
        }

        worst = Math.max(worst, outcome.report.severity === 'ok' ? 0 : 1);
      } catch (error) {
        // One hostile source must not stop the rest of the fleet.
        process.stdout.write(`  ${glyph.fail} ${style.red(describe(error))}\n`);
        worst = 2;
      }
    }

    return worst === 0 ? 0 : 1;
  } finally {
    context.close();
  }
}

function toChaosOptions(input: NonNullable<CollectCommandOptions['chaos']>): ChaosOptions {
  return {
    mutation: input.mutation,
    ...(input.field === undefined ? {} : { field: input.field }),
    ...(input.keep === undefined ? {} : { keep: input.keep }),
    ...(input.factor === undefined ? {} : { factor: input.factor }),
  };
}

/**
 * `weaver check` — what does the latest run for each source say?
 *
 * Reads the database rather than collecting, so it costs nothing and can be run
 * as often as you like.
 */
export async function runCheck(options: {
  readonly sourcesDir: string;
  readonly fixturesDir?: string;
  readonly source?: string;
  readonly explain?: boolean;
}): Promise<number> {
  const context = await openContext({ sourcesDir: options.sourcesDir });

  try {
    const contracts =
      options.source === undefined
        ? context.contracts
        : selectContracts(context.contracts, { source: options.source });

    let unhealthy = 0;

    for (const contract of contracts) {
      const run = await context.store.latestRun(contract.id);

      if (run === undefined) {
        process.stdout.write(
          `\n${style.bold(contract.name)}\n  ${glyph.info} no runs recorded yet. ` +
            `Next: pnpm weaver collect --source ${contract.id}\n`,
        );
        continue;
      }

      const findings = await context.store.findingsForRun(run.id);
      process.stdout.write(
        `\n${style.bold(contract.name)}  ${severityLabel(run.severity)}  ` +
          `${style.dim(`${run.rowCount} rows, ${run.mode}, ${run.startedAt}`)}\n`,
      );

      for (const finding of findings) {
        const scope = finding.field ?? '(run)';
        process.stdout.write(`  ${glyph.warn} ${style.bold(scope)}  ${finding.message}\n`);
        if (options.explain === true) {
          process.stdout.write(`      ${style.dim('observed')}  ${finding.observed}\n`);
          process.stdout.write(`      ${style.dim('expected')}  ${finding.expected}\n`);
        }
      }

      if (run.severity !== 'ok') unhealthy += 1;
    }

    process.stdout.write('\n');
    return unhealthy === 0 ? 0 : 1;
  } finally {
    context.close();
  }
}

function describe(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
