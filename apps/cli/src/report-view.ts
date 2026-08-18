/**
 * Rendering a run report for a terminal.
 *
 * The report is the product's main output, and for most of the demo it is the
 * only UI. So it gets the same care as a screen: severity is colour-coded, every
 * finding states the observed number next to the expectation, and field
 * statistics are shown as a fill-rate bar because a column of decimals is not
 * readable at a glance.
 */
import type { RunReport, Severity } from '@weaver/core';
import { glyph, heading, style, table } from './ui.js';

export function severityLabel(severity: Severity): string {
  switch (severity) {
    case 'ok':
      return `${glyph.ok} ${style.green('ok')}`;
    case 'degraded':
      return `${glyph.warn} ${style.yellow('degraded')}`;
    case 'broken':
      return `${glyph.fail} ${style.red('broken')}`;
  }
}

/** A fill-rate bar. Eight characters is enough to read, narrow enough to align. */
export function fillBar(rate: number, width = 8): string {
  const filled = Math.round(rate * width);
  const bar = '#'.repeat(filled) + style.dim('.'.repeat(width - filled));
  const colour = rate >= 0.9 ? style.green : rate >= 0.5 ? style.yellow : style.red;
  return colour(bar);
}

export function renderReport(report: RunReport, options: { explain: boolean }): string {
  const lines: string[] = [];

  lines.push(heading(`${report.sourceId}  ${severityLabel(report.severity)}`));
  lines.push(
    `  ${style.dim('rows')} ${String(report.statistics.rowCount)}   ` +
      `${style.dim('findings')} ${String(report.findings.length)}   ` +
      `${style.dim('baseline')} ${
        report.baselineRuns === 0
          ? style.dim('none yet')
          : `${String(report.baselineRuns)} healthy runs`
      }`,
  );

  if (report.findings.length > 0) {
    lines.push('');
    for (const finding of report.findings) {
      const scope = finding.field === null ? style.dim('(run)') : style.bold(finding.field);
      lines.push(`  ${severityGlyph(finding.severity)} ${scope}  ${finding.message}`);
      if (options.explain) {
        lines.push(`      ${style.dim('observed')}  ${finding.observed}`);
        lines.push(`      ${style.dim('expected')}  ${finding.expected}`);
        lines.push(`      ${style.dim('code')}      ${finding.code}`);
      }
    }
  }

  if (options.explain) {
    const rows = Object.values(report.statistics.fields).map((stats) => [
      stats.field,
      fillBar(stats.fillRate),
      `${Math.round(stats.fillRate * 100)}%`,
      String(stats.distinctCount),
      stats.invalidCount === 0 ? style.dim('0') : style.red(String(stats.invalidCount)),
      stats.numeric === undefined ? style.dim('-') : formatNumber(stats.numeric.median),
    ]);

    lines.push('');
    lines.push(table(['field', 'fill', '', 'distinct', 'invalid', 'median'], rows));
  }

  return lines.join('\n');
}

function severityGlyph(severity: Severity): string {
  switch (severity) {
    case 'ok':
      return glyph.ok;
    case 'degraded':
      return glyph.warn;
    case 'broken':
      return glyph.fail;
  }
}

function formatNumber(value: number): string {
  return Number.isInteger(value) ? String(value) : value.toFixed(2);
}
