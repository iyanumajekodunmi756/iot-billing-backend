/**
 * Load orchestrator that drives an arbitrary HTTP target with
 * concurrency-controlled worker promises, applies per-tick fault
 * injection (malformed / expired / duplicate), and emits a unified
 * {@link LoadMetrics} JSON after the run completes.
 *
 * This module is intentionally HTTP-flavoured - the legacy local
 * in-process `runSimulation` lives in `simulation_runner.ts` and is
 * kept untouched for backward compatibility.
 */

import { Buffer } from 'node:buffer';
import { randomUUID } from 'node:crypto';
import {
  type FaultInjectionConfig,
  type IngestResponseBody,
  type LoadMetrics,
  type LoadProfile,
  type SignedTelemetryPayload,
  DEFAULT_FAULT_INJECTION,
  computeLatencyHistogram,
} from './types.js';
import {
  generateDevice,
  buildUnsignedPayload,
  signPayload,
  rollFault,
  type SimulatedDevice,
} from './sign_payload.js';

export interface RunLoadOptions {
  profile: LoadProfile;
  targetUrl: string;
  concurrentClients: number;
  durationSec: number;
  payloadsPerSec: number;
  faultInjection?: Partial<FaultInjectionConfig>;
  /**
   * Optional P99 latency target in ms. Used to fill the `targets` block
   * on the resulting metrics object. Defaults to 500 (the issue spec).
   */
  p99TargetMs?: number;
  /**
   * Optional logger hook. Defaults to silent.
   */
  log?: (msg: string) => void;
  /**
   * Skip the `/health` readiness probe. Useful in unit tests where the
   * 5s connect-timeout floor would inflate wall-clock time. Defaults
   * to false (probe runs).
   */
  skipHealthCheck?: boolean;
}

interface CollectedSample {
  latencyMs: number;
  outcome: 'accepted' | 'rejected' | 'error';
  reason?: string;
}

const CONNECT_TIMEOUT_MS = 5_000;
const READ_TIMEOUT_MS = 10_000;
/**
 * Once the wall-clock deadline has elapsed, workers get a small grace
 * window to finish their final iteration. The grace window matters
 * because Node's fetch (Undici) can deadlock its global agent under
 * the load suite's concurrent requests; an absolute deadline-relative
 * abort guarantees `Promise.all` resolves instead of hanging the test
 * runner.
 */
const WORKER_GRACE_MS = 2_000;
const INGEST_PATH = '/ingest';

/**
 * Resolve the ingestion URL from whatever targetUrl string the caller
 * supplies (with optional path) so workers always POST to /ingest.
 * Accepts both `http://host:port` and `http://host:port/whatever`.
 */
function ingestUrl(targetUrl: string): string {
  const base = new URL(targetUrl);
  // Strip path/query so we don't double up if the caller already
  // appended a trailing segment.
  base.pathname = INGEST_PATH;
  base.search = '';
  return base.toString();
}

/**
 * Build a {@link RequestInit} that targets the ingestion endpoint.
 * Centralising this lets us swap query params / headers for profile
 * variants (e.g. mTLS client certs) without touching the worker loop.
 *
 * Headers are deliberately kept minimal. The default transport
 * (Undici in Node 22) computes the correct Content-Length automatically
 * for a string body. Manually setting either `Connection: close` or
 * `Content-Length` produced spurious 422 responses under concurrent
 * load against the Fastify mock server.
 */
function buildFetchOptions(body: string, signal: AbortSignal): RequestInit {
  return {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
    },
    body,
    signal,
  };
}

async function postOnce(
  url: string,
  body: string,
  perCallTimeoutMs: number,
  globalSignal: AbortSignal,
): Promise<{
  ok: boolean;
  status: number;
  latencyMs: number;
  parsed?: IngestResponseBody;
  errorReason?: string;
}> {
  const controller = new AbortController();
  const timeout = setTimeout(() => {
    controller.abort();
  }, perCallTimeoutMs);
  const onGlobalAbort = (): void => {
    controller.abort();
  };
  if (globalSignal.aborted) {
    controller.abort();
  } else {
    globalSignal.addEventListener('abort', onGlobalAbort, { once: true });
  }
  const startedAt = performance.now();
  try {
    const response = await fetch(
      url,
      buildFetchOptions(body, AbortSignal.any([controller.signal, globalSignal])),
    );
    const latencyMs = performance.now() - startedAt;
    let parsed: IngestResponseBody | undefined;
    try {
      parsed = (await response.json()) as IngestResponseBody;
    } catch {
      parsed = undefined;
    }
    return {
      ok: response.ok,
      status: response.status,
      latencyMs,
      parsed,
    };
  } catch (err) {
    const latencyMs = performance.now() - startedAt;
    const errorReason = err instanceof Error ? err.name : 'unknown_error';
    return { ok: false, status: 0, latencyMs, errorReason };
  } finally {
    clearTimeout(timeout);
    globalSignal.removeEventListener('abort', onGlobalAbort);
  }
}

