/**
 * Escalation: when automated healing gives up, a human inherits a described
 * problem rather than a silent gap.
 *
 * The issue body is deliberately complete — every prompt tried, every reason a
 * preview was rejected — because the person reading it at 9am was not watching
 * at 3am when the cron gave up.
 */
import { execFile } from 'node:child_process';
import type { EscalationInput } from '@weaver/engine';

export interface EscalateOptions {
  /** "owner/name". When absent, escalation is recorded locally only. */
  readonly repo: string | undefined;
}

export function createGithubEscalation(
  options: EscalateOptions,
): ((input: EscalationInput) => Promise<string | undefined>) | undefined {
  if (options.repo === undefined) return undefined;
  const repo = options.repo;

  return async (input: EscalationInput): Promise<string | undefined> => {
    const title = `${input.contract.name}: automated healing failed after ${input.attempts.length} attempt(s)`;
    const body = renderIssueBody(input);

    try {
      return await runGh([
        'issue',
        'create',
        '--repo',
        repo,
        '--title',
        title,
        '--label',
        'drift',
        '--label',
        'escalation',
        '--label',
        'ready-for-human',
        '--body',
        body,
      ]);
    } catch {
      // Escalation is best-effort: failing to file an issue must not mask the
      // original data problem, which is already recorded in the incident.
      return undefined;
    }
  };
}

export function renderIssueBody(input: EscalationInput): string {
  const lines: string[] = [];

  lines.push(`Weaver detected a contract violation on **${input.contract.name}** and could not`);
  lines.push('repair it within its heal budget. The collector is unchanged: every rejected fix');
  lines.push('was rolled back with `bdata scraper approve --reject`.');
  lines.push('');
  lines.push(`- Source: \`${input.contract.id}\``);
  lines.push(`- Collector: \`${input.contract.collectorId ?? 'none'}\``);
  lines.push(`- Incident: \`${input.incidentId}\``);
  lines.push('');
  lines.push('## What broke');
  lines.push('');
  for (const finding of input.findings) {
    lines.push(`- **${finding.field ?? 'run'}** (${finding.code}): ${finding.message}`);
    lines.push(`  - observed: ${finding.observed}`);
    lines.push(`  - expected: ${finding.expected}`);
  }

  lines.push('');
  lines.push('## What was tried');
  lines.push('');
  for (const attempt of input.attempts) {
    lines.push(`### Attempt ${attempt.attempt} — ${attempt.strategy} — ${attempt.verdict}`);
    lines.push('');
    lines.push('Prompt sent to `bdata scraper heal`:');
    lines.push('');
    lines.push('```text');
    lines.push(attempt.prompt);
    lines.push('```');
    lines.push('');
    lines.push(`Preview returned ${attempt.previewRows} row(s). Verdict: ${attempt.reason}`);
    lines.push('');
  }

  lines.push('## Suggested next step');
  lines.push('');
  lines.push('Open the page and check whether the data is still published at all. If the field');
  lines.push('has genuinely gone, the contract is now wrong and should change; if it has moved,');
  lines.push('add the expected element to the field description in `sources/` and re-run:');
  lines.push('');
  lines.push('```bash');
  lines.push(`pnpm weaver heal --source ${input.contract.id} --dry-run`);
  lines.push('```');

  return lines.join('\n');
}

function runGh(args: readonly string[]): Promise<string | undefined> {
  return new Promise((resolve, reject) => {
    execFile('gh', args, { encoding: 'utf8', timeout: 60_000 }, (error, stdout) => {
      if (error !== null) {
        reject(error instanceof Error ? error : new Error('gh issue create failed'));
        return;
      }
      const url = stdout.trim().split('\n').at(-1);
      resolve(url === undefined || url === '' ? undefined : url);
    });
  });
}
