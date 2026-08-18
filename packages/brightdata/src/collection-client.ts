/**
 * The Bright Data Scraper Studio Collection API.
 *
 * Two calls, wrapped so the rest of Weaver never thinks about them again:
 *
 *   POST /dca/trigger?collector=c_*&queue_next=1   ->  { collection_id: "j_*" }
 *   GET  /dca/dataset?id=j_*                       ->  { status: "building" } | Row[]
 *
 * Design notes worth knowing before changing anything here:
 *
 * - `fetch` and `sleep` are injected. That is why the tests need no HTTP
 *   interception library and run in milliseconds instead of polling for real.
 * - Rows leave this module as `unknown[]`. Validating them is the contract
 *   layer's job, and mixing the two would put domain rules inside a transport
 *   client. The seam is deliberate.
 * - The Collector ID is the only handle callers need. Healing keeps it stable,
 *   which is what makes it safe to store in a YAML file and a CI secret.
 */
import { z } from 'zod';
import {
  BrightDataAuthError,
  BrightDataHttpError,
  BrightDataShapeError,
  CollectorNotFoundError,
  InputSchemaError,
  SnapshotTimeoutError,
  redact,
} from './errors.js';

export type FetchLike = (url: string, init?: RequestInit) => Promise<Response>;
export type SleepLike = (ms: number) => Promise<void>;

/** One input row for a collector. `url` for PDP/discovery, `keyword` for search. */
export type CollectorInput = Readonly<Record<string, string>>;

export const DEFAULT_BASE_URL = 'https://api.brightdata.com';

const triggerResponseSchema = z.object({
  collection_id: z.string().min(1),
});

const buildingResponseSchema = z.object({
  status: z.string().min(1),
});

export interface CollectionClientOptions {
  readonly apiKey: string;
  readonly baseUrl?: string;
  readonly fetch?: FetchLike;
  readonly sleep?: SleepLike;
  readonly now?: () => number;
  /** Retries for transient 5xx responses. Bright Data's own advice is 1s, 2s, 4s. */
  readonly maxRetries?: number;
  readonly retryBaseMs?: number;
}

export type SnapshotState =
  | { readonly kind: 'building'; readonly status: string }
  | { readonly kind: 'ready'; readonly rows: readonly unknown[] };

export interface CollectProgress {
  readonly collectionId: string;
  readonly attempt: number;
  readonly elapsedMs: number;
  readonly state: SnapshotState['kind'];
}

export interface CollectRequest {
  readonly collectorId: string;
  readonly inputs: readonly CollectorInput[];
  /** `queue_next=1` runs immediately instead of queueing behind in-flight work. */
  readonly queueNext?: boolean;
  readonly pollIntervalMs?: number;
  readonly timeoutMs?: number;
  readonly onProgress?: (progress: CollectProgress) => void;
}

export interface CollectionResult {
  readonly collectorId: string;
  readonly collectionId: string;
  readonly rows: readonly unknown[];
  readonly startedAt: string;
  readonly finishedAt: string;
  readonly durationMs: number;
  readonly pollCount: number;
}

export class BrightDataCollectionClient {
  private readonly apiKey: string;
  private readonly baseUrl: string;
  private readonly fetchImpl: FetchLike;
  private readonly sleep: SleepLike;
  private readonly now: () => number;
  private readonly maxRetries: number;
  private readonly retryBaseMs: number;

  constructor(options: CollectionClientOptions) {
    if (options.apiKey.trim() === '') {
      throw new BrightDataAuthError();
    }
    this.apiKey = options.apiKey;
    this.baseUrl = (options.baseUrl ?? DEFAULT_BASE_URL).replace(/\/$/, '');
    this.fetchImpl = options.fetch ?? globalThis.fetch.bind(globalThis);
    this.sleep = options.sleep ?? ((ms) => new Promise((resolve) => setTimeout(resolve, ms)));
    this.now = options.now ?? (() => Date.now());
    this.maxRetries = options.maxRetries ?? 3;
    this.retryBaseMs = options.retryBaseMs ?? 1000;
  }

  /** Queue inputs and return the collection (snapshot) id. */
  async trigger(request: {
    readonly collectorId: string;
    readonly inputs: readonly CollectorInput[];
    readonly queueNext?: boolean;
  }): Promise<string> {
    if (request.inputs.length === 0) {
      throw new InputSchemaError(request.collectorId, 'no inputs supplied');
    }

    const query = new URLSearchParams({
      collector: request.collectorId,
      queue_next: (request.queueNext ?? true) ? '1' : '0',
    });
    const endpoint = `/dca/trigger?${query.toString()}`;

    const body = await this.request(endpoint, request.collectorId, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(request.inputs),
    });

