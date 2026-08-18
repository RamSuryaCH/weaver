import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  BrightDataAuthError,
  BrightDataCollectionClient,
  BrightDataHttpError,
  BrightDataShapeError,
  CollectorNotFoundError,
  InputSchemaError,
  SnapshotTimeoutError,
  type FetchLike,
} from './index.js';

const API_KEY = 'test-key-2e75aaaaaaaaaaaaaaaaaaaaaaaaaaaa12bf';
const COLLECTOR_ID = 'c_mpohus372o5tmid1jk';
const COLLECTION_ID = 'j_abc123def456';

interface Call {
  readonly url: string;
  readonly init: RequestInit | undefined;
  /** Captured separately because Weaver only ever sends a JSON string body. */
  readonly body: string | undefined;
}

/** A fetch stub that replays queued responses and records every call. */
function stubFetch(responses: readonly Response[]): {
  fetch: FetchLike;
  calls: Call[];
} {
  const queue = [...responses];
  const calls: Call[] = [];

  const fetch: FetchLike = (url, init) => {
    calls.push({
      url,
      init,
      body: typeof init?.body === 'string' ? init.body : undefined,
    });
    const next = queue.shift();
    if (next === undefined) {
      throw new Error(`fetch stub exhausted after ${calls.length} calls to ${url}`);
    }
    return Promise.resolve(next);
  };

  return { fetch, calls };
}

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

/** A clock that advances only when the client sleeps, so tests never wait. */
function fakeClock(startMs = 1_700_000_000_000) {
  let current = startMs;
  const sleeps: number[] = [];
  return {
    now: () => current,
    sleep: (ms: number): Promise<void> => {
      sleeps.push(ms);
      current += ms;
      return Promise.resolve();
    },
    sleeps,
    advance: (ms: number): void => {
      current += ms;
    },
  };
}

function clientWith(fetch: FetchLike, clock = fakeClock()): BrightDataCollectionClient {
  return new BrightDataCollectionClient({
    apiKey: API_KEY,
    fetch,
    sleep: clock.sleep,
    now: clock.now,
    retryBaseMs: 1000,
  });
}

