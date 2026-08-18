/**
 * Recorded runs on disk.
 *
 * Every live collection is written here, which buys three things at once:
 * replay mode for anyone without a Bright Data account, a corpus for the chaos
 * harness to damage, and the "example structured output" the hackathon asks
 * submissions to include. One file, three jobs.
 */
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { resolveFromRepoRoot } from '@weaver/config';

export interface FixtureRecord {
  readonly sourceId: string;
  readonly collectorId: string | null;
  readonly collectedAt: string;
  readonly rows: readonly unknown[];
}

export class FixtureNotFoundError extends Error {
  constructor(readonly sourceId: string) {
    super(
      `no recorded run for source "${sourceId}". ` +
        'Replay mode reads fixtures/, so either collect once in live mode ' +
        '(WEAVER_MODE=live) or check out the committed fixtures.',
    );
    this.name = 'FixtureNotFoundError';
  }
}

export class FixtureStore {
  constructor(private readonly root: string = 'fixtures') {}

  /** Write a payload, named by timestamp so history is preserved. */
  record(record: FixtureRecord): string {
    const dir = join(resolveFromRepoRoot(this.root), record.sourceId);
    mkdirSync(dir, { recursive: true });

    const stamp = record.collectedAt.replace(/[:.]/g, '-');
    const path = join(dir, `${stamp}.json`);
    writeFileSync(path, `${JSON.stringify(record, null, 2)}\n`, 'utf8');
    return path;
  }

  /** The newest recorded run for a source. */
  latest(sourceId: string): FixtureRecord {
    const files = this.list(sourceId);
    const newest = files.at(-1);
    if (newest === undefined) throw new FixtureNotFoundError(sourceId);

    const parsed: unknown = JSON.parse(readFileSync(newest, 'utf8'));
    if (!isFixtureRecord(parsed)) {
      throw new Error(`fixture ${newest} is not a recorded run`);
    }
    return parsed;
  }

  /** Every recorded run for a source, oldest first. */
  list(sourceId: string): readonly string[] {
    const dir = join(resolveFromRepoRoot(this.root), sourceId);
    if (!existsSync(dir)) return [];

    return readdirSync(dir)
      .filter((name) => name.endsWith('.json'))
      .sort()
      .map((name) => join(dir, name));
  }

  has(sourceId: string): boolean {
    return this.list(sourceId).length > 0;
  }
}

function isFixtureRecord(value: unknown): value is FixtureRecord {
  if (typeof value !== 'object' || value === null) return false;
  const record = value as Record<string, unknown>;
  return typeof record.sourceId === 'string' && Array.isArray(record.rows);
}
