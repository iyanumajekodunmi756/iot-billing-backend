import pg from 'pg';
import { getEnv } from '../config/env.js';
import {
  recordTenantPoolGrant,
  recordTenantPoolRejection,
  setGlobalPoolUtilization,
  setTenantPoolActiveConnections,
  setTenantPoolQueueDepth,
} from '../api/metrics/prometheus.js';

export const TENANT_MIN_CONNECTIONS = 2;
export const TENANT_MAX_CONNECTIONS = 10;
export const GLOBAL_MIN_CONNECTIONS = 10;
export const GLOBAL_MAX_CONNECTIONS = 200;
export const CONNECTION_WAIT_TIMEOUT_MS = 500;

interface PoolMetrics {
  totalConnections: number;
  idleConnections: number;
  waitingClients: number;
  utilization: number;
}

interface QueuedConnectionRequest {
  tenantId: string;
  resolve: (client: pg.PoolClient) => void;
  reject: (error: Error) => void;
  enqueuedAt: number;
}

export class PoolContentionError extends Error {
  readonly tenantId: string;
  readonly waitMs: number;

  constructor(tenantId: string, waitMs: number) {
    super(`Connection pool contention for tenant "${tenantId}" after ${String(waitMs)}ms`);
    this.name = 'PoolContentionError';
    this.tenantId = tenantId;
    this.waitMs = waitMs;
  }
}

export function tenantSchemaName(tenantId: string): string {
  const sanitized = tenantId.replace(/[^a-zA-Z0-9_]/g, '').slice(0, 48);
  if (sanitized.length === 0) {
    throw new Error('Invalid tenant id');
  }
  return `tenant_${sanitized}`;
}

export class ElasticPoolManager {
  private pools = new Map<string, pg.Pool>();
  private globalMinConnections = GLOBAL_MIN_CONNECTIONS;
  private globalMaxConnections = GLOBAL_MAX_CONNECTIONS;

  createPool(name: string, config: pg.PoolConfig): pg.Pool {
    const pool = new pg.Pool({
      min: this.globalMinConnections,
      max: this.globalMaxConnections,
      ...config,
    });

    pool.on('error', (err: Error) => {
      console.error(`Pool "${name}" error:`, err);
    });

    this.pools.set(name, pool);
    return pool;
  }

  getPool(name: string): pg.Pool | undefined {
    return this.pools.get(name);
  }

  /**
   * Returns the names of every pool currently registered with this manager.
   * Used by the Prometheus pool-metrics collector to iterate over all pools
   * (see src/api/metrics/pool_metrics_collector.ts).
   */
  getPoolNames(): string[] {
    return Array.from(this.pools.keys());
  }

  getGlobalMin(): number {
    return this.globalMinConnections;
  }

  getGlobalMax(): number {
    return this.globalMaxConnections;
  }

  getMetrics(name: string): PoolMetrics {
    const pool = this.pools.get(name);
    if (!pool) throw new Error(`Pool "${name}" not found`);

    const total = pool.totalCount;
    const idle = pool.idleCount;
    const waiting = pool.waitingCount;
    const utilization = total > 0 ? (total - idle) / total : 0;

    return {
      totalConnections: total,
      idleConnections: idle,
      waitingClients: waiting,
      utilization,
    };
  }

  async drainAll(): Promise<void> {
    for (const [name, pool] of this.pools) {
      await pool.end();
      console.log(`Pool "${name}" drained`);
    }
    this.pools.clear();
  }

  adjustPoolSize(min: number, max: number): void {
    if (min < GLOBAL_MIN_CONNECTIONS || min > GLOBAL_MAX_CONNECTIONS) {
      throw new Error(
        `Global min must be between ${String(GLOBAL_MIN_CONNECTIONS)} and ${String(GLOBAL_MAX_CONNECTIONS)}`,
      );
    }
    if (max < GLOBAL_MIN_CONNECTIONS || max > GLOBAL_MAX_CONNECTIONS) {
      throw new Error(
        `Global max must be between ${String(GLOBAL_MIN_CONNECTIONS)} and ${String(GLOBAL_MAX_CONNECTIONS)}`,
      );
    }
    if (min > max) {
      throw new Error('Global min cannot exceed global max');
    }
    this.globalMinConnections = min;
    this.globalMaxConnections = max;
  }
}

