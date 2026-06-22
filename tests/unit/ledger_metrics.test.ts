import { describe, it, expect, beforeEach, afterEach, vi, type MockInstance } from 'vitest';
import { LedgerEventSynchronizer } from '../../src/core/blockchain/event_listener.js';

interface PrismaMock {
  ledgerSyncState: {
    findUnique: ReturnType<typeof vi.fn>;
    upsert: ReturnType<typeof vi.fn>;
  };
}

function makePrismaMock(): PrismaMock {
  return {
    ledgerSyncState: {
      findUnique: vi.fn().mockResolvedValue(null),
      upsert: vi.fn().mockResolvedValue(undefined),
    },
  };
}

function latestResp(seq: number): Promise<Response> {
  return Promise.resolve(new Response(JSON.stringify({ sequence: seq })));
}

function ledgerResp(seq: number): Promise<Response> {
  return Promise.resolve(
    new Response(
      JSON.stringify({
        sequence: seq,
        hash: `hash${seq.toString()}`,
        closedAt: '',
        transactions: [],
      }),
    ),
  );
}

describe('LedgerEventSynchronizer metrics hooks (issue #19)', () => {
  let fetchSpy: MockInstance;
  beforeEach((): void => {
    vi.useFakeTimers();
    fetchSpy = vi.spyOn(global, 'fetch');
  });

  afterEach((): void => {
    vi.restoreAllMocks();
    vi.useRealTimers();
  });

  it('reports null lag and latestPolledSequence before any successful poll', async () => {
    fetchSpy.mockImplementation((url: string): Promise<Response> => {
      if (url.endsWith('/ledgers/latest')) return latestResp(50);
      return ledgerResp(0);
    });
    const sync = new LedgerEventSynchronizer(makePrismaMock() as never, 'http://rpc', {
      pollIntervalMs: 60_000,
    });
    await sync.start();
    sync.stop();

    // No poll has yet fired — only start() ran. The very first poll happens
    // on the first interval tick.
    expect(sync.getLatestPolledSequence()).toBeNull();
    expect(sync.getLedgerLag()).toBeNull();
  });

  it('after a successful poll, exposes latestPolledSequence and lag', async () => {
    fetchSpy.mockImplementation((url: string): Promise<Response> => {
      if (url.endsWith('/ledgers/latest')) return latestResp(120);
      return ledgerResp(0);
    });

    const sync = new LedgerEventSynchronizer(makePrismaMock() as never, 'http://rpc', {
      pollIntervalMs: 60_000,
    });
    await sync.start();
    // Advance the interval *before* stopping so the poll actually runs
    await vi.advanceTimersByTimeAsync(60_000);
    sync.stop();

    expect(sync.getLatestPolledSequence()).toBe(120);
    // catchUp caught up to 120 because lastSyncedLedger started at 0 (no DB row)
    expect(sync.getSyncState().lastSyncedLedger).toBe(120);
    expect(sync.getLedgerLag()).toBe(0);
  });

  it('invokes onPoll callback after each successful poll with correct lag', async () => {
    fetchSpy.mockImplementation((url: string): Promise<Response> => {
      if (url.endsWith('/ledgers/latest')) return latestResp(200);
      return ledgerResp(0);
    });

    const onPoll = vi.fn();
    const sync = new LedgerEventSynchronizer(makePrismaMock() as never, 'http://rpc', {
      pollIntervalMs: 60_000,
      startingLedger: 0,
      onPoll,
    });
    await sync.start();
    onPoll.mockClear();
    await vi.advanceTimersByTimeAsync(60_000);
    sync.stop();

    expect(onPoll).toHaveBeenCalled();
    const lastCall = onPoll.mock.calls.at(-1)?.[0] as {
      latestSequence: number;
      lastSyncedLedger: number;
      lag: number;
    };
    expect(lastCall.latestSequence).toBe(200);
    expect(lastCall.lastSyncedLedger).toBe(200);
    expect(lastCall.lag).toBe(0);
  });

  it('invokes onPollError when the RPC poll throws', async () => {
    fetchSpy.mockImplementation((url: string): Promise<Response> => {
      if (url.endsWith('/ledgers/latest')) return Promise.reject(new Error('rpc 503'));
      return ledgerResp(0);
    });

    const onPollError = vi.fn();
    const sync = new LedgerEventSynchronizer(makePrismaMock() as never, 'http://rpc', {
      pollIntervalMs: 60_000,
      onPollError,
    });
    await sync.start();
    onPollError.mockClear();
    await vi.advanceTimersByTimeAsync(60_000);
    sync.stop();

    expect(onPollError).toHaveBeenCalledTimes(1);
    expect(sync.getLatestPolledSequence()).toBeNull();
  });

  it('reports non-zero lag when latest polled sequence is ahead of lastSyncedLedger', async () => {
    // Provide a realistic mock: latest=20, ledger N returns sequence N.
    fetchSpy.mockImplementation((url: string): Promise<Response> => {
      if (url.endsWith('/ledgers/latest')) return latestResp(20);
      const match = /\/ledgers\/(\d+)$/.exec(url);
      return ledgerResp(match ? Number(match[1]) : 0);
    });

    const onPoll = vi.fn();
    const sync = new LedgerEventSynchronizer(makePrismaMock() as never, 'http://rpc', {
      pollIntervalMs: 60_000,
      startingLedger: 10,
      concurrency: 5,
      onPoll,
    });
    await sync.start();
    onPoll.mockClear();

    // Fire one poll cycle: discovers sequence=20, emits onPoll with lag=10, then
    // catchUp(10, 20) which completes via the mocked fetches, emits a follow-up
    // onPoll with lag=0.
    await vi.advanceTimersByTimeAsync(60_000);

    expect(onPoll).toHaveBeenCalled();
    const emits = onPoll.mock.calls.map(
      (c) =>
        c[0] as {
          latestSequence: number;
          lastSyncedLedger: number;
          lag: number;
        },
    );
    expect(emits[0]?.latestSequence).toBe(20);
    expect(emits[0]?.lastSyncedLedger).toBe(10);
    expect(emits[0]?.lag).toBe(10);
    // After catchUp completes, a second emit should reflect lag=0
    expect(emits.at(-1)?.lag).toBe(0);
    sync.stop();
  });
});
