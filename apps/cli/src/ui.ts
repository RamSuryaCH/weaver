/**
 * Terminal presentation.
 *
 * Bright Data's guidance for this workflow is that the terminal is the UI, so
 * Weaver's output is treated as a designed surface rather than debug spew:
 * aligned columns, one accent colour per severity, and no emoji. Colour is
 * suppressed when stdout is not a TTY or when NO_COLOR is set, so piping to a
 * file or a CI log produces clean text.
 */
const useColor = process.stdout.isTTY === true && process.env.NO_COLOR === undefined;

function wrap(open: string, close: string) {
  return (text: string): string => (useColor ? `${open}${text}${close}` : text);
}

export const style = {
  bold: wrap('\u001B[1m', '\u001B[22m'),
  dim: wrap('\u001B[2m', '\u001B[22m'),
  red: wrap('\u001B[31m', '\u001B[39m'),
  green: wrap('\u001B[32m', '\u001B[39m'),
  yellow: wrap('\u001B[33m', '\u001B[39m'),
  blue: wrap('\u001B[34m', '\u001B[39m'),
  underline: wrap('\u001B[4m', '\u001B[24m'),
};

/** Status glyphs. Deliberately ASCII-safe so they render in any terminal or log. */
export const glyph = {
  ok: style.green('+'),
  warn: style.yellow('!'),
  fail: style.red('x'),
  info: style.dim('-'),
  pending: style.blue('~'),
};

export function heading(text: string): string {
  return `\n${style.bold(text)}\n${style.dim('-'.repeat(Math.max(text.length, 12)))}`;
}

export function keyValue(key: string, value: string, keyWidth = 18): string {
  return `  ${style.dim(key.padEnd(keyWidth))}${value}`;
}

/**
 * Render a table with columns sized to their content.
 *
 * Kept local rather than pulling in a table dependency: the requirement is one
 * header row and left-aligned cells, which is twenty lines of code.
 */
export function table(headers: readonly string[], rows: readonly (readonly string[])[]): string {
  const widths = headers.map((header, index) =>
    Math.max(visibleLength(header), ...rows.map((row) => visibleLength(row[index] ?? ''))),
  );

  const renderRow = (cells: readonly string[]): string =>
    '  ' +
    cells
      .map((cell, index) => pad(cell, widths[index] ?? 0))
      .join(style.dim(' | '))
      .trimEnd();

  const separator =
    '  ' + widths.map((width) => style.dim('-'.repeat(width))).join(style.dim('-+-'));

  return [
    renderRow(headers.map((header) => style.dim(header))),
    separator,
    ...rows.map(renderRow),
  ].join('\n');
}

/** Length ignoring ANSI escapes, so coloured cells still line up. */
function visibleLength(text: string): number {
  return stripAnsi(text).length;
}

function pad(text: string, width: number): string {
  return text + ' '.repeat(Math.max(0, width - visibleLength(text)));
}

export function stripAnsi(text: string): string {
  // eslint-disable-next-line no-control-regex
  return text.replace(/\u001B\[[0-9;]*m/g, '');
}

/**
 * Mask a credential for display. Weaver never prints a full key, not in logs,
 * not in `doctor` output, and therefore not in a screen recording either.
 */
export function maskSecret(secret: string): string {
  if (secret.length <= 8) return '*'.repeat(secret.length);
  return `${secret.slice(0, 4)}${'*'.repeat(secret.length - 8)}${secret.slice(-4)}`;
}