describe('BrightDataCollectionClient', () => {
  it('refuses to construct without an api key', () => {
    expect(() => new BrightDataCollectionClient({ apiKey: '  ' })).toThrow(BrightDataAuthError);
  });

  describe('trigger', () => {
    it('posts the inputs as a JSON array with bearer auth', async () => {
      const { fetch, calls } = stubFetch([json({ collection_id: COLLECTION_ID })]);

      const collectionId = await clientWith(fetch).trigger({
        collectorId: COLLECTOR_ID,
        inputs: [{ url: 'https://example.test/a' }, { url: 'https://example.test/b' }],
      });

      expect(collectionId).toBe(COLLECTION_ID);
      expect(calls).toHaveLength(1);

      const call = calls[0]!;
      expect(call.url).toContain('/dca/trigger');
      expect(call.url).toContain(`collector=${COLLECTOR_ID}`);
      expect(call.url).toContain('queue_next=1');
      expect(call.init?.method).toBe('POST');
      expect((call.init?.headers as Record<string, string>).Authorization).toBe(
        `Bearer ${API_KEY}`,
      );
      expect(JSON.parse(call.body ?? '')).toEqual([
        { url: 'https://example.test/a' },
        { url: 'https://example.test/b' },
      ]);
    });

    it('honours queueNext: false', async () => {
      const { fetch, calls } = stubFetch([json({ collection_id: COLLECTION_ID })]);

      await clientWith(fetch).trigger({
        collectorId: COLLECTOR_ID,
        inputs: [{ url: 'https://example.test/a' }],
        queueNext: false,
      });

      expect(calls[0]!.url).toContain('queue_next=0');
    });

    it('rejects an empty input list before spending a request', async () => {
      const { fetch, calls } = stubFetch([]);

      await expect(
        clientWith(fetch).trigger({ collectorId: COLLECTOR_ID, inputs: [] }),
      ).rejects.toThrow(InputSchemaError);
      expect(calls).toHaveLength(0);
    });

    it('reports a shape error when collection_id is missing', async () => {
      const { fetch } = stubFetch([json({ snapshot: 'j_1' })]);

      await expect(
        clientWith(fetch).trigger({
          collectorId: COLLECTOR_ID,
          inputs: [{ url: 'https://example.test/a' }],
        }),
      ).rejects.toThrow(BrightDataShapeError);
    });
  });

  describe('readSnapshot', () => {
    it('reports building while the snapshot is not ready', async () => {
      const { fetch } = stubFetch([json({ status: 'building' })]);

      const state = await clientWith(fetch).readSnapshot(COLLECTION_ID);

      expect(state).toEqual({ kind: 'building', status: 'building' });
    });

    it('returns rows once the response is an array', async () => {
      const rows = [{ url: 'https://example.test/a', price: 49.99 }];
      const { fetch } = stubFetch([json(rows)]);

      const state = await clientWith(fetch).readSnapshot(COLLECTION_ID);

      expect(state).toEqual({ kind: 'ready', rows });
    });

    it('treats an empty array as terminal rather than polling forever', async () => {
      // An empty snapshot means zero rows or an expired snapshot. Both are
      // conditions Weaver must report, so they must not be waited out.
      const { fetch } = stubFetch([json([])]);

      const state = await clientWith(fetch).readSnapshot(COLLECTION_ID);

      expect(state).toEqual({ kind: 'ready', rows: [] });
    });

    it('reports a shape error on an unrecognised response', async () => {
      const { fetch } = stubFetch([json({ unexpected: true })]);

      await expect(clientWith(fetch).readSnapshot(COLLECTION_ID)).rejects.toThrow(
        BrightDataShapeError,
      );
    });

    it('reports a shape error when the body is not JSON', async () => {
      const { fetch } = stubFetch([new Response('<html>gateway</html>', { status: 200 })]);

      await expect(clientWith(fetch).readSnapshot(COLLECTION_ID)).rejects.toThrow(/not JSON/);
    });
  });

  describe('collect', () => {
    it('polls until the snapshot is ready and reports how long it took', async () => {
      const rows = [{ url: 'https://example.test/a', price: 12.5 }];
      const clock = fakeClock();
      const { fetch } = stubFetch([
        json({ collection_id: COLLECTION_ID }),
        json({ status: 'building' }),
        json({ status: 'building' }),
        json(rows),
      ]);

      const result = await clientWith(fetch, clock).collect({
        collectorId: COLLECTOR_ID,
        inputs: [{ url: 'https://example.test/a' }],
        pollIntervalMs: 5000,
      });

      expect(result.rows).toEqual(rows);
      expect(result.collectionId).toBe(COLLECTION_ID);
      expect(result.pollCount).toBe(3);
      expect(clock.sleeps).toEqual([5000, 5000]);
      expect(result.durationMs).toBe(10_000);
      expect(result.startedAt < result.finishedAt).toBe(true);
    });

    it('reports progress for each poll', async () => {
      const clock = fakeClock();
      const { fetch } = stubFetch([
        json({ collection_id: COLLECTION_ID }),
        json({ status: 'building' }),
        json([{ price: 1 }]),
      ]);
      const progress: string[] = [];

      await clientWith(fetch, clock).collect({
        collectorId: COLLECTOR_ID,
        inputs: [{ url: 'https://example.test/a' }],
        pollIntervalMs: 1000,
        onProgress: (event) => progress.push(`${event.attempt}:${event.state}`),
      });

      expect(progress).toEqual(['1:building', '2:ready']);
    });

    it('gives up with a timeout error instead of polling indefinitely', async () => {
      const clock = fakeClock();
      const { fetch } = stubFetch([
        json({ collection_id: COLLECTION_ID }),
        json({ status: 'building' }),
        json({ status: 'building' }),
      ]);

      await expect(
        clientWith(fetch, clock).collect({
          collectorId: COLLECTOR_ID,
          inputs: [{ url: 'https://example.test/a' }],
          pollIntervalMs: 5000,
          timeoutMs: 9000,
        }),
      ).rejects.toThrow(SnapshotTimeoutError);
    });
  });

  describe('error mapping', () => {
    it('maps 401 to an auth error naming where to get the key', async () => {
      const { fetch } = stubFetch([json({ error: 'unauthorized' }, 401)]);

      await expect(clientWith(fetch).readSnapshot(COLLECTION_ID)).rejects.toThrow(
        /brightdata\.com\/cp\/setting/,
      );
    });

    it('maps 404 to a collector-not-found error naming the collector', async () => {
      const { fetch } = stubFetch([json({ error: 'not found' }, 404)]);

      await expect(
        clientWith(fetch).trigger({
          collectorId: COLLECTOR_ID,
          inputs: [{ url: 'https://example.test/a' }],
        }),
      ).rejects.toThrow(CollectorNotFoundError);
    });

    it('maps 422 to an input schema error', async () => {
      const { fetch } = stubFetch([new Response('unknown field "keyword"', { status: 422 })]);

      await expect(
        clientWith(fetch).trigger({
          collectorId: COLLECTOR_ID,
          inputs: [{ keyword: 'paracetamol' }],
        }),
      ).rejects.toThrow(/unknown field/);
    });

    it('retries a 5xx with exponential backoff, then succeeds', async () => {
      const clock = fakeClock();
      const { fetch } = stubFetch([
        json({ error: 'bad gateway' }, 502),
        json({ error: 'bad gateway' }, 502),
        json({ collection_id: COLLECTION_ID }),
      ]);

      const collectionId = await clientWith(fetch, clock).trigger({
        collectorId: COLLECTOR_ID,
        inputs: [{ url: 'https://example.test/a' }],
      });

      expect(collectionId).toBe(COLLECTION_ID);
      expect(clock.sleeps).toEqual([1000, 2000]);
    });

    it('retries a 429 as transient', async () => {
      const clock = fakeClock();
      const { fetch } = stubFetch([
        json({ error: 'slow down' }, 429),
        json({ collection_id: COLLECTION_ID }),
      ]);

      await expect(
        clientWith(fetch, clock).trigger({
          collectorId: COLLECTOR_ID,
          inputs: [{ url: 'https://example.test/a' }],
        }),
      ).resolves.toBe(COLLECTION_ID);
    });

    it('surfaces the last 5xx once retries are exhausted', async () => {
      const clock = fakeClock();
      const { fetch } = stubFetch([
        json({ error: 'boom' }, 500),
        json({ error: 'boom' }, 500),
        json({ error: 'boom' }, 500),
        json({ error: 'boom' }, 500),
      ]);

      await expect(clientWith(fetch, clock).readSnapshot(COLLECTION_ID)).rejects.toThrow(
        BrightDataHttpError,
      );
      expect(clock.sleeps).toEqual([1000, 2000, 4000]);
    });

    it('retries a network-level failure', async () => {
      const clock = fakeClock();
      let attempts = 0;
      const fetch: FetchLike = () => {
        attempts += 1;
        if (attempts < 3) return Promise.reject(new Error('ECONNRESET'));
        return Promise.resolve(json({ collection_id: COLLECTION_ID }));
      };

      await expect(
        clientWith(fetch, clock).trigger({
          collectorId: COLLECTOR_ID,
          inputs: [{ url: 'https://example.test/a' }],
        }),
      ).resolves.toBe(COLLECTION_ID);
      expect(attempts).toBe(3);
    });
  });

  describe('credential safety', () => {
    beforeEach(() => {
      vi.restoreAllMocks();
    });

    it('never includes the api key in an error message', async () => {
      const { fetch } = stubFetch([
        new Response(`upstream rejected Bearer ${API_KEY}`, { status: 500 }),
        new Response(`upstream rejected Bearer ${API_KEY}`, { status: 500 }),
        new Response(`upstream rejected Bearer ${API_KEY}`, { status: 500 }),
        new Response(`upstream rejected Bearer ${API_KEY}`, { status: 500 }),
      ]);

      const error = await clientWith(fetch)
        .readSnapshot(COLLECTION_ID)
        .catch((caught: unknown) => caught);

      expect(String(error)).not.toContain(API_KEY);
      expect(String(error)).toContain('[redacted]');
    });
  });
});
