/* eslint-disable @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-unsafe-member-access, @typescript-eslint/no-explicit-any, @typescript-eslint/no-unsafe-argument */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import type { MockInstance } from 'vitest';
import Fastify, { type FastifyInstance } from 'fastify';
import { LedgerEventSynchronizer } from '../../src/core/blockchain/event_listener.js';
import { registerAdminRoutes } from '../../src/api/routes/admin.js';
import { clearEnvCache } from '../../src/config/env.js';

import { PrismaClient } from '@prisma/client';

// ─── Prisma mock factory ───────────────────────────────────────────────────

function makePrismaMock(foundRow: { lastSyncedLedger: number } | null = null): any {
  const upsertMock = vi.fn().mockResolvedValue(undefined);
  const prisma = {
    ledgerSyncState: {
      findUnique: vi.fn().mockResolvedValue(foundRow),
      upsert: upsertMock,
    },
  } as unknown as PrismaClient;
  return Object.assign(prisma, { upsertMock });
}

// ─── Fetch mock helpers ────────────────────────────────────────────────────

function makeLedgerResponse(seq: number): Promise<Response> {
  return Promise.resolve(
    new Response(
      JSON.stringify({ sequence: seq, hash: `hash${String(seq)}`, closedAt: '', transactions: [] }),
    ),
  );
}

function makeLatestResponse(seq: number): Promise<Response> {
  return Promise.resolve(new Response(JSON.stringify({ sequence: seq })));
}

// ─── LedgerEventSynchronizer unit tests ───────────────────────────────────

describe('LedgerEventSynchronizer', () => {
  let fetchSpy: MockInstance;

  beforeEach(() => {
    vi.useFakeTimers();
    fetchSpy = vi.spyOn(global, 'fetch');
  });

  afterEach(() => {
    vi.restoreAllMocks();
    vi.useRealTimers();
  });

  it('loads lastSyncedLedger from DB on start', async () => {
    const prisma = makePrismaMock({ lastSyncedLedger: 500 });
    const sync = new LedgerEventSynchronizer(prisma, 'http://rpc', {
      startingLedger: 100,
    });
    await sync.start();
    sync.stop();
    expect(sync.getSyncState().lastSyncedLedger).toBe(500);
  });

  it('defaults to startingLedger when DB has no row', async () => {
    const prisma = makePrismaMock(null);
    const sync = new LedgerEventSynchronizer(prisma, 'http://rpc', {
      startingLedger: 100,
    });
    await sync.start();
    sync.stop();
    expect(sync.getSyncState().lastSyncedLedger).toBe(100);
  });

  it('catchUp fetches all ledgers in parallel batches', async () => {
    const prisma = makePrismaMock(null);
    fetchSpy.mockImplementation((url: string) => {
      const seqMatch = /\/ledgers\/(\d+)$/.exec(url);
      if (seqMatch) return makeLedgerResponse(Number(seqMatch[1]));
      return makeLatestResponse(0);
    });

    const sync = new LedgerEventSynchronizer(prisma, 'http://rpc', {
      startingLedger: 0,
      concurrency: 5,
    });
    await sync.start();
    sync.stop();

    // Process ledgers 1–15 (3 batches of 5)
    await sync.catchUp(0, 15);

    // fetchLedger is called once per ledger (15 calls)
    const ledgerFetches = fetchSpy.mock.calls.filter(([url]) =>
      /\/ledgers\/\d+$/.test(String(url)),
    );
    expect(ledgerFetches).toHaveLength(15);
    expect(sync.getSyncState().lastSyncedLedger).toBe(15);
  });

  it('catchUp checkpoints at 64-ledger boundaries', async () => {
    const prisma = makePrismaMock(null);
    fetchSpy.mockImplementation((url: string) => {
      const seqMatch = /\/ledgers\/(\d+)$/.exec(url);
      if (seqMatch) return makeLedgerResponse(Number(seqMatch[1]));
      return makeLatestResponse(0);
    });

    const sync = new LedgerEventSynchronizer(prisma, 'http://rpc', {
      startingLedger: 0,
      concurrency: 10,
    });
    await sync.start();
    sync.stop();

    // 128 ledgers → expect checkpoints at ~ledger 64, ~ledger 128 (boundary crossings)
    await sync.catchUp(0, 128);

    // upsert should be called at least twice (once per 64-ledger boundary + final)
    expect(prisma.upsertMock).toHaveBeenCalledTimes(2);
    expect(sync.getSyncState().lastSyncedLedger).toBe(128);
  });

  it('retries a failed ledger without aborting the batch', async () => {
    const prisma = makePrismaMock(null);
    let callCount = 0;

    fetchSpy.mockImplementation((url: string) => {
      const seqMatch = /\/ledgers\/5$/.exec(url);
      if (seqMatch) {
        callCount++;
        if (callCount < 3) {
          return Promise.reject(new Error('transient network error'));
        }
      }
      const anySeq = /\/ledgers\/(\d+)$/.exec(url);
      if (anySeq) return makeLedgerResponse(Number(anySeq[1]));
      return makeLatestResponse(0);
    });

    const sync = new LedgerEventSynchronizer(prisma, 'http://rpc', {
      startingLedger: 0,
      concurrency: 5,
    });
    await sync.start();
    sync.stop();

    // Advance fake timers to resolve sleep calls in retries
    const catchUpPromise = sync.catchUp(0, 5);
    await vi.runAllTimersAsync();
    await catchUpPromise;

    // Ledger 5 ultimately succeeded after 2 retries; no error counted
    expect(sync.getSyncState().errorCount).toBe(0);
    expect(sync.getSyncState().lastSyncedLedger).toBe(5);
  });

  it('increments errorCount and continues when a ledger permanently fails', async () => {
    const prisma = makePrismaMock(null);

    fetchSpy.mockImplementation((url: string) => {
      if (url.endsWith('/ledgers/3')) {
        return Promise.reject(new Error('permanent failure'));
      }
      const seqMatch = /\/ledgers\/(\d+)$/.exec(url);
      if (seqMatch) return makeLedgerResponse(Number(seqMatch[1]));
      return makeLatestResponse(0);
    });

    const sync = new LedgerEventSynchronizer(prisma, 'http://rpc', {
      startingLedger: 0,
      concurrency: 5,
    });
    await sync.start();
    sync.stop();

    const catchUpPromise = sync.catchUp(0, 5);
    await vi.runAllTimersAsync();
    await catchUpPromise;

    // Ledger 3 failed all retries; other ledgers still processed
    expect(sync.getSyncState().errorCount).toBe(1);
    expect(sync.getSyncState().lastSyncedLedger).toBe(5);
  });

  it('caps gap at MAX_GAP (172_800)', () => {
    const prisma = makePrismaMock(null);
    const sync = new LedgerEventSynchronizer(prisma, 'http://rpc');

    // targetLedger is set synchronously before any await inside catchUp
    void sync.catchUp(0, 200_000);
    expect(sync.getSyncState().targetLedger).toBe(172_800);
    sync.stop();
  });

  it('pollLatestLedger skips if catchUp is already in progress', async () => {
    const prisma = makePrismaMock(null);

    // Pause ledger fetches so catchUp stays in-progress when the poll fires
    let resolveLedgerFetch!: () => void;
    const ledgerFetchPaused = new Promise<void>((resolve) => {
      resolveLedgerFetch = resolve;
    });

    fetchSpy.mockImplementation((url: string) => {
      if (url.endsWith('/ledgers/latest')) return makeLatestResponse(20);
      const seqMatch = /\/ledgers\/(\d+)$/.exec(url);
      if (seqMatch) {
        return ledgerFetchPaused.then(() => makeLedgerResponse(Number(seqMatch[1])));
      }
      return makeLatestResponse(0);
    });

    const sync = new LedgerEventSynchronizer(prisma, 'http://rpc', {
      startingLedger: 0,
      concurrency: 10,
      pollIntervalMs: 100,
    });
    await sync.start();

    // Start catchUp — sets inProgress=true, targetLedger=5; pauses on first fetch
    const catchUpPromise = sync.catchUp(0, 5);

    // Advance 100ms: poll fires, sees inProgress=true, skips
    await vi.advanceTimersByTimeAsync(100);

    // Unblock ledger fetches and let catchUp finish
    resolveLedgerFetch();
    await catchUpPromise;
    sync.stop();

    // targetLedger is still 5 — the poll at 100ms did NOT start a new catchUp(5, 20)
    expect(sync.getSyncState().targetLedger).toBe(5);
  });
});

