/**
 * Reads source contracts from `sources/*.yaml`.
 *
 * `@weaver/core` deliberately knows nothing about files, so this module is the
 * bridge: YAML text in, validated `SourceContract` out. Parse errors are
 * re-thrown with the filename attached, because a stack trace pointing at zod
 * is useless when you have a typo in a config file.
 */
import { readdirSync, readFileSync } from 'node:fs';
import { basename, join } from 'node:path';
import { resolveFromRepoRoot } from './paths.js';
import { parse as parseYaml } from 'yaml';
import { parseSourceContract, type SourceContract } from '@weaver/core';

export const DEFAULT_SOURCES_DIR = 'sources';

export class ContractLoadError extends Error {
  constructor(
    readonly file: string,
    override readonly cause: unknown,
  ) {
    super(`failed to load source contract "${file}": ${describe(cause)}`);
    this.name = 'ContractLoadError';
  }
}

/** Parse one contract from YAML text. Pure, so it is trivial to test. */
export function parseContractYaml(yamlText: string, fileLabel: string): SourceContract {
  try {
    return parseSourceContract(parseYaml(yamlText));
  } catch (error) {
    throw new ContractLoadError(fileLabel, error);
  }
}

/** Load one contract from disk. */
export function loadSourceContract(filePath: string): SourceContract {
  const absolute = resolveFromRepoRoot(filePath);
  return parseContractYaml(readFileSync(absolute, 'utf8'), basename(absolute));
}

/**
 * Load every contract in a directory, sorted by id for stable output.
 *
 * A single malformed file fails the whole load on purpose: Weaver's job is to
 * notice when data is wrong, so silently skipping a broken contract would be
 * the exact opposite of the point.
 */
export function loadSourceContracts(dir: string = DEFAULT_SOURCES_DIR): readonly SourceContract[] {
  const absoluteDir = resolveFromRepoRoot(dir);
  const files = readdirSync(absoluteDir)
    .filter((name) => name.endsWith('.yaml') || name.endsWith('.yml'))
    .sort();

  const contracts = files.map((name) => loadSourceContract(join(absoluteDir, name)));

  const ids = new Set<string>();
  for (const contract of contracts) {
    if (ids.has(contract.id)) {
      throw new Error(`duplicate source id "${contract.id}" across files in ${dir}`);
    }
    ids.add(contract.id);
  }

  return contracts.sort((a, b) => a.id.localeCompare(b.id));
}

function describe(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
