#!/usr/bin/env -S npx tsx
/**
 * stdio entry point for the Weaver MCP server.
 *
 * Registered with a coding agent by pointing it at this file; see
 * `docs/agent-integration.md`. Nothing is written to stdout except the MCP
 * protocol itself, because stdout *is* the transport — diagnostics go to stderr.
 */
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { loadDotEnv, loadSourceContracts, readEnv } from '@weaver/config';
import { BrightDataCollectionClient, ScraperStudioCli } from '@weaver/brightdata';
import { WeaverStore } from '@weaver/db';
import { FixtureStore } from '@weaver/engine';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { createWeaverServer } from './server.js';

loadDotEnv();

const env = readEnv();
const contracts = loadSourceContracts(process.env.WEAVER_SOURCES_DIR ?? 'sources');

mkdirSync(dirname(env.dbPath), { recursive: true });
const store = await WeaverStore.open(env.dbPath);

const apiKey = process.env.BRIGHTDATA_API_KEY;
const hasKey = apiKey !== undefined && apiKey.trim() !== '';

const server = createWeaverServer({
  env,
  contracts,
  store,
  fixtures: new FixtureStore(process.env.WEAVER_FIXTURES_DIR ?? 'fixtures'),
  collectionClient: hasKey ? new BrightDataCollectionClient({ apiKey }) : undefined,
  cli: new ScraperStudioCli(hasKey ? { apiKey } : {}),
  now: () => new Date(),
});

process.stderr.write(
  `weaver mcp: ${String(contracts.length)} sources, mode ${env.mode}, ` +
    `heal policy ${env.healPolicy}, bright data key ${hasKey ? 'present' : 'absent'}\n`,
);

await server.connect(new StdioServerTransport());

for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  process.on(signal, () => {
    store.close();
    process.exit(0);
  });
}
