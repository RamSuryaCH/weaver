/**
 * Locating the repository root.
 *
 * Weaver is one repo with several entry points — the CLI, the MCP server, the
 * Next dev server, vitest — and they do not share a working directory. The Next
 * dev server runs in `apps/web`, so a relative `sources/` would resolve to
 * `apps/web/sources` and find nothing.
 *
 * Rather than making every caller pass absolute paths, the root is found once by
 * walking up for the workspace marker. Relative paths in configuration are then
 * always relative to the repo, which is what someone writing `sources/` in a
 * `.env` file means.
 */
import { existsSync } from 'node:fs';
import { dirname, isAbsolute, join, resolve } from 'node:path';

const WORKSPACE_MARKER = 'pnpm-workspace.yaml';

/** Walk up from `start` until the workspace marker is found. */
export function findRepoRoot(start: string = process.cwd()): string {
  let current = resolve(start);

  for (;;) {
    if (existsSync(join(current, WORKSPACE_MARKER))) return current;
    const parent = dirname(current);
    // At the filesystem root there is nowhere left to look; fall back to the
    // starting directory so behaviour stays predictable rather than throwing.
    if (parent === current) return resolve(start);
    current = parent;
  }
}

/** Resolve a possibly-relative configured path against the repo root. */
export function resolveFromRepoRoot(path: string, start?: string): string {
  return isAbsolute(path) ? path : join(findRepoRoot(start), path);
}