export class TenantAwarePoolProxy {
  private readonly poolName: string;
  private readonly manager: ElasticPoolManager;
  private readonly tenantActive = new Map<string, number>();
  private readonly waitQueue: QueuedConnectionRequest[] = [];
  private readonly fairOrder: string[] = [];
  private globalActive = 0;
  private processing = false;

  constructor(manager: ElasticPoolManager, poolName: string) {
    this.manager = manager;
    this.poolName = poolName;
  }

  getTenantActiveCount(tenantId: string): number {
    return this.tenantActive.get(tenantId) ?? 0;
  }

  getGlobalActiveCount(): number {
    return this.globalActive;
  }

  getQueueDepth(): number {
    return this.waitQueue.length;
  }

  connect(tenantId: string): Promise<pg.PoolClient> {
    return new Promise((resolve, reject) => {
      this.waitQueue.push({
        tenantId,
        resolve,
        reject,
        enqueuedAt: Date.now(),
      });
      if (!this.fairOrder.includes(tenantId)) {
        this.fairOrder.push(tenantId);
      }
      this.syncMetrics();
      void this.processQueue();
    });
  }

  private syncMetrics(): void {
    setTenantPoolQueueDepth(this.waitQueue.length);
    setGlobalPoolUtilization(this.globalActive / Math.max(this.manager.getGlobalMax(), 1));
    for (const [tenantId, active] of this.tenantActive) {
      setTenantPoolActiveConnections(tenantId, active);
    }
  }

  private rejectTimedOut(now: number): void {
    for (let i = this.waitQueue.length - 1; i >= 0; i--) {
      const request = this.waitQueue[i];
      if (request === undefined) continue;
      const waitMs = now - request.enqueuedAt;
      if (waitMs >= CONNECTION_WAIT_TIMEOUT_MS) {
        this.waitQueue.splice(i, 1);
        recordTenantPoolRejection(request.tenantId, waitMs);
        request.reject(new PoolContentionError(request.tenantId, waitMs));
      }
    }
    this.compactFairOrder();
    this.syncMetrics();
  }

  private compactFairOrder(): void {
    for (let i = this.fairOrder.length - 1; i >= 0; i--) {
      const tenantId = this.fairOrder[i];
      if (tenantId === undefined) continue;
      const hasPending = this.waitQueue.some((request) => request.tenantId === tenantId);
      if (!hasPending) {
        this.fairOrder.splice(i, 1);
      }
    }
  }

  private reservedForGuarantees(excludeTenantId?: string): number {
    let reserved = 0;
    for (const [tenantId, active] of this.tenantActive) {
      if (tenantId === excludeTenantId) continue;
      if (active > 0 && active < TENANT_MIN_CONNECTIONS) {
        reserved += TENANT_MIN_CONNECTIONS - active;
      }
    }
    for (const request of this.waitQueue) {
      if (request.tenantId === excludeTenantId) continue;
      const active = this.getTenantActiveCount(request.tenantId);
      if (active < TENANT_MIN_CONNECTIONS) {
        reserved += TENANT_MIN_CONNECTIONS - active;
        break;
      }
    }
    return reserved;
  }

  private canGrant(tenantId: string): boolean {
    const tenantActive = this.getTenantActiveCount(tenantId);
    if (tenantActive >= TENANT_MAX_CONNECTIONS) {
      return false;
    }
    if (this.globalActive >= this.manager.getGlobalMax()) {
      return false;
    }
    if (tenantActive < TENANT_MIN_CONNECTIONS) {
      return true;
    }
    const reserved = this.reservedForGuarantees(tenantId);
    return this.globalActive + reserved < this.manager.getGlobalMax();
  }

  private pickNextRequest(): QueuedConnectionRequest | undefined {
    const underMinimum = this.fairOrder.filter(
      (tenantId) => this.getTenantActiveCount(tenantId) < TENANT_MIN_CONNECTIONS,
    );
    const priorityTenants = underMinimum.length > 0 ? underMinimum : [...this.fairOrder];

    for (const tenantId of priorityTenants) {
      const request = this.waitQueue.find((queued) => queued.tenantId === tenantId);
      if (request !== undefined && this.canGrant(tenantId)) {
        return request;
      }
    }
    return undefined;
  }

