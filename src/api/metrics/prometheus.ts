import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import promClient from 'prom-client';

// `collectDefaultMetrics` registers a fixed set of process/runtime metrics on the
// supplied registry. Calling it more than once against the same registry throws
// "A metric with the name … has already been registered", so guard the call.
const DEFAULT_METRICS_INIT_FLAG = '__prom_default_metrics_initialized__';
type RegistryWithFlag = promClient.Registry & {
  [DEFAULT_METRICS_INIT_FLAG]?: boolean;
};
const registerRef = promClient.register as RegistryWithFlag;
if (registerRef[DEFAULT_METRICS_INIT_FLAG] !== true) {
  promClient.collectDefaultMetrics({ register: promClient.register });
  registerRef[DEFAULT_METRICS_INIT_FLAG] = true;
}

export const httpRequestDuration: promClient.Histogram = new promClient.Histogram({
  name: 'http_request_duration_ms',
  help: 'Duration of HTTP requests in ms',
  labelNames: ['method', 'route', 'status_code'],
  buckets: [1, 5, 10, 25, 50, 100, 250, 500, 1000, 2500, 5000],
});

export const ingestionCounter: promClient.Counter = new promClient.Counter({
  name: 'ingestion_packets_total',
  help: 'Total number of ingested telemetry packets',
  labelNames: ['device_id', 'status'],
});

export const blockchainTxCounter: promClient.Counter = new promClient.Counter({
  name: 'blockchain_transactions_total',
  help: 'Total Soroban transactions submitted',
  labelNames: ['status'],
});

export const circuitBreakerState: promClient.Gauge = new promClient.Gauge({
  name: 'circuit_breaker_state',
  help: 'Current circuit breaker state (0=closed, 1=half-open, 2=open)',
  labelNames: ['client'],
});

export const circuitBreakerQueueDepth: promClient.Gauge = new promClient.Gauge({
  name: 'circuit_breaker_queue_depth',
  help: 'Current number of requests queued in the circuit breaker',
  labelNames: ['client'],
});

export const noncePoolDepth: promClient.Gauge = new promClient.Gauge({
  name: 'nonce_pool_active_count',
  help: 'Active nonce reservations in the pool',
});

export const ingestionQueueDepth: promClient.Gauge = new promClient.Gauge({
  name: 'ingestion_queue_depth',
  help: 'Current ingestion task queue depth',
});

// Required GC pause buckets per issue #19: 1, 5, 10, 25, 50, 100, 250, 500 ms
export const GC_PAUSE_BUCKETS_MS = [1, 5, 10, 25, 50, 100, 250, 500] as const;

export const gcPauseDuration: promClient.Histogram = new promClient.Histogram({
  name: 'node_gc_pause_duration_ms',
  help: 'Garbage collection pause duration in ms',
  buckets: [...GC_PAUSE_BUCKETS_MS],
});

export const tenantPoolActiveConnections: promClient.Gauge = new promClient.Gauge({
  name: 'tenant_pool_active_connections',
  help: 'Active database connections per tenant sub-pool',
  labelNames: ['tenant_id'],
});

export const tenantPoolQueueDepth: promClient.Gauge = new promClient.Gauge({
  name: 'tenant_pool_queue_depth',
  help: 'Pending fair-queue requests waiting for a tenant connection',
});

export const globalPoolUtilization: promClient.Gauge = new promClient.Gauge({
  name: 'global_pool_utilization',
  help: 'Ratio of active connections to global pool maximum',
});

export const tenantPoolWaitDuration: promClient.Histogram = new promClient.Histogram({
  name: 'tenant_pool_wait_duration_ms',
  help: 'Time spent waiting for a tenant-scoped connection',
  labelNames: ['tenant_id', 'result'],
  buckets: [1, 5, 10, 25, 50, 100, 250, 500],
});

export const tenantPoolRejections: promClient.Counter = new promClient.Counter({
  name: 'tenant_pool_rejections_total',
  help: 'Connections rejected due to pool contention timeout',
  labelNames: ['tenant_id'],
});

// --- Pool metrics (per pg.Pool) ---------------------------------------------------
// Required by issue #19 for real-time monitoring of pool exhaustion.

export const pgPoolConnectionsTotal: promClient.Gauge = new promClient.Gauge({
  name: 'pg_pool_connections_total',
  help: 'Total connections in the PostgreSQL pool (created + idle + active)',
  labelNames: ['pool'],
});

export const pgPoolConnectionsIdle: promClient.Gauge = new promClient.Gauge({
  name: 'pg_pool_connections_idle',
  help: 'Idle connections currently available in the PostgreSQL pool',
  labelNames: ['pool'],
});

export const pgPoolConnectionsActive: promClient.Gauge = new promClient.Gauge({
  name: 'pg_pool_connections_active',
  help: 'Active (in-use) connections in the PostgreSQL pool (total - idle)',
  labelNames: ['pool'],
});