// ─── GET /api/admin/sync-status route tests ───────────────────────────────

describe('GET /api/admin/sync-status', () => {
  let app: FastifyInstance;

  beforeEach(() => {
    clearEnvCache();
    process.env['ADMIN_SECRET_KEY'] = 'test-admin-key';
    process.env['JWT_SECRET'] = 'a'.repeat(32);
    process.env['DATABASE_URL'] = 'postgresql://localhost/test';
    process.env['TIMESCALEDB_URL'] = 'postgresql://localhost/test';
    process.env['SOROBAN_RPC_URL'] = 'http://localhost:8000';
    process.env['SOROBAN_NETWORK_PASSPHRASE'] = 'Test SDF Network ; September 2015';

    app = Fastify({ logger: false });
  });

  afterEach(async () => {
    await app.close();
    clearEnvCache();
  });

  it('returns 401 without X-Admin-Key', async () => {
    registerAdminRoutes(app);
    await app.ready();

    const res = await app.inject({ method: 'GET', url: '/api/admin/sync-status' });
    expect(res.statusCode).toBe(401);
  });

  it('returns 503 when no synchronizer is configured', async () => {
    registerAdminRoutes(app, undefined);
    await app.ready();

    const res = await app.inject({
      method: 'GET',
      url: '/api/admin/sync-status',
      headers: { 'x-admin-key': 'test-admin-key' },
    });
    expect(res.statusCode).toBe(503);
    const body = JSON.parse(res.body) as { error: string };
    expect(body.error).toBe('Sync service not available');
  });

  it('returns 200 with sync state when synchronizer is provided', async () => {
    const prisma = makePrismaMock({ lastSyncedLedger: 999 });
    vi.useFakeTimers();
    vi.spyOn(global, 'fetch');

    const sync = new LedgerEventSynchronizer(prisma, 'http://rpc');
    await sync.start();
    sync.stop();

    registerAdminRoutes(app, sync);
    await app.ready();

    const res = await app.inject({
      method: 'GET',
      url: '/api/admin/sync-status',
      headers: { 'x-admin-key': 'test-admin-key' },
    });
    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body) as {
      lastSyncedLedger: number;
      targetLedger: number;
      inProgress: boolean;
      errorCount: number;
      timestamp: number;
    };
    expect(body.lastSyncedLedger).toBe(999);
    expect(body.inProgress).toBe(false);
    expect(body.errorCount).toBe(0);
    expect(typeof body.timestamp).toBe('number');

    vi.restoreAllMocks();
    vi.useRealTimers();
  });
});