    const parsed = triggerResponseSchema.safeParse(body);
    if (!parsed.success) {
      throw new BrightDataShapeError(endpoint, 'expected { collection_id: string }');
    }
    return parsed.data.collection_id;
  }

  /**
   * Read a snapshot once.
   *
   * `/dca/dataset` serves both the in-progress object and the finished array, so
   * the response type is the state machine. An array — even an empty one — is
   * terminal: an empty snapshot means zero rows or an expired snapshot, and both
   * are conditions Weaver should report rather than wait out. Polling forever on
   * an empty array (as the doc example does) would hide exactly the failure this
   * project exists to catch.
   */
  async readSnapshot(collectionId: string): Promise<SnapshotState> {
    const endpoint = `/dca/dataset?id=${encodeURIComponent(collectionId)}`;
    const body = await this.request(endpoint, collectionId, { method: 'GET' });

    if (Array.isArray(body)) {
      return { kind: 'ready', rows: body };
    }

    const building = buildingResponseSchema.safeParse(body);
    if (building.success) {
      return { kind: 'building', status: building.data.status };
    }

    throw new BrightDataShapeError(endpoint, 'expected an array of rows or { status }');
  }

  /** Trigger, then poll until the snapshot is ready. */
  async collect(request: CollectRequest): Promise<CollectionResult> {
    const pollIntervalMs = request.pollIntervalMs ?? 5000;
    const timeoutMs = request.timeoutMs ?? 600_000;

    const startedAtMs = this.now();
    const startedAt = new Date(startedAtMs).toISOString();

    const collectionId = await this.trigger({
      collectorId: request.collectorId,
      inputs: request.inputs,
      ...(request.queueNext === undefined ? {} : { queueNext: request.queueNext }),
    });

    let attempt = 0;
    for (;;) {
      attempt += 1;
      const state = await this.readSnapshot(collectionId);
      const elapsedMs = this.now() - startedAtMs;

      request.onProgress?.({ collectionId, attempt, elapsedMs, state: state.kind });

      if (state.kind === 'ready') {
        const finishedAtMs = this.now();
        return {
          collectorId: request.collectorId,
          collectionId,
          rows: state.rows,
          startedAt,
          finishedAt: new Date(finishedAtMs).toISOString(),
          durationMs: finishedAtMs - startedAtMs,
          pollCount: attempt,
        };
      }

      if (elapsedMs + pollIntervalMs > timeoutMs) {
        throw new SnapshotTimeoutError(collectionId, elapsedMs);
      }
      await this.sleep(pollIntervalMs);
    }
  }

  /**
   * One HTTP call, with the documented status codes mapped to typed errors and
   * exponential backoff on 5xx.
   */
  private async request(endpoint: string, subject: string, init: RequestInit): Promise<unknown> {
    let lastError: unknown;

    for (let attempt = 0; attempt <= this.maxRetries; attempt += 1) {
      let response: Response;
      try {
        response = await this.fetchImpl(`${this.baseUrl}${endpoint}`, {
          ...init,
          headers: {
            ...(init.headers as Record<string, string> | undefined),
            Authorization: `Bearer ${this.apiKey}`,
          },
        });
      } catch (error) {
        // Network-level failure. Treat like a 5xx: retry, then surface.
        lastError = new BrightDataHttpError(0, endpoint, redact(describe(error), this.apiKey));
        if (attempt === this.maxRetries) throw lastError;
        await this.sleep(this.retryBaseMs * 2 ** attempt);
        continue;
      }

      if (response.ok) {
        return await this.readJson(response, endpoint);
      }

      if (response.status === 401) throw new BrightDataAuthError();
      if (response.status === 404) throw new CollectorNotFoundError(subject);
      if (response.status === 422) {
        throw new InputSchemaError(subject, redact(await safeText(response), this.apiKey));
      }

      const bodyText = redact(await safeText(response), this.apiKey);
      lastError = new BrightDataHttpError(response.status, endpoint, bodyText);

      const transient = response.status >= 500 || response.status === 429;
      if (!transient || attempt === this.maxRetries) throw lastError;
      await this.sleep(this.retryBaseMs * 2 ** attempt);
    }

    throw lastError instanceof Error ? lastError : new BrightDataHttpError(0, endpoint, 'unknown');
  }

  private async readJson(response: Response, endpoint: string): Promise<unknown> {
    const text = await safeText(response);
    try {
      return JSON.parse(text) as unknown;
    } catch {
      throw new BrightDataShapeError(endpoint, 'response was not JSON');
    }
  }
}

async function safeText(response: Response): Promise<string> {
  try {
    return await response.text();
  } catch {
    return '';
  }
}

function describe(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