async function driveWorker(
  device: SimulatedDevice,
  cfg: Required<
    Omit<RunLoadOptions, 'log' | 'p99TargetMs' | 'faultInjection' | 'skipHealthCheck'>
  > & {
    faultInjection: FaultInjectionConfig;
  },
  collected: CollectedSample[],
  startedAtMs: number,
  deadlineMs: number,
  globalSignal: AbortSignal,
  log: (msg: string) => void,
): Promise<void> {
  const tickIntervalMs = Math.max(1, Math.floor(1000 / cfg.payloadsPerSec));
  const ingestEndpoint = ingestUrl(cfg.targetUrl);
  let lastNonce: string = randomUUID();

  while (!globalSignal.aborted) {
    const elapsedMs = Date.now() - startedAtMs;
    if (elapsedMs >= deadlineMs) {
      return;
    }

    const fault = rollFault(Math.random(), cfg.faultInjection);
    let payload: SignedTelemetryPayload;
    if (fault === 'malformed') {
      payload = generateMalformedPayload(device);
    } else if (fault === 'expired') {
      payload = signPayload(
        device,
        buildUnsignedPayload(device, { timestampOverrideMs: Date.now() - 60_000 }),
      );
    } else if (fault === 'duplicate') {
      const replayPayload = signPayload(
        device,
        buildUnsignedPayload(device, { nonceOverride: lastNonce }),
      );
      lastNonce = replayPayload.nonce;
      const replayBody = JSON.stringify({
        payload: replayPayload,
        publicKey: device.publicKeyHex,
      });
      const firstResponse = await postOnce(
        ingestEndpoint,
        replayBody,
        READ_TIMEOUT_MS,
        globalSignal,
      );
      collected.push({
        latencyMs: firstResponse.latencyMs,
        outcome:
          firstResponse.ok && firstResponse.parsed?.status === 'accepted' ? 'accepted' : 'rejected',
        reason: firstResponse.parsed?.reason ?? statusReason(firstResponse.status),
      });
      const secondResponse = await postOnce(
        ingestEndpoint,
        replayBody,
        READ_TIMEOUT_MS,
        globalSignal,
      );
      collected.push({
        latencyMs: secondResponse.latencyMs,
        outcome:
          secondResponse.ok && secondResponse.parsed?.status === 'accepted'
            ? 'accepted'
            : 'rejected',
        reason: secondResponse.parsed?.reason ?? statusReason(secondResponse.status),
      });
      await sleepTick(tickIntervalMs, startedAtMs, deadlineMs, globalSignal);
      continue;
    } else {
      payload = signPayload(device, buildUnsignedPayload(device));
      lastNonce = payload.nonce;
    }

    const body = JSON.stringify({ payload, publicKey: device.publicKeyHex });
    const response = await postOnce(ingestEndpoint, body, READ_TIMEOUT_MS, globalSignal);

    let outcome: CollectedSample['outcome'];
    let reason: string | undefined;
    if (response.ok && response.parsed?.status === 'accepted') {
      outcome = 'accepted';
    } else if (response.parsed?.status === 'rejected') {
      outcome = 'rejected';
      reason = response.parsed.reason;
    } else if (response.status === 0) {
      outcome = 'error';
      reason = response.errorReason ?? 'network_error';
    } else {
      outcome = 'rejected';
      reason = statusReason(response.status);
    }

    collected.push({ latencyMs: response.latencyMs, outcome, reason });
    if (outcome !== 'accepted') {
      log(`[${cfg.profile}] ${payload.deviceId} ${outcome} (${reason ?? 'n/a'})`);
    }

    await sleepTick(tickIntervalMs, startedAtMs, deadlineMs, globalSignal);
  }
}

function statusReason(status: number): string {
  if (status === 0) return 'transport';
  if (status >= 500) return 'server_error';
  return `http_${status.toString()}`;
}

async function sleepTick(
  tickMs: number,
  startedAtMs: number,
  deadlineMs: number,
  globalSignal: AbortSignal,
): Promise<void> {
  const remaining = deadlineMs - (Date.now() - startedAtMs);
  if (remaining <= 0) return;
  const sleep = Math.min(tickMs, remaining);
  await Promise.race([
    new Promise<void>((resolve) => setTimeout(resolve, sleep)),
    new Promise<void>((resolve) => {
      if (globalSignal.aborted) {
        resolve();
        return;
      }
      globalSignal.addEventListener(
        'abort',
        () => {
          resolve();
        },
        { once: true },
      );
    }),
  ]);
}

function generateMalformedPayload(device: SimulatedDevice): SignedTelemetryPayload {
  const randomBytes = Buffer.from(new Uint8Array(64));
  for (let i = 0; i < 64; i++) {
    randomBytes[i] = Math.floor(Math.random() * 256);
  }
  return {
    deviceId: device.deviceId,
    timestamp: Date.now(),
    nonce: randomUUID(),
    metrics: {
      energy_kwh: Math.random() * 100,
      water_l: Math.random() * 50,
      gas_m3: Math.random() * 20,
      temperature: 15 + Math.random() * 30,
    },
    signature: randomBytes.toString('hex'),
  };
}

