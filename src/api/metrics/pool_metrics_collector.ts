import { setPgPoolConnections, type PoolSizeMetrics } from './prometheus.js';

/**
 * Snapshot of a single pool that the collector needs to update Prometheus
 * gauges. Mirrors the shape produced by `ElasticPoolManager.getMetrics(name)`.
 */
export interface PoolStats {
  totalConnections: number;
  idleConnections: number;
  waitingClients: number;
}

/**
 * Anything that exposes `getMetrics(name)` returning per-pool stats counts as
 * a source. The default implementation takes the `ElasticPoolManager` from
 * `src/database/pool_manager.ts`. Tests can pass a small stub that does not
 * require real `pg.Pool` instances.
 */
export interface PoolStatsSource {
  getMetrics(name: string): PoolStats;
  getPoolNames(): string[];
}

const DEFAULT_COLLECTION_INTERVAL_MS = 5_000;

export interface PoolMetricsCollectorOptions {
  collectionIntervalMs?: number;
}

/**
 * Periodically samples the size of every registered `pg.Pool` and updates the
 * Prometheus gauges defined in `prometheus.ts` for `pg_pool_connections_*`.
 *
 * The collector polls on a fixed interval (default 5 s, matching the
 * requirement of issue #19) rather than using a per-scrape `collect()` callback.
 * This decouples scrape latency from pool I/O and keeps the `/metrics`
 * endpoint under the 10 ms budget even at 10 k scrapes/min.
 */
export class PoolMetricsCollector {
  private readonly source: PoolStatsSource;
  private readonly poolNames: string[];
  private readonly intervalMs: number;
  private intervalHandle: ReturnType<typeof setInterval> | null = null;
  private running = false;

  constructor(source: PoolStatsSource, opts: PoolMetricsCollectorOptions = {}) {
    this.source = source;
    this.poolNames = source.getPoolNames();
    this.intervalMs = opts.collectionIntervalMs ?? DEFAULT_COLLECTION_INTERVAL_MS;
  }

  /** Begin polling. Idempotent. Performs an initial collection synchronously. */
  start(): void {
    if (this.running) return;
    this.running = true;
    this.collect();
    this.intervalHandle = setInterval(() => {
      this.collect();
    }, this.intervalMs);
    const handle = this.intervalHandle as { unref?: () => void };
    handle.unref?.();
  }

  /** Stop polling and release any pending interval. Idempotent. */
  stop(): void {
    if (!this.running) return;
    this.running = false;
    if (this.intervalHandle !== null) {
      clearInterval(this.intervalHandle);
      this.intervalHandle = null;
    }
  }

  isRunning(): boolean {
    return this.running;
  }

  /** Perform one collection cycle immediately. Useful for tests. */
  collect(): void {
    for (const name of this.poolNames) {
      let stats: PoolStats | null = null;
      try {
        stats = this.source.getMetrics(name);
      } catch (error) {
        // A pool that has not been created yet (or was just drained) should
        // not break the entire scrape — log and skip.

        console.error(
          `[PoolMetricsCollector] failed to read pool "${name}":`,
          error instanceof Error ? error.message : String(error),
        );
        continue;
      }

      const total = Math.max(0, stats.totalConnections);
      const idle = Math.max(0, stats.idleConnections);
      const waiting = Math.max(0, stats.waitingClients);
      const metrics: PoolSizeMetrics = {
        total,
        idle,
        active: Math.max(0, total - idle),
        waiting,
      };
      setPgPoolConnections(name, metrics);
    }
  }
}

/** Convenience factory. */
export function createPoolMetricsCollector(
  source: PoolStatsSource,
  opts?: PoolMetricsCollectorOptions,
): PoolMetricsCollector {
  return new PoolMetricsCollector(source, opts);
}