  private async processQueue(): Promise<void> {
    if (this.processing) return;
    this.processing = true;

    try {
      const pool = this.manager.getPool(this.poolName);
      if (!pool) {
        const error = new Error(`Pool "${this.poolName}" not found`);
        for (const request of [...this.waitQueue]) {
          request.reject(error);
        }
        this.waitQueue.length = 0;
        this.fairOrder.length = 0;
        this.syncMetrics();
        return;
      }

      while (this.waitQueue.length > 0) {
        this.rejectTimedOut(Date.now());
        if (this.waitQueue.length === 0) {
          break;
        }

        const next = this.pickNextRequest();
        if (next === undefined) {
          break;
        }

        const index = this.waitQueue.indexOf(next);
        if (index >= 0) {
          this.waitQueue.splice(index, 1);
        }
        this.compactFairOrder();

        const waitMs = Date.now() - next.enqueuedAt;
        try {
          const client = await pool.connect();
          const schema = tenantSchemaName(next.tenantId);
          await client.query(`SET search_path TO ${schema}, public`);

          this.globalActive += 1;
          this.tenantActive.set(next.tenantId, this.getTenantActiveCount(next.tenantId) + 1);

          const originalRelease = client.release.bind(client);
          let released = false;
          client.release = (releaseError?: boolean | Error): void => {
            if (released) {
              originalRelease(releaseError);
              return;
            }
            released = true;
            this.globalActive = Math.max(0, this.globalActive - 1);
            const current = this.getTenantActiveCount(next.tenantId);
            if (current <= 1) {
              this.tenantActive.delete(next.tenantId);
            } else {
              this.tenantActive.set(next.tenantId, current - 1);
            }
            originalRelease(releaseError);
            this.syncMetrics();
            void this.processQueue();
          };

          recordTenantPoolGrant(next.tenantId, waitMs);
          this.syncMetrics();
          next.resolve(client);
        } catch (error) {
          next.reject(error instanceof Error ? error : new Error(String(error)));
        }
      }
    } finally {
      this.processing = false;
      if (this.waitQueue.length > 0) {
        setTimeout(() => {
          void this.processQueue();
        }, 10);
      }
    }
  }
}

const TIMESCALE_POOL_NAME = 'timescale';

let cachedManager: ElasticPoolManager | null = null;
let cachedTenantProxy: TenantAwarePoolProxy | null = null;
let cachedTimescalePool: pg.Pool | null = null;

function getPoolManager(): ElasticPoolManager {
  if (cachedManager !== null) {
    return cachedManager;
  }
  cachedManager = new ElasticPoolManager();
  const env = getEnv();
  cachedTimescalePool = cachedManager.createPool(TIMESCALE_POOL_NAME, {
    connectionString: env.TIMESCALEDB_URL,
  });
  return cachedManager;
}

/**
 * Public accessor for the lazily-initialized pool manager singleton. The
 * Prometheus `PoolMetricsCollector` (issue #19) needs to enumerate and read
 * per-pool stats from the same instance that the rest of the app uses.
 */
export function getSharedPoolManager(): ElasticPoolManager {
  return getPoolManager();
}

export function getTenantPoolProxy(): TenantAwarePoolProxy {
  if (cachedTenantProxy !== null) {
    return cachedTenantProxy;
  }
  const manager = getPoolManager();
  cachedTenantProxy = new TenantAwarePoolProxy(manager, TIMESCALE_POOL_NAME);
  return cachedTenantProxy;
}

export function getTimescalePool(): pg.Pool {
  getPoolManager();
  if (cachedTimescalePool === null) {
    throw new Error('Timescale pool not initialized');
  }
  return cachedTimescalePool;
}

export async function closeTimescalePool(): Promise<void> {
  cachedTenantProxy = null;
  if (cachedManager !== null) {
    await cachedManager.drainAll();
    cachedManager = null;
  }
  cachedTimescalePool = null;
}

export function resetPoolManagerForTests(): void {
  cachedTenantProxy = null;
  cachedManager = null;
  cachedTimescalePool = null;
}

let lastRefreshTime = new Date(Date.now() - 60000);