export async function runLoad(opts: RunLoadOptions): Promise<LoadMetrics> {
  const log = opts.log ?? ((): void => undefined);
  const faultInjection: FaultInjectionConfig = {
    ...DEFAULT_FAULT_INJECTION,
    ...(opts.faultInjection ?? {}),
  };
  const startedAt = new Date();
  const startedAtMs = startedAt.getTime();
  const deadlineMs = startedAtMs + opts.durationSec * 1000;
  const collected: CollectedSample[] = [];

  if (opts.concurrentClients < 1) {
    throw new Error('concurrentClients must be >= 1');
  }
  if (opts.payloadsPerSec < 1) {
    throw new Error('payloadsPerSec must be >= 1');
  }

  if (opts.skipHealthCheck !== true) {
    await assertTargetReachable(opts.targetUrl);
  }

  const cfg = {
    profile: opts.profile,
    targetUrl: opts.targetUrl,
    concurrentClients: opts.concurrentClients,
    durationSec: opts.durationSec,
    payloadsPerSec: opts.payloadsPerSec,
    faultInjection,
  };

  const globalAbort = new AbortController();
  const totalTimeoutMs = opts.durationSec * 1000 + WORKER_GRACE_MS;
  const globalTimeout = setTimeout(() => {
    globalAbort.abort();
  }, totalTimeoutMs);

  const workers: Promise<void>[] = [];
  try {
    for (let i = 0; i < opts.concurrentClients; i++) {
      const device = generateDevice(i);
      const worker = driveWorker(
        device,
        cfg,
        collected,
        startedAtMs,
        deadlineMs,
        globalAbort.signal,
        log,
      );
      workers.push(worker);
    }
    await Promise.all(workers);
  } finally {
    clearTimeout(globalTimeout);
    globalAbort.abort();
  }

  const finishedAt = new Date();
  const totalLatencies: number[] = [];

  let accepted = 0;
  let rejected = 0;
  let errors = 0;
  const rejectionsByReason: Record<string, number> = {};

  for (const sample of collected) {
    if (sample.latencyMs > 0) {
      totalLatencies.push(sample.latencyMs);
    }
    if (sample.outcome === 'accepted') {
      accepted += 1;
    } else if (sample.outcome === 'rejected') {
      rejected += 1;
      const key = sample.reason ?? 'unspecified';
      rejectionsByReason[key] = (rejectionsByReason[key] ?? 0) + 1;
    } else {
      errors += 1;
      const key = sample.reason ?? 'transport';
      rejectionsByReason[key] = (rejectionsByReason[key] ?? 0) + 1;
    }
  }

  const durationSec = (finishedAt.getTime() - startedAtMs) / 1000;
  const totalPayloads = accepted + rejected + errors;
  const errorRate = totalPayloads === 0 ? 0 : (rejected + errors) / totalPayloads;
  const completed = accepted + rejected;
  const latency = computeLatencyHistogram(totalLatencies);

  return {
    profile: opts.profile,
    startedAt: startedAt.toISOString(),
    finishedAt: finishedAt.toISOString(),
    durationSec,
    concurrentClients: opts.concurrentClients,
    faultInjection,
    totalPayloads,
    accepted,
    rejected,
    errors,
    errorRate,
    throughputPerSec: durationSec > 0 ? accepted / durationSec : 0,
    completedPerSec: durationSec > 0 ? completed / durationSec : 0,
    latency,
    rejectionsByReason,
    targets: {
      p99LatencyMs: opts.p99TargetMs ?? 500,
      p99Met: latency.p99Ms <= (opts.p99TargetMs ?? 500),
      durationSec: opts.durationSec,
      durationMet: durationSec >= opts.durationSec * 0.95,
    },
  };
}

export function profileDefaults(profile: LoadProfile): Pick<RunLoadOptions, 'payloadsPerSec'> {
  switch (profile) {
    case 'steady_state':
      return { payloadsPerSec: 1 };
    case 'burst':
      return { payloadsPerSec: 8 };
    case 'recovery':
      return { payloadsPerSec: 0.25 };
    case 'local':
      return { payloadsPerSec: 1 };
  }
}

async function assertTargetReachable(url: string): Promise<void> {
  const controller = new AbortController();
  const timeout = setTimeout(() => {
    controller.abort();
  }, CONNECT_TIMEOUT_MS);
  try {
    const healthUrl = new URL('/health', url).toString();
    const response = await fetch(healthUrl, { signal: controller.signal });
    if (response.status >= 500) {
      throw new Error(`Target health endpoint returned ${response.status.toString()}`);
    }
  } catch (err) {
    throw new Error(
      `Target ${url} is unreachable: ${err instanceof Error ? err.message : String(err)}`,
    );
  } finally {
    clearTimeout(timeout);
  }
}
