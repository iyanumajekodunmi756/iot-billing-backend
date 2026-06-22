/**
 * Mock Ingestion Gateway + Mock Soroban RPC for the load suite.
 *
 * This server is the load target for issue #20. It exposes:
 *   - `POST /ingest`        : the ingestion endpoint devices hit. The
 *                             handler runs the SAME `createValidator`
 *                             + `InMemoryNonceCache` code path used in
 *                             production, so any load time spent
 *                             exercising it is meaningful end-to-end.
 *   - `GET  /ledgers/...`   : mock Soroban RPC routes for the ledger
 *                             synchronizer to read against.
 *   - `POST /transactions`  : mock Soroban transaction submission.
 *   - `GET  /health`        : cheap liveness probe for the runner.
 *   - `GET  /_stats`        : tally of accepted/rejected counters that
 *                             the runner cross-checks against its own
 *                             client-side tally.
 *
 * Configurable latency (mean + jitter) and per-route failure rates let
 * any profile inject realistic Soroban-network noise without depending
 * on external services.
 */

import { Buffer } from 'node:buffer';
import Fastify, { type FastifyInstance } from 'fastify';
import {
  createValidator,
  InMemoryNonceCache,
  type NonceCache,
  type SignedPayload,
} from '../../src/core/ingestion/validator.js';
import {
  type MockServerOptions,
  DEFAULT_MOCK_OPTIONS,
  type SignedTelemetryPayload,
  type IngestRequestBody,
} from './lib/types.js';

interface MockServerDependencies {
  nonceCache: NonceCache;
  ledgerSequence: number;
}

/**
 * Apply the configured mean + jitter latency. Jitter is uniform around
 * the mean in the [-jitter, +jitter] band, clamped to zero so a negative
 * delay never happens.
 */
function delayMs(mean: number, jitter: number): number {
  if (mean <= 0) return 0;
  const offset = jitter === 0 ? 0 : (Math.random() * 2 - 1) * jitter * mean;
  return Math.max(0, mean + offset);
}

function shouldFail(rate: number): boolean {
  return rate > 0 && Math.random() < rate;
}

export interface StartedMockServer {
  app: FastifyInstance;
  host: string;
  port: number;
  url: string;
  start(): Promise<void>;
  stop(): Promise<void>;
  stats(): { accepted: number; rejected: number; errors: number };
}

export async function buildMockServer(
  options: Partial<MockServerOptions> = {},
  deps: Partial<MockServerDependencies> = {},
): Promise<StartedMockServer> {
  const opts: MockServerOptions = { ...DEFAULT_MOCK_OPTIONS, ...options };
  const nonceCache: NonceCache = deps.nonceCache ?? new InMemoryNonceCache(opts.nonceWindowMs);
  const ledgerSequence = deps.ledgerSequence ?? 1000;

  let accepted = 0;
  let rejected = 0;
  let errors = 0;

  const validator = createValidator(nonceCache);

  const app = Fastify({
    logger: false,
    bodyLimit: 1024 * 1024,
  });

  app.get(
    '/health',
    async (): Promise<{ status: string; timestamp: number }> => ({
      status: 'ok',
      timestamp: Date.now(),
    }),
  );

  app.get(
    '/_stats',
    async (): Promise<{ accepted: number; rejected: number; errors: number }> => ({
      accepted,
      rejected,
      errors,
    }),
  );

  /**
   * POST /ingest
   *
   * Accepts either the legacy flat shape:
   *   { deviceId, timestamp, nonce, metrics, signature }
   * or the structured { payload } shape used by the load suite. We
   * tolerate both so existing tooling doesn't have to change.
   */
  app.post<{ Body: IngestRequestBody | SignedTelemetryPayload }>(
    '/ingest',
    async (request, reply) => {
      const body = request.body;

      const artificialDelay = delayMs(opts.latencyMs, opts.latencyJitter);
      if (artificialDelay > 0) {
        await new Promise<void>((resolve) => setTimeout(resolve, artificialDelay));
      }
      if (shouldFail(opts.ingestFailureRate)) {
        errors++;
        await reply.status(500).send({ error: 'Internal Server Error' });
        return;
      }

      const payload = extractPayload(body);
      if (payload === null) {
        rejected++;
        await reply.status(400).send({
          status: 'rejected',
          reason: 'malformed_body',
        });
        return;
      }

      const publicKeyHex = extractPublicKeyHex(body);
      if (publicKeyHex === null) {
        rejected++;
        await reply.status(400).send({
          status: 'rejected',
          deviceId: payload.deviceId,
          reason: 'missing_public_key',
        });
        return;
      }

      const publicKey = Buffer.from(publicKeyHex, 'hex');
      if (publicKey.length !== 32) {
        rejected++;
        await reply.status(400).send({
          status: 'rejected',
          deviceId: payload.deviceId,
          reason: 'invalid_public_key_length',
        });
        return;
      }

      const startedAt = Date.now();
      const result = await validator(publicKey, payload);
      const serverLatencyMs = Date.now() - startedAt;

      if (!result.valid) {
        rejected++;
        await reply.status(422).send({
          status: 'rejected',
          deviceId: payload.deviceId,
          reason: result.reason ?? 'invalid',
          serverLatencyMs,
        });
        return;
      }

      accepted++;
      await reply.send({
        status: 'accepted',
        deviceId: payload.deviceId,
        serverLatencyMs,
      });
    },
  );

  app.get('/ledgers/latest', async (_request, reply): Promise<void> => {
    const artificialDelay = delayMs(opts.latencyMs, opts.latencyJitter);
    if (artificialDelay > 0) {
      await new Promise<void>((resolve) => setTimeout(resolve, artificialDelay));
    }
    if (shouldFail(opts.rpcFailureRate)) {
      errors++;
      await reply.status(503).send({ error: 'Simulated upstream outage' });
      return;
    }
    await reply.send({
      sequence: ledgerSequence,
      hash: `mock-hash-${ledgerSequence.toString()}`,
      closedAt: new Date().toISOString(),
      transactions: [],
    });
  });

  app.get<{ Params: { sequence: string } }>(
    '/ledgers/:sequence',
    async (request, reply): Promise<void> => {
      const artificialDelay = delayMs(opts.latencyMs, opts.latencyJitter);
      if (artificialDelay > 0) {
        await new Promise<void>((resolve) => setTimeout(resolve, artificialDelay));
      }
      const sequence = Number.parseInt(request.params.sequence, 10);
      if (!Number.isFinite(sequence)) {
        await reply.status(400).send({ error: 'sequence must be an integer' });
        return;
      }
      if (shouldFail(opts.rpcFailureRate)) {
        errors++;
        await reply.status(503).send({ error: 'Simulated upstream outage' });
        return;
      }
      await reply.send({
        sequence,
        hash: `mock-hash-${sequence.toString()}`,
        closedAt: new Date().toISOString(),
        transactions: [`mock-tx-${sequence.toString()}`],
      });
    },
  );

  app.post('/transactions', async (_request, reply): Promise<void> => {
    const artificialDelay = delayMs(opts.latencyMs, opts.latencyJitter);
    if (artificialDelay > 0) {
      await new Promise<void>((resolve) => setTimeout(resolve, artificialDelay));
    }
    if (shouldFail(opts.rpcFailureRate)) {
      errors++;
      await reply.status(503).send({ error: 'Simulated upstream outage' });
      return;
    }
    await reply.send({
      hash: `mock-tx-${Math.floor(Math.random() * 1_000_000).toString(16)}`,
      status: 'PENDING',
    });
  });

  let running: { host: string; port: number; url: string } | null = null;

  return {
    app,
    host: opts.host,
    port: opts.port,
    get url(): string {
      if (running === null) {
        throw new Error('Mock server has not been started yet');
      }
      return running.url;
    },
    async start(): Promise<void> {
      const address = await app.listen({ port: opts.port, host: opts.host });
      const match = /:(\d+)$/.exec(address);
      const portStr = match?.[1] !== undefined ? match[1] : '';
      const boundPort = portStr !== '' ? Number.parseInt(portStr, 10) : opts.port;
      running = { host: opts.host, port: boundPort, url: address };
    },
    async stop(): Promise<void> {
      await app.close();
      running = null;
    },
    stats(): { accepted: number; rejected: number; errors: number } {
      return { accepted, rejected, errors };
    },
  };
}

