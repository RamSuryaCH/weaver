#!/usr/bin/env -S npx tsx
/**
 * The `weaver` command line.
 *
 * Weaver is driven from a terminal or a coding agent rather than a dashboard,
 * so this is the primary interface and the dashboard is a read-only view over
 * the same data.
 */
import { Command } from 'commander';
import { loadDotEnv } from '@weaver/config';
import { runDoctor } from './commands/doctor.js';
import { style } from './ui.js';

loadDotEnv();

const program = new Command();

program
  .name('weaver')
  .description('A self-healing web data control plane built on Bright Data Scraper Studio')
  .version('0.1.0')
  .option('--sources-dir <path>', 'directory holding source contracts', 'sources');

program
  .command('doctor')
  .description('check the environment, the Bright Data CLI and every source contract')
  .action(() => {
    const { sourcesDir } = program.opts<{ sourcesDir: string }>();
    process.exitCode = runDoctor({ sourcesDir });
  });

program.configureOutput({
  outputError: (text, write) => write(style.red(text)),
});

await program.parseAsync(process.argv);
