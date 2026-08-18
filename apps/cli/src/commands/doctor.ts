/**
 * `weaver doctor` — answer "is this checkout ready to do anything?" in one screen.
 *
 * It exists because the failure modes at the start of a session are boring and
 * repetitive: no API key, a contract with a typo, a source whose scraper has
 * not been created yet. Each of those gets a specific next action rather than a
 * stack trace.
 */
import { execFileSync } from 'node:child_process';
import { loadSourceContracts, readEnv } from '@weaver/config';
import type { SourceContract } from '@weaver/core';
import { glyph, heading, keyValue, style, table } from '../ui.js';

interface DoctorOptions {
  readonly sourcesDir: string;
}

export function runDoctor(options: DoctorOptions): number {
  const env = readEnv();

  const lines: string[] = [];
  lines.push(heading('Environment'));
  lines.push(keyValue('node', process.version));
  lines.push(keyValue('mode', describeMode(env.mode)));
  lines.push(keyValue('database', env.dbPath));
  lines.push(keyValue('heal policy', describeHealPolicy(env.healPolicy)));
  lines.push(
    keyValue(
      'brightdata key',
      env.hasApiKey
        ? `${glyph.ok} present in environment`
        : `${glyph.warn} ${style.yellow('not set')} ${style.dim('(needed only for live mode)')}`,
    ),
  );
  lines.push(
    keyValue('escalation repo', env.escalationRepo ?? style.dim('not set (incidents stay local)')),
  );

  lines.push(heading('Bright Data CLI'));
  const cliVersion = detectBdataVersion();
  lines.push(
    keyValue(
      'bdata',
      cliVersion === null
        ? `${glyph.warn} ${style.yellow('not reachable')} ${style.dim('(npx -p @brightdata/cli bdata)')}`
        : `${glyph.ok} ${cliVersion} ${style.dim('via npx')}`,
    ),
  );

  let contracts: readonly SourceContract[];
  try {
    contracts = loadSourceContracts(options.sourcesDir);
  } catch (error) {
    lines.push(heading('Source contracts'));
    lines.push(`  ${glyph.fail} ${style.red(describeError(error))}`);
    process.stdout.write(`${lines.join('\n')}\n\n`);
    return 1;
  }

  lines.push(heading(`Source contracts (${contracts.length})`));
  lines.push(
    table(
      ['source', 'type', 'collector', 'fields', 'inputs'],
      contracts.map((contract) => [
        contract.name,
        contract.type,
        contract.collectorId === null
          ? `${glyph.warn} ${style.yellow('not created')}`
          : `${glyph.ok} ${contract.collectorId}`,
        String(contract.schema.length),
        String(countInputs(contract)),
      ]),
    ),
  );

  const missing = contracts.filter((contract) => contract.collectorId === null);
  lines.push(heading('Verdict'));

  if (contracts.length === 0) {
    lines.push(`  ${glyph.fail} no contracts found in ${options.sourcesDir}/`);
  } else if (missing.length > 0) {
    lines.push(
      `  ${glyph.warn} ${missing.length} of ${contracts.length} sources have no collector yet.`,
    );
    lines.push(`  ${style.dim('Next:')} pnpm weaver create --source ${missing[0]?.id ?? ''}`);
  } else {
    lines.push(`  ${glyph.ok} every source has a collector; ready to collect.`);
    lines.push(`  ${style.dim('Next:')} pnpm weaver collect --all`);
  }

  if (!env.hasApiKey) {
    lines.push('');
    lines.push(`  ${glyph.info} live mode needs a Bright Data key. Either:`);
    lines.push(`      ${style.dim('a)')} copy .env.example to .env and set BRIGHTDATA_API_KEY`);
    lines.push(`      ${style.dim('b)')} run: npx -p @brightdata/cli bdata login`);
    lines.push(`      ${style.dim('The key is at https://brightdata.com/cp/setting')}`);
  }

  process.stdout.write(`${lines.join('\n')}\n\n`);
  return contracts.length === 0 ? 1 : 0;
}

function describeMode(mode: string): string {
  return mode === 'live'
    ? `${style.yellow('live')} ${style.dim('(spends Bright Data credits)')}`
    : `${style.green('replay')} ${style.dim('(reads fixtures, spends nothing)')}`;
}

function describeHealPolicy(policy: string): string {
  switch (policy) {
    case 'manual':
      return `${policy} ${style.dim('(report only, never heal)')}`;
    case 'gated':
      return `${policy} ${style.dim('(heal, approve only if the preview passes the contract)')}`;
    case 'auto':
      return `${style.yellow(policy)} ${style.dim('(approve without the contract gate)')}`;
    default:
      return policy;
  }
}

function countInputs(contract: SourceContract): number {
  const { urls = [], keywords = [], sitemaps = [] } = contract.inputs;
  return urls.length + keywords.length + sitemaps.length;
}

/** Probe the Bright Data CLI without failing the command if it is absent. */
function detectBdataVersion(): string | null {
  try {
    return (
      execFileSync('npx', ['-y', '-p', '@brightdata/cli', 'bdata', '--version'], {
        encoding: 'utf8',
        timeout: 60_000,
        stdio: ['ignore', 'pipe', 'ignore'],
      })
        .trim()
        .split('\n')
        .at(-1) ?? null
    );
  } catch {
    return null;
  }
}

function describeError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
