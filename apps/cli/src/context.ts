/**
 * Wiring: turn environment settings into the objects a command needs.
 *
 * Every command opens its own context and closes it, so nothing is shared
 * globally and a failure in one source cannot poison another.
 */
import { loadSourceContracts, readEnv, type WeaverEnv } from '@weaver/config';
import type { SourceContract } from '@weaver/core';
import { BrightDataCollectionClient, ScraperStudioCli } from '@weaver/brightdata';
import { WeaverStore } from '@weaver/db';
import { FixtureStore, type EngineDeps, type EngineEvent } from '@weaver/engine';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';

export interface CommandContext {
  readonly env: WeaverEnv;
  readonly contracts: readonly SourceContract[];
  readonly store: WeaverStore;
  readonly deps: EngineDeps;
  readonly cli: ScraperStudioCli;
  close(): void;
}

export interface ContextOptions {
  readonly sourcesDir: string;
  readonly fixturesDir?: string;
  readonly onEvent?: (event: EngineEvent) => void;
}

export async function openContext(options: ContextOptions): Promise<CommandContext> {
  const env = readEnv();
  const contracts = loadSourceContracts(options.sourcesDir);

  mkdirSync(dirname(env.dbPath), { recursive: true });
  const store = await WeaverStore.open(env.dbPath);
  const fixtures = new FixtureStore(options.fixturesDir ?? 'fixtures');

  const apiKey = process.env.BRIGHTDATA_API_KEY;
  // The client is only constructed when a key exists. Replay mode must work on a
  // machine that has never heard of Bright Data.
  const collectionClient =
    apiKey === undefined || apiKey.trim() === ''
      ? undefined
      : new BrightDataCollectionClient({ apiKey });

  const deps: EngineDeps = {
    store,
    fixtures,
    collectionClient,
    now: () => new Date(),
    ...(options.onEvent === undefined ? {} : { log: options.onEvent }),
  };

  return {
    env,
    contracts,
    store,
    deps,
    cli: new ScraperStudioCli(apiKey === undefined ? {} : { apiKey }),
    close: () => store.close(),
  };
}

/** Resolve `--source <id>` / `--all` into the contracts to act on. */
export function selectContracts(
  contracts: readonly SourceContract[],
  options: { readonly source?: string; readonly all?: boolean },
): readonly SourceContract[] {
  if (options.all === true) return contracts;

  if (options.source === undefined) {
    throw new Error(
      `choose a source with --source <id>, or --all. Available: ${contracts
        .map((contract) => contract.id)
        .join(', ')}`,
    );
  }

  const found = contracts.find((contract) => contract.id === options.source);
  if (found === undefined) {
    throw new Error(
      `unknown source "${options.source}". Available: ${contracts
        .map((contract) => contract.id)
        .join(', ')}`,
    );
  }
  return [found];
}
