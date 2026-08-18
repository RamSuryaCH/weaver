#!/usr/bin/env -S npx tsx
/**
 * The `weaver` command line.
 *
 * Weaver is driven from a terminal or a coding agent rather than a dashboard, so
 * this is the primary interface and the dashboard is a read-only view over the
 * same database.
 */
import { Command, InvalidArgumentError } from 'commander';
import { loadDotEnv } from '@weaver/config';
import { CHAOS_MUTATIONS, describeMutation, type ChaosMutation } from '@weaver/core';
import { runCheck, runCollect } from './commands/collect.js';
import { runDemo } from './commands/demo.js';
import { runDoctor } from './commands/doctor.js';
import { runHeal } from './commands/heal.js';
import { style } from './ui.js';

loadDotEnv();

const program = new Command();

program
  .name('weaver')
  .description('A self-healing web data control plane built on Bright Data Scraper Studio')
  .version('0.1.0')
  .option('--sources-dir <path>', 'directory holding source contracts', 'sources')
  .option('--fixtures-dir <path>', 'directory holding recorded runs', 'fixtures');

function globals(): { sourcesDir: string; fixturesDir: string } {
  return program.opts<{ sourcesDir: string; fixturesDir: string }>();
}

program
  .command('doctor')
  .description('check the environment, the Bright Data CLI and every source contract')
  .action(() => {
    process.exitCode = runDoctor({ sourcesDir: globals().sourcesDir });
  });

program
  .command('collect')
  .description('run a collector, validate the result against the contract, and record it')
  .option('-s, --source <id>', 'source id from sources/')
  .option('-a, --all', 'every source')
  .addOption(
    new Command().createOption('-m, --mode <mode>', 'live or replay').choices(['live', 'replay']),
  )
  .option('-l, --limit <n>', 'use only the first n inputs', parsePositiveInteger)
  .option('-e, --explain', 'show per-field statistics and expectations')
  .action(async (options: Record<string, unknown>) => {
    process.exitCode = await runCollect({
      sourcesDir: globals().sourcesDir,
      fixturesDir: globals().fixturesDir,
      ...pickCommon(options),
      ...(typeof options.mode === 'string' ? { mode: options.mode as 'live' | 'replay' } : {}),
    });
  });

program
  .command('check')
  .description('report the latest recorded run for each source, without collecting')
  .option('-s, --source <id>', 'source id from sources/')
  .option('-e, --explain', 'show the observed and expected values for each finding')
  .action(async (options: Record<string, unknown>) => {
    process.exitCode = await runCheck({
      sourcesDir: globals().sourcesDir,
      fixturesDir: globals().fixturesDir,
      ...(typeof options.source === 'string' ? { source: options.source } : {}),
      ...(options.explain === true ? { explain: true } : {}),
    });
  });

program
  .command('heal')
  .description('diagnose the latest run, repair the collector, and verify the fix')
  .option('-s, --source <id>', 'source id from sources/')
  .option('-a, --all', 'every source')
  .option('-d, --dry-run', 'print the prompt Weaver would send and stop')
  .option('-n, --attempts <n>', 'override the contract heal budget', parsePositiveInteger)
  .option('--no-verify', 'skip the post-approval re-collection')
  .action(async (options: Record<string, unknown>) => {
    process.exitCode = await runHeal({
      sourcesDir: globals().sourcesDir,
      fixturesDir: globals().fixturesDir,
      ...(typeof options.source === 'string' ? { source: options.source } : {}),
      ...(options.all === true ? { all: true } : {}),
      ...(options.dryRun === true ? { dryRun: true } : {}),
      ...(typeof options.attempts === 'number' ? { attempts: options.attempts } : {}),
      ...(options.verify === false ? { noVerify: true } : {}),
    });
  });

program
  .command('demo')
  .description('replay every recorded run, then break one source, so the dashboard has a story')
  .option('--clean-only', 'replay without breaking anything')
  .action(async (options: Record<string, unknown>) => {
    process.exitCode = await runDemo({
      sourcesDir: globals().sourcesDir,
      fixturesDir: globals().fixturesDir,
      ...(options.cleanOnly === true ? { cleanOnly: true } : {}),
    });
  });

program
  .command('chaos')
  .description('damage a recorded run on purpose and watch detection catch it')
  .option('-s, --source <id>', 'source id from sources/')
  .option('-a, --all', 'every source')
  .requiredOption('-x, --mutation <name>', `one of: ${CHAOS_MUTATIONS.join(', ')}`, parseMutation)
  .option('-f, --field <name>', 'field to damage')
  .option('-k, --keep <n>', 'rows to keep for truncate-rows', parsePositiveInteger)
  .option('--factor <n>', 'multiplier for rescale-field', Number)
  .option('-e, --explain', 'show per-field statistics and expectations')
  .addHelpText(
    'after',
    `\nMutations:\n${CHAOS_MUTATIONS.map(
      (mutation) => `  ${mutation.padEnd(17)}${describeMutation(mutation)}`,
    ).join('\n')}\n`,
  )
  .action(async (options: Record<string, unknown>) => {
    process.exitCode = await runCollect({
      sourcesDir: globals().sourcesDir,
      fixturesDir: globals().fixturesDir,
      ...pickCommon(options),
      chaos: {
        mutation: options.mutation as ChaosMutation,
        ...(typeof options.field === 'string' ? { field: options.field } : {}),
        ...(typeof options.keep === 'number' ? { keep: options.keep } : {}),
        ...(typeof options.factor === 'number' ? { factor: options.factor } : {}),
      },
    });
  });

function pickCommon(options: Record<string, unknown>): {
  source?: string;
  all?: boolean;
  limit?: number;
  explain?: boolean;
} {
  return {
    ...(typeof options.source === 'string' ? { source: options.source } : {}),
    ...(options.all === true ? { all: true } : {}),
    ...(typeof options.limit === 'number' ? { limit: options.limit } : {}),
    ...(options.explain === true ? { explain: true } : {}),
  };
}

function parsePositiveInteger(value: string): number {
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed <= 0) {
    throw new InvalidArgumentError('expected a positive integer');
  }
  return parsed;
}

function parseMutation(value: string): ChaosMutation {
  if (!(CHAOS_MUTATIONS as readonly string[]).includes(value)) {
    throw new InvalidArgumentError(`expected one of: ${CHAOS_MUTATIONS.join(', ')}`);
  }
  return value as ChaosMutation;
}

program.configureOutput({
  outputError: (text, write) => write(style.red(text)),
});

try {
  await program.parseAsync(process.argv);
} catch (error) {
  process.stderr.write(`${style.red(error instanceof Error ? error.message : String(error))}\n`);
  process.exitCode = 1;
}
