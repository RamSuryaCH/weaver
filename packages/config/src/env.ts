/**
 * Environment settings.
 *
 * Everything that can differ between a judge's laptop, the maintainer's laptop
 * and CI lives here, parsed once and validated. Nothing else in Weaver reads
 * `process.env`, so there is exactly one place to look when a setting misbehaves.
 */
import { z } from 'zod';
import { HEAL_POLICIES } from '@weaver/core';
import { resolveFromRepoRoot } from './paths.js';

/**
 * `live` spends Bright Data credits by triggering real collectors.
 * `replay` reads recorded runs from `fixtures/`, spends nothing, and is the
 * default so that cloning the repo is enough to explore the whole product.
 */
export const RUN_MODES = ['live', 'replay'] as const;
export type RunMode = (typeof RUN_MODES)[number];

const envSchema = z.object({
  BRIGHTDATA_API_KEY: z.string().min(1).optional(),
  WEAVER_DB_PATH: z.string().min(1).default('data/weaver.db'),
  WEAVER_MODE: z.enum(RUN_MODES).default('replay'),
  WEAVER_HEAL_POLICY: z.enum(HEAL_POLICIES).default('gated'),
  WEAVER_ESCALATION_REPO: z
    .string()
    .regex(/^[\w.-]+\/[\w.-]+$/, 'expected "owner/name"')
    .optional(),
});

export interface WeaverEnv {
  readonly mode: RunMode;
  readonly dbPath: string;
  /** Repo-wide default; an individual source contract can be stricter. */
  readonly healPolicy: (typeof HEAL_POLICIES)[number];
  readonly escalationRepo: string | undefined;
  /**
   * Present rather than the key itself, so nothing downstream can accidentally
   * log a credential. The Bright Data client reads the key directly.
   */
  readonly hasApiKey: boolean;
}

/** Parse and validate the environment. Throws with a readable message on bad input. */
export function readEnv(source: NodeJS.ProcessEnv = process.env): WeaverEnv {
  const parsed = envSchema.parse({
    BRIGHTDATA_API_KEY: emptyToUndefined(source.BRIGHTDATA_API_KEY),
    WEAVER_DB_PATH: emptyToUndefined(source.WEAVER_DB_PATH),
    WEAVER_MODE: emptyToUndefined(source.WEAVER_MODE),
    WEAVER_HEAL_POLICY: emptyToUndefined(source.WEAVER_HEAL_POLICY),
    WEAVER_ESCALATION_REPO: emptyToUndefined(source.WEAVER_ESCALATION_REPO),
  });

  return {
    mode: parsed.WEAVER_MODE,
    // Resolved here so every entry point agrees on which file the database is,
    // whatever directory it was started from.
    dbPath: resolveFromRepoRoot(parsed.WEAVER_DB_PATH),
    healPolicy: parsed.WEAVER_HEAL_POLICY,
    escalationRepo: parsed.WEAVER_ESCALATION_REPO,
    hasApiKey: parsed.BRIGHTDATA_API_KEY !== undefined,
  };
}

/**
 * Treat an empty string as absent.
 *
 * A blank line in `.env` (`BRIGHTDATA_API_KEY=`) should mean "not set", not
 * "set to the empty string" — otherwise the friendly "run bdata login" error
 * turns into a confusing 401 from Bright Data.
 */
function emptyToUndefined(value: string | undefined): string | undefined {
  if (value === undefined) return undefined;
  const trimmed = value.trim();
  return trimmed === '' ? undefined : trimmed;
}
