import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import promClient from 'prom-client';
import { PoolMetricsCollector } from '../../src/api/metrics/pool_metrics_collector.js';
import {
  pgPoolConnectionsTotal,
  pgPoolConnectionsIdle,
  pgPoolConnectionsActive,
  pgPoolConnectionsWaiting,
} from '../../src/api/metrics/prometheus.js';

interface PoolStatsRecord {
  totalConnections: number;
  idleConnections: number;
  waitingClients: number;
}

function makeSource(stats: Record<string, PoolStatsRecord>): {
  getPoolNames: () => string[];
  getMetrics: (name: string) => PoolStatsRecord;
} {
  return {
    getPoolNames: (): string[] => Object.keys(stats),
    getMetrics: (name: string): PoolStatsRecord => {
      const value = stats[name];
      if (!value) throw new Error(`Pool "${name}" not found`);
      return value;
    },
  };
}

async function readGauge(gauge: promClient.Gauge, pool: string): Promise<number> {
  const data = await gauge.get();
  const entry = data.values.find((v) => v.labels['pool'] === pool);
  return entry?.value ?? 0;
}

describe('PoolMetricsCollector', () => {
  beforeEach((): void => {
    // Reset prom-client gauge values to 0 between tests so cross-test bleed is impossible.
    pgPoolConnectionsTotal.reset();
    pgPoolConnectionsIdle.reset();
    pgPoolConnectionsActive.reset();
    pgPoolConnectionsWaiting.reset();
  });

  afterEach((): void => {
    vi.restoreAllMocks();
    vi.useRealTimers();
  });

  it('publishes total, idle, active and waiting gauges for every registered pool', async () => {
    const source = makeSource({
      timescale: { totalConnections: 12, idleConnections: 7, waitingClients: 2 },
      cache: { totalConnections: 4, idleConnections: 4, waitingClients: 0 },
    });
    const collector = new PoolMetricsCollector(source, { collectionIntervalMs: 60_000 });
    collector.collect();

    expect(await readGauge(pgPoolConnectionsTotal, 'timescale')).toBe(12);
    expect(await readGauge(pgPoolConnectionsIdle, 'timescale')).toBe(7);
    // active = total - idle = 12 - 7 = 5
    expect(await readGauge(pgPoolConnectionsActive, 'timescale')).toBe(5);
    expect(await readGauge(pgPoolConnectionsWaiting, 'timescale')).toBe(2);

    expect(await readGauge(pgPoolConnectionsTotal, 'cache')).toBe(4);
    expect(await readGauge(pgPoolConnectionsIdle, 'cache')).toBe(4);
    expect(await readGauge(pgPoolConnectionsActive, 'cache')).toBe(0);
    expect(await readGauge(pgPoolConnectionsWaiting, 'cache')).toBe(0);
  });

  it('collects once on start() and again every interval (verified via fake timers)', (): void => {
    vi.useFakeTimers();
    const source = makeSource({
      primary: { totalConnections: 5, idleConnections: 3, waitingClients: 0 },
    });
    const collector = new PoolMetricsCollector(source, { collectionIntervalMs: 1_000 });
    const spy = vi.spyOn(source, 'getMetrics');
    collector.start();

    // start() performed one initial sync collection; advancing 5 seconds at a
    // 1-second interval should fire 5 additional ticks (+1 initial = 6 total).
    expect(spy).toHaveBeenCalledTimes(1);

    vi.advanceTimersByTime(5_000);
    expect(spy).toHaveBeenCalledTimes(6);

    collector.stop();
  });

  it('skips pools that throw and continues with the rest', async () => {
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {
      /* swallow */
    });
    const source: {
      getPoolNames: () => string[];
      getMetrics: (name: string) => PoolStatsRecord;
    } = {
      getPoolNames: (): string[] => ['broken', 'healthy'],
      getMetrics: (name: string): PoolStatsRecord => {
        if (name === 'broken') throw new Error('boom');
        return { totalConnections: 3, idleConnections: 1, waitingClients: 0 };
      },
    };

    const collector = new PoolMetricsCollector(source, { collectionIntervalMs: 60_000 });
    collector.collect();

    expect(await readGauge(pgPoolConnectionsTotal, 'broken')).toBe(0);
    expect(await readGauge(pgPoolConnectionsTotal, 'healthy')).toBe(3);
    expect(errorSpy).toHaveBeenCalled();
  });

  it('clamps negative reported stats to zero', async () => {
    const source = makeSource({
      skewed: { totalConnections: 2, idleConnections: 9, waitingClients: -1 },
    });
    const collector = new PoolMetricsCollector(source, { collectionIntervalMs: 60_000 });
    collector.collect();

    expect(await readGauge(pgPoolConnectionsTotal, 'skewed')).toBe(2);
    expect(await readGauge(pgPoolConnectionsIdle, 'skewed')).toBe(9);
    // active should never go negative
    expect(await readGauge(pgPoolConnectionsActive, 'skewed')).toBe(0);
    expect(await readGauge(pgPoolConnectionsWaiting, 'skewed')).toBe(0);
  });

  it('start() and stop() are idempotent', (): void => {
    const source = makeSource({
      a: { totalConnections: 1, idleConnections: 1, waitingClients: 0 },
    });
    const collector = new PoolMetricsCollector(source, { collectionIntervalMs: 60_000 });
    collector.start();
    collector.start();
    collector.stop();
    collector.stop();
    expect(collector.isRunning()).toBe(false);
  });
});