function extractPayload(body: IngestRequestBody | SignedTelemetryPayload): SignedPayload | null {
  if ('payload' in body && body.payload !== undefined) {
    const candidate = body.payload;
    if (
      typeof candidate.deviceId === 'string' &&
      typeof candidate.nonce === 'string' &&
      typeof candidate.signature === 'string' &&
      typeof candidate.timestamp === 'number'
    ) {
      return candidate;
    }
    return null;
  }
  if (
    'deviceId' in body &&
    'nonce' in body &&
    'signature' in body &&
    typeof body.deviceId === 'string' &&
    typeof body.nonce === 'string' &&
    typeof body.signature === 'string'
  ) {
    return body;
  }
  return null;
}

function extractPublicKeyHex(body: IngestRequestBody | SignedTelemetryPayload): string | null {
  if ('publicKey' in body && typeof body.publicKey === 'string') {
    return body.publicKey;
  }
  return null;
}

/**
 * CLI entry: `tsx tests/load/mock_server.ts`
 *
 * Useful for debugging load issues with `curl` against a real listener.
 * Defaults listen on 127.0.0.1:4000 with no faults so a developer can
 * exercise the surface manually.
 */
async function cliEntry(): Promise<void> {
  const port = Number.parseInt(process.env['MOCK_PORT'] ?? '4000', 10);
  const latencyMs = Number.parseFloat(process.env['MOCK_LATENCY_MS'] ?? '0');
  const latencyJitter = Number.parseFloat(process.env['MOCK_LATENCY_JITTER'] ?? '0');
  const rpcFailureRate = Number.parseFloat(process.env['MOCK_RPC_FAILURE_RATE'] ?? '0');
  const ingestFailureRate = Number.parseFloat(process.env['MOCK_INGEST_FAILURE_RATE'] ?? '0');

  const server = await buildMockServer({
    port,
    host: '0.0.0.0',
    latencyMs,
    latencyJitter,
    rpcFailureRate,
    ingestFailureRate,
  });
  await server.start();
  console.log(`[mock_server] listening on ${server.url}`);

  const shutdown = async (signal: string): Promise<void> => {
    console.log(`[mock_server] received ${signal}, shutting down`);
    await server.stop();
    process.exit(0);
  };
  process.once('SIGINT', () => {
    void shutdown('SIGINT');
  });
  process.once('SIGTERM', () => {
    void shutdown('SIGTERM');
  });
}

if (process.argv[1] !== undefined && process.argv[1].endsWith('mock_server.ts')) {
  void cliEntry();
}

export { buildMockServer as default };