interface AlignedRanges {
  min_15m: Date | null;
  max_15m: Date | null;
  min_1h: Date | null;
  max_1h: Date | null;
  min_1d: Date | null;
  max_1d: Date | null;
  min_1w: Date | null;
  max_1w: Date | null;
  min_1m: Date | null;
  max_1m: Date | null;
}

export async function refreshAggregatesAdaptively(): Promise<void> {
  const pool = getTimescalePool();
  let client: pg.PoolClient | null = null;
  try {
    client = await pool.connect();

    const query = `
      SELECT
        time_bucket('15 minutes', MIN(time)) AS min_15m,
        time_bucket('15 minutes', MAX(time)) + INTERVAL '15 minutes' AS max_15m,
        time_bucket('1 hour', MIN(time)) AS min_1h,
        time_bucket('1 hour', MAX(time)) + INTERVAL '1 hour' AS max_1h,
        time_bucket('1 day', MIN(time)) AS min_1d,
        time_bucket('1 day', MAX(time)) + INTERVAL '1 day' AS max_1d,
        time_bucket('1 week', MIN(time)) AS min_1w,
        time_bucket('1 week', MAX(time)) + INTERVAL '1 week' AS max_1w,
        time_bucket('1 month', MIN(time)) AS min_1m,
        time_bucket('1 month', MAX(time)) + INTERVAL '1 month' AS max_1m
      FROM telemetry
      WHERE ingested_at >= $1
    `;
    const res = await client.query<AlignedRanges>(query, [lastRefreshTime]);
    const row = res.rows[0];

    if (!row) {
      return;
    }

    if (row.min_15m !== null && row.max_15m !== null) {
      lastRefreshTime = new Date();

      await client.query('CALL refresh_continuous_aggregate($1, $2, $3)', [
        'fifteen_minute_device_usage',
        row.min_15m,
        row.max_15m,
      ]);

      if (row.min_1h !== null && row.max_1h !== null) {
        await client.query('CALL refresh_continuous_aggregate($1, $2, $3)', [
          'hourly_device_usage',
          row.min_1h,
          row.max_1h,
        ]);
      }
      if (row.min_1d !== null && row.max_1d !== null) {
        await client.query('CALL refresh_continuous_aggregate($1, $2, $3)', [
          'daily_device_usage',
          row.min_1d,
          row.max_1d,
        ]);
      }
      if (row.min_1w !== null && row.max_1w !== null) {
        await client.query('CALL refresh_continuous_aggregate($1, $2, $3)', [
          'weekly_device_usage',
          row.min_1w,
          row.max_1w,
        ]);
      }
      if (row.min_1m !== null && row.max_1m !== null) {
        await client.query('CALL refresh_continuous_aggregate($1, $2, $3)', [
          'monthly_device_usage',
          row.min_1m,
          row.max_1m,
        ]);
      }
    }
  } catch (error) {
    console.error('Failed to adaptively refresh continuous aggregates:', error);
  } finally {
    if (client) {
      client.release();
    }
  }
}

export class TelemetryNotificationListener {
  private client: pg.PoolClient | null = null;
  private isRunning = false;

  async start(): Promise<void> {
    if (this.isRunning) return;
    this.isRunning = true;
    await this.connectAndListen();
  }

  private async connectAndListen(): Promise<void> {
    if (!this.isRunning) return;
    const pool = getTimescalePool();
    try {
      this.client = await pool.connect();

      this.client.on('notification', (msg) => {
        if (msg.channel === 'telemetry_inserts') {
          void refreshAggregatesAdaptively();
        }
      });

      this.client.on('error', () => {
        this.reconnect();
      });

      await this.client.query('LISTEN telemetry_inserts');
    } catch (error) {
      console.error('Failed to establish database listener:', error);
      this.reconnect();
    }
  }

  private reconnect(): void {
    if (this.client) {
      try {
        this.client.release();
      } catch (err) {
        console.error('Error releasing listener client:', err);
      }
      this.client = null;
    }
    if (this.isRunning) {
      setTimeout(() => void this.connectAndListen(), 5000);
    }
  }

  async stop(): Promise<void> {
    this.isRunning = false;
    if (this.client) {
      try {
        await this.client.query('UNLISTEN telemetry_inserts');
        this.client.release();
      } catch (err) {
        console.error('Error stopping listener:', err);
      }
      this.client = null;
    }
  }
}