export const pgPoolConnectionsWaiting: promClient.Gauge = new promClient.Gauge({
  name: 'pg_pool_connections_waiting',
  help: 'Clients currently waiting for an available connection in the PostgreSQL pool',
  labelNames: ['pool'],
});

// --- Ledger synchronizer metrics -------------------------------------------------
// Required by issue #19 for monitoring ledger sync lag.

export const ledgerSyncLag: promClient.Gauge = new promClient.Gauge({
  name: 'ledger_sync_lag',
  help: 'Number of ledgers the synchronizer is behind the latest polled sequence',
  labelNames: ['sync_id'],
});

export const ledgerLastSyncedSequence: promClient.Gauge = new promClient.Gauge({
  name: 'ledger_last_synced_sequence',
  help: 'Most recent ledger sequence successfully persisted by the synchronizer',
  labelNames: ['sync_id'],
});

export const ledgerLatestPolledSequence: promClient.Gauge = new promClient.Gauge({
  name: 'ledger_latest_polled_sequence',
  help: 'Latest ledger sequence observed from RPC by the synchronizer poll loop',
  labelNames: ['sync_id'],
});

export const ledgerSyncPollErrors: promClient.Counter = new promClient.Counter({
  name: 'ledger_sync_poll_errors_total',
  help: 'Number of failed RPC polls by the ledger synchronizer',
  labelNames: ['sync_id', 'phase'],
});

// Setters -----------------------------------------------------------------------

export function setTenantPoolActiveConnections(tenantId: string, count: number): void {
  tenantPoolActiveConnections.set({ tenant_id: tenantId }, count);
}

export function setTenantPoolQueueDepth(depth: number): void {
  tenantPoolQueueDepth.set(depth);
}

export function setGlobalPoolUtilization(ratio: number): void {
  globalPoolUtilization.set(ratio);
}

export function recordTenantPoolGrant(tenantId: string, waitMs: number): void {
  tenantPoolWaitDuration.observe({ tenant_id: tenantId, result: 'granted' }, waitMs);
}

export function recordTenantPoolRejection(tenantId: string, waitMs: number): void {
  tenantPoolWaitDuration.observe({ tenant_id: tenantId, result: 'rejected' }, waitMs);
  tenantPoolRejections.inc({ tenant_id: tenantId });
}

export function recordGcPause(durationMs: number): void {
  if (Number.isFinite(durationMs) && durationMs > 0) {
    gcPauseDuration.observe(durationMs);
  }
}

export interface PoolSizeMetrics {
  total: number;
  idle: number;
  active: number;
  waiting: number;
}

export function setPgPoolConnections(poolName: string, metrics: PoolSizeMetrics): void {
  pgPoolConnectionsTotal.set({ pool: poolName }, metrics.total);
  pgPoolConnectionsIdle.set({ pool: poolName }, metrics.idle);
  pgPoolConnectionsActive.set({ pool: poolName }, metrics.active);
  pgPoolConnectionsWaiting.set({ pool: poolName }, metrics.waiting);
}

export interface LedgerSyncMetrics {
  syncId: string;
  lag: number;
  lastSyncedSequence: number | null;
  latestPolledSequence: number | null;
}

export function setLedgerSyncMetrics(metrics: LedgerSyncMetrics): void {
  const labels = { sync_id: metrics.syncId };
  ledgerSyncLag.set(labels, Math.max(0, metrics.lag));
  if (metrics.lastSyncedSequence !== null) {
    ledgerLastSyncedSequence.set(labels, metrics.lastSyncedSequence);
  }
  if (metrics.latestPolledSequence !== null) {
    ledgerLatestPolledSequence.set(labels, metrics.latestPolledSequence);
  }
}

export function recordLedgerSyncPollError(syncId: string, phase: 'poll' | 'fetch'): void {
  ledgerSyncPollErrors.inc({ sync_id: syncId, phase });
}

// Metrics endpoint -------------------------------------------------------------

export function getMetricsRegistry(): promClient.Registry {
  return promClient.register;
}

export function getMetricsContentType(): string {
  return promClient.register.contentType;
}

export function getMetrics(): Promise<string> {
  return promClient.register.metrics();
}

/**
 * Register the `GET /metrics` endpoint that returns Prometheus text format.
 *
 * The handler is intentionally cheap: it merely stringifies the in-memory
 * counter/gauge/histogram snapshot, with no I/O. The endpoint is expected to
 * respond in well under the 10ms budget required by issue #19 even at
 * 10k scrapes/min (≈166/s).
 */
export function registerMetricsRoute(app: FastifyInstance, path = '/metrics'): void {
  app.get(path, async (_request: FastifyRequest, reply: FastifyReply) => {
    const body = await getMetrics();
    void reply.header('Content-Type', getMetricsContentType());
    void reply.header('Cache-Control', 'no-store');
    return reply.send(body);
  });
}
