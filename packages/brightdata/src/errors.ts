/**
 * Errors from the Bright Data boundary.
 *
 * Each documented status code gets its own type, because the operator response
 * is different in every case: a 401 means fix your token, a 404 means the
 * Collector ID is wrong, and a 422 means the contract's inputs no longer match
 * the collector's input schema. Collapsing those into one "request failed" tells
 * you nothing at 3am.
 *
 * No error message ever includes the API key. `redact` below is the only place
 * that has to be right for that to hold.
 */

export class BrightDataError extends Error {
  constructor(message: string) {
    super(message);
    this.name = new.target.name;
  }
}

/** 401 — token missing, malformed or revoked. */
export class BrightDataAuthError extends BrightDataError {
  constructor() {
    super(
      'Bright Data rejected the API key (401). Re-copy it from https://brightdata.com/cp/setting ' +
        'or run: npx -p @brightdata/cli bdata login',
    );
  }
}

/** 404 — the collector does not exist, or this account cannot see it. */
export class CollectorNotFoundError extends BrightDataError {
  constructor(readonly collectorId: string) {
    super(
      `Bright Data has no collector "${collectorId}" for this account (404). ` +
        'Check the collector_id in the source contract.',
    );
  }
}

/** 422 — the inputs do not match the collector's input schema. */
export class InputSchemaError extends BrightDataError {
  constructor(
    readonly collectorId: string,
    readonly detail: string,
  ) {
    super(
      `Collector "${collectorId}" rejected the inputs (422): ${detail}. ` +
        "Compare the contract's inputs against the collector's Inputs tab.",
    );
  }
}

/** Any other non-2xx response, including 5xx after retries are exhausted. */
export class BrightDataHttpError extends BrightDataError {
  constructor(
    readonly status: number,
    readonly endpoint: string,
    readonly body: string,
  ) {
    super(`Bright Data returned ${status} from ${endpoint}: ${truncate(body, 300)}`);
  }
}

/** A response arrived but did not match the documented shape. */
export class BrightDataShapeError extends BrightDataError {
  constructor(
    readonly endpoint: string,
    readonly detail: string,
  ) {
    super(
      `Bright Data returned an unexpected shape from ${endpoint}: ${detail}. ` +
        'This usually means the API changed; the parser in @weaver/brightdata needs updating.',
    );
  }
}

/** The snapshot never became ready inside the allotted time. */
export class SnapshotTimeoutError extends BrightDataError {
  constructor(
    readonly collectionId: string,
    readonly waitedMs: number,
  ) {
    super(
      `Snapshot ${collectionId} was still building after ${Math.round(waitedMs / 1000)}s. ` +
        'Large input sets are better served by push delivery than polling.',
    );
  }
}

/** The `bdata` CLI exited non-zero. */
export class ScraperStudioCliError extends BrightDataError {
  constructor(
    readonly command: string,
    readonly exitCode: number | null,
    readonly stderr: string,
  ) {
    super(`bdata ${command} exited ${exitCode ?? 'without a code'}: ${truncate(stderr, 400)}`);
  }
}

function truncate(text: string, max: number): string {
  const collapsed = text.replace(/\s+/g, ' ').trim();
  return collapsed.length <= max ? collapsed : `${collapsed.slice(0, max)}...`;
}

/**
 * Remove anything that looks like a credential from text destined for a log,
 * an error message or the terminal.
 *
 * Weaver's demo is a screen recording, so this is a functional requirement
 * rather than good hygiene.
 */
export function redact(text: string, secret?: string): string {
  let output = text;
  if (secret !== undefined && secret.length > 0) {
    output = output.split(secret).join('[redacted]');
  }
  return output
    .replace(/Bearer\s+[\w.-]+/gi, 'Bearer [redacted]')
    .replace(/\b[0-9a-f]{32,}\b/gi, '[redacted]');
}
