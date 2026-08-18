/** Formatting helpers shared by every view. */

export function formatDuration(ms: number): string {
  if (ms < 1000) return `${String(ms)}ms`;
  const seconds = Math.round(ms / 1000);
  if (seconds < 90) return `${String(seconds)}s`;
  const minutes = Math.round(seconds / 60);
  return minutes < 90 ? `${String(minutes)}m` : `${String(Math.round(minutes / 60))}h`;
}

/** ISO timestamps, made readable without pulling in a date library. */
export function formatWhen(iso: string): string {
  return iso.replace('T', ' ').replace(/\.\d+Z$/, 'Z');
}

export function formatRupees(value: number): string {
  return `₹${value.toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}

export function formatPercent(value: number): string {
  return `${value.toFixed(1)}%`;
}

export function median(values: readonly number[]): number | undefined {
  if (values.length === 0) return undefined;
  const sorted = [...values].sort((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 1
    ? sorted[middle]
    : ((sorted[middle - 1] ?? 0) + (sorted[middle] ?? 0)) / 2;
}
