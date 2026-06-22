import { describe, it, expect, beforeEach } from 'vitest';
import Fastify, { type FastifyInstance } from 'fastify';
import {
  gcPauseDuration,
  pgPoolConnectionsTotal,
  pgPoolConnectionsIdle,
  pgPoolConnectionsActive,
  pgPoolConnectionsWaiting,
  ledgerSyncLag,
  ledgerLastSyncedSequence,
  ledgerLatestPolledSequence,
  recordGcPause,
  setPgPoolConnections,
  setLedgerSyncMetrics,
  getMetrics,
  getMetricsContentType,
  GC_PAUSE_BUCKETS_MS,
  registerMetricsRoute,
} from '../../src/api/metrics/prometheus.js';

// Default buckets stability check — prom-client renders bucket labels as
// `le="<number>"`. We scrub default Node metrics so the assertions stay
// focused on issue #19 requirements.
const SCRUB_DEFAULTS: RegExp[] = [
  /^# HELP nodejs_/m,
  /^# TYPE nodejs_/m,
  /^nodejs_/m,
  /^# HELP process_/m,
  /^# TYPE process_/m,
  /^process_/m,
];

function scrub(text: string): string {
  return SCRUB_DEFAULTS.reduce((acc, re) => acc.replace(re, ''), text);
}

describe('Prometheus metrics surface (issue #19)', () => {
  beforeEach((): void => {
    gcPauseDuration.reset();
    pgPoolConnectionsTotal.reset();
    pgPoolConnectionsIdle.reset();
    pgPoolConnectionsActive.reset();
    pgPoolConnectionsWaiting.reset();
    ledgerSyncLag.reset();
    ledgerLastSyncedSequence.reset();
    ledgerLatestPolledSequence.reset();
  });

  it('exposes the required GC pause buckets exactly as specified', (): void => {
    expect(GC_PAUSE_BUCKETS_MS).toEqual([1, 5, 10, 25, 50, 100, 250, 500]);
  });

  it('records GC pause observations on the histogram', async () => {
    recordGcPause(3);
    recordGcPause(45);
    recordGcPause(999);
    const text = scrub(await getMetrics());
    expect(text).toContain('node_gc_pause_duration_ms_bucket{le="1"} 0');
    expect(text).toContain('node_gc_pause_duration_ms_bucket{le="5"} 1');
    expect(text).toContain('node_gc_pause_duration_ms_bucket{le="10"} 1');
    expect(text).toContain('node_gc_pause_duration_ms_bucket{le="50"} 2');
    expect(text).toContain('node_gc_pause_duration_ms_count 3');
    expect(text).toContain('node_gc_pause_duration_ms_sum 1047');
  });

  it('emits per-pool total/idle/active/waiting gauges when written', async () => {
    setPgPoolConnections('timescale', { total: 8, idle: 3, active: 5, waiting: 1 });
    setPgPoolConnections('cache', { total: 5, idle: 5, active: 0, waiting: 0 });
    const text = scrub(await getMetrics());
    expect(text).toContain('pg_pool_connections_total{pool="timescale"} 8');
    expect(text).toContain('pg_pool_connections_idle{pool="timescale"} 3');
    expect(text).toContain('pg_pool_connections_active{pool="timescale"} 5');
    expect(text).toContain('pg_pool_connections_waiting{pool="timescale"} 1');
    expect(text).toContain('pg_pool_connections_total{pool="cache"} 5');
  });

  it('emits ledger sync lag and last/last-polled gauges', async () => {
    setLedgerSyncMetrics({
      syncId: 'primary',
      lag: 12,
      lastSyncedSequence: 1000,
      latestPolledSequence: 1012,
    });
    const text = scrub(await getMetrics());
    expect(text).toContain('ledger_sync_lag{sync_id="primary"} 12');
    expect(text).toContain('ledger_last_synced_sequence{sync_id="primary"} 1000');
    expect(text).toContain('ledger_latest_polled_sequence{sync_id="primary"} 1012');
  });

  it('returns text with the prom-client content type', (): void => {
    expect(getMetricsContentType()).toMatch(/text\/plain/);
  });
});

describe('GET /metrics endpoint', () => {
  let app: FastifyInstance;

  beforeEach(async (): Promise<void> => {
    app = Fastify({ logger: false });
    registerMetricsRoute(app);
    await app.ready();
  });

  it('serves scrape output with correct content type', async () => {
    recordGcPause(7);
    const res = await app.inject({ method: 'GET', url: '/metrics' });
    expect(res.statusCode).toBe(200);
    expect(res.headers['content-type']).toMatch(/text\/plain/);
    const scraped = scrub(res.body);
    expect(scraped).toContain('node_gc_pause_duration_ms_count 1');
  });

  it('survives a high scrape rate (>=166 scrapes / sec) within the 10ms budget', async () => {
    recordGcPause(2);
    const start = performance.now();
    let minMs = Number.POSITIVE_INFINITY;
    let maxMs = 0;
    const totalScrapes = 250; // safe headroom over 166/s for one second of load
    for (let i = 0; i < totalScrapes; i++) {
      const t0 = performance.now();
      const res = await app.inject({ method: 'GET', url: '/metrics' });
      const dt = performance.now() - t0;
      expect(res.statusCode).toBe(200);
      if (dt < minMs) minMs = dt;
      if (dt > maxMs) maxMs = dt;
    }
    const totalElapsed = performance.now() - start;
    // Average per scrape must be well under 10ms to honor issue #19 budget.
    expect(totalElapsed / totalScrapes).toBeLessThan(10);

    const avgMs = (totalElapsed / totalScrapes).toFixed(2);
    const minStr = minMs.toFixed(2);
    const maxStr = maxMs.toFixed(2);
    const totalStr = totalScrapes.toString();
    console.log(
      `/metrics: per-scrape avg=${avgMs}ms min=${minStr} max=${maxStr} over ${totalStr} scrapes`,
    );
  });
});
