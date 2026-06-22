import { fileURLToPath } from 'node:url';
import type { FastifyInstance } from 'fastify';
import Fastify from 'fastify';
import cors from '@fastify/cors';
import { PrismaClient } from '@prisma/client';
import { getEnv } from '../config/env.js';
import { initTelemetry, shutdownTelemetry } from '../core/diagnostics/otel.js';
import { registerAuthRoutes } from './routes/auth.js';
import { registerAnalyticsRoutes } from './routes/analytics.js';
import { registerAdminRoutes } from './routes/admin.js';
import { registerTracingHooks } from './middleware/tracing.js';
import {
  TelemetryNotificationListener,
  closeTimescalePool,
  getSharedPoolManager,
  getTenantPoolProxy,
  type ElasticPoolManager,
} from '../database/pool_manager.js';
import {
  LedgerEventSynchronizer,
  type LedgerPollEvent,
} from '../core/blockchain/event_listener.js';
import {
  recordLedgerSyncPollError,
  registerMetricsRoute,
  setLedgerSyncMetrics,
} from './metrics/prometheus.js';
import { registerCircuitHealth } from './health.js';
import { GcPauseMonitor } from './metrics/gc_monitor.js';
import { PoolMetricsCollector } from './metrics/pool_metrics_collector.js';

const DEFAULT_LEDGER_SYNC_ID = 'primary';

export async function buildApp(): Promise<FastifyInstance> {
  const env = getEnv();

  const app = Fastify({
    logger: true,
    bodyLimit: env.MAX_PAYLOAD_SIZE_BYTES,
  });

  registerTracingHooks(app);

  await app.register(cors, {
    origin: true,
    credentials: true,
  });

  app.get('/health', (): { status: string; timestamp: number } => {
    return { status: 'ok', timestamp: Date.now() };
  });

  // Issue #19: expose Prometheus scrape endpoint before any business routes
  // so dashboards can begin collecting immediately on boot.
  registerMetricsRoute(app);

  registerAuthRoutes(app);
  registerAnalyticsRoutes(app);
  registerCircuitHealth(app);

  return app;
}

async function start(): Promise<void> {
  initTelemetry();

  const env = getEnv();
  const app = await buildApp();

  const prisma = new PrismaClient();

  // Ensure the timescale pool is created so it shows up on Prometheus gauges
  // before any traffic arrives.
  getTenantPoolProxy();

  const synchronizer = new LedgerEventSynchronizer(prisma, env.SOROBAN_RPC_URL, {
    startingLedger: env.LEDGER_START,
    concurrency: env.LEDGER_SYNC_CONCURRENCY,
    // Wire issue #19 ledger_sync_lag metrics updates on every successful poll.
    onPoll: (event: LedgerPollEvent): void => {
      setLedgerSyncMetrics({
        syncId: DEFAULT_LEDGER_SYNC_ID,
        lag: event.lag,
        lastSyncedSequence: event.lastSyncedLedger,
        latestPolledSequence: event.latestSequence,
      });
    },
    onPollError: (): void => {
      recordLedgerSyncPollError(DEFAULT_LEDGER_SYNC_ID, 'poll');
    },
  });

  registerAdminRoutes(app, synchronizer);

  const listener = new TelemetryNotificationListener();
  await listener.start();
  await synchronizer.start();

  // Issue #19: start the GC and pool metrics collectors. Both `unref()` their
  // intervals so they never block graceful shutdown.
  const gcMonitor = new GcPauseMonitor();
  gcMonitor.start();

  const poolManager: ElasticPoolManager = getSharedPoolManager();
  const poolCollector = new PoolMetricsCollector(poolManager);
  poolCollector.start();

  const shutdown = async (signal: string): Promise<void> => {
    app.log.info(`Received ${signal}, shutting down`);
    synchronizer.stop();
    gcMonitor.stop();
    poolCollector.stop();
    await listener.stop();
    await closeTimescalePool();
    await app.close();
    await prisma.$disconnect();
    await shutdownTelemetry();
    process.exit(0);
  };

  process.once('SIGINT', () => {
    void shutdown('SIGINT');
  });
  process.once('SIGTERM', () => {
    void shutdown('SIGTERM');
  });

  try {
    await app.listen({ port: env.PORT, host: env.HOST });
    console.log(`Server running on ${env.HOST}:${String(env.PORT)}`);
  } catch (err) {
    app.log.error(err);
    synchronizer.stop();
    gcMonitor.stop();
    poolCollector.stop();
    await listener.stop();
    await closeTimescalePool();
    await prisma.$disconnect();
    await shutdownTelemetry();
    process.exit(1);
  }
}

const isDirectEntry =
  process.argv[1] !== undefined && process.argv[1] === fileURLToPath(import.meta.url);

if (isDirectEntry) {
  void start();
}
