/**
 * `weaver demo` — make a fresh clone interesting in one command.
 *
 * A judge should not have to run four commands in the right order to see a real
 * incident. This replays every committed fixture, then damages one source on
 * purpose so the dashboard has something to show: a healthy fleet with one
 * failure in it, which is what the product is actually for.
 *
 * It spends nothing. Everything here reads `fixtures/`, which holds the payloads
 * the collectors really returned.
 */
import { collectSource } from '@weaver/engine';
import { openContext } from '../context.js';
import { glyph, style } from '../ui.js';

export interface DemoOptions {
  readonly sourcesDir: string;
  readonly fixturesDir?: string;
  /** Skip the deliberate breakage and just replay what was recorded. */
  readonly cleanOnly?: boolean;
}

export async function runDemo(options: DemoOptions): Promise<number> {
  const context = await openContext({
    sourcesDir: options.sourcesDir,
    ...(options.fixturesDir === undefined ? {} : { fixturesDir: options.fixturesDir }),
  });

  try {
    const replayable = context.contracts.filter((contract) =>
      context.deps.fixtures.has(contract.id),
    );

    if (replayable.length === 0) {
      process.stdout.write(
        `  ${glyph.fail} no recorded runs in fixtures/. Nothing to demo.\n` +
          `  ${style.dim('Collect once in live mode first: pnpm weaver collect --all --mode live')}\n`,
      );
      return 1;
    }

    process.stdout.write(
      `\n${style.bold('Replaying recorded runs')} ${style.dim('(no credits, no network)')}\n`,
    );

    // Three passes so drift detection has a baseline to compare against: the
    // engine will not judge a run against history until it has three healthy runs.
    const severities = new Map<string, string>();
    for (let pass = 1; pass <= 3; pass += 1) {
      for (const contract of replayable) {
        const outcome = await collectSource(context.deps, { contract, mode: 'replay' });
        if (pass === 3) {
          severities.set(contract.id, outcome.report.severity);
          process.stdout.write(
            `  ${outcome.report.severity === 'ok' ? glyph.ok : glyph.warn} ` +
              `${contract.name.padEnd(24)}${String(outcome.report.statistics.rowCount)} rows, ` +
              `${outcome.report.severity}\n`,
          );
        }
      }
    }

    let broke: string | undefined;

    if (options.cleanOnly !== true) {
      // Break the healthiest source. Damaging one that is already broken would
      // teach the viewer nothing, and the claim about the fill rate would be false.
      const victim = [...replayable].sort(
        (a, b) => rank(severities.get(a.id)) - rank(severities.get(b.id)),
      )[0];

      if (victim !== undefined) {
        broke = victim.id;
        const field = pickBreakableField(victim.schema.map((entry) => entry.field));

        process.stdout.write(
          `\n${style.bold('Breaking one source on purpose')} ` +
            `${style.dim(`(${victim.name}, ${field})`)}\n`,
        );

        const broken = await collectSource(context.deps, {
          contract: victim,
          mode: 'chaos',
          chaos: { mutation: 'constant-field', field },
        });

        // Quote the finding this mutation actually caused, not whichever finding
        // happens to come first — the source may have had problems already.
        const caused =
          broken.report.findings.find(
            (finding) => finding.code === 'constant_value' && finding.field === field,
          ) ?? broken.report.findings[0];

        process.stdout.write(
          `  ${glyph.fail} ${broken.report.severity}: ${caused?.message ?? ''}\n`,
        );

        const stats = broken.report.statistics.fields[field];
        if (stats !== undefined && stats.fillRate === 1) {
          process.stdout.write(
            `  ${style.dim(`Note "${field}" is still present in 100% of rows. That is the failure no uptime check sees.`)}\n`,
          );
        }
      }
    }

    process.stdout.write(
      `\n${glyph.info} ready. Next:\n` +
        `      ${style.dim('pnpm dev')}                     the dashboard at http://localhost:4321\n` +
        `      ${style.dim('pnpm weaver check --explain')}  the same verdicts in the terminal\n` +
        `      ${style.dim('pnpm weaver heal --source ' + (broke ?? replayable[0]?.id ?? '') + ' --dry-run')}  the repair prompt\n\n`,
    );

    return 0;
  } finally {
    context.close();
  }
}

/**
 * Choose a field whose constancy is obviously wrong.
 *
 * A price that is identical on every product is the clearest demonstration; a
 * currency code legitimately is constant, so it must never be chosen.
 */
function pickBreakableField(fields: readonly string[]): string {
  const preferred = ['selling_price', 'mrp', 'composition', 'product_name'];
  return preferred.find((candidate) => fields.includes(candidate)) ?? fields[0] ?? 'unknown';
}

/** Order severities so the healthiest source sorts first. */
function rank(severity: string | undefined): number {
  if (severity === 'ok') return 0;
  if (severity === 'degraded') return 1;
  return 2;
}
