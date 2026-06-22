/**
 * Shared types for the high-density concurrent load testing suite.
 *
 * The schemas defined here are the single source of truth for the JSON
 * metrics emitted by every runner profile (steady_state / burst / recovery,
 * local + k6 modes). Downstream tooling (k6, Prometheus, CI smoke tests)
 * depends on this shape staying stable.
 */

export interface SignedTelemetryPayload {
  deviceId: string;
  timestamp: number;
  nonce: string;
  metrics: Record<string, number | string>;
  signature: string;
}

/**
 * Narrowed request body accepted by the mock ingestion gateway. We
 * tolerate both shapes:
 *   - structured: { payload: SignedTelemetryPayload, publicKey?: string }
 *   - flat:       SignedTelemetryPayload directly (kept for legacy clients)
 */
export type IngestBody = IngestRequestBody | SignedTelemetryPayload;

/** Legacy metrics shape used by in-process `runSimulation`. */
export interface SimulationMetrics {
  totalPayloads: number;
  accepted: number;
  rejected: number;
  errors: number;
  avgLatencyMs: number;
  p95LatencyMs: number;
  p99LatencyMs: number;
  throughputPerSec: number;
}

export interface IngestResponseBody {
  status: 'accepted' | 'rejected';
  deviceId: string;
  reason?: string;
  /** Server-reported processing latency in milliseconds (excluding network). */
  serverLatencyMs?: number;
}

export interface IngestRequestBody {
  payload: SignedTelemetryPayload;
  /** Public key as Stellar G... address. Optional in tolerant mode. */
  publicKey?: string;
}

export type LoadProfile = 'steady_state' | 'burst' | 'recovery' | 'local';

export interface ProfileConfig {
  profile: LoadProfile;
  /** Total virtual clients / devices. */
  concurrentClients: number;
  /** Wall-clock duration of the profile, in seconds. */
  durationSec: number;
  /** Optional individual payload rate, in payloads/sec/device. */
  payloadsPerSec?: number;
  /** Fault injection probabilities. Defaults match issue #20. */
  faultInjection?: Partial<FaultInjectionConfig>;
}

export interface FaultInjectionConfig {
  /** Probability of generating a structurally invalid signed payload. Default 0.01 (1%). */
  malformedRate: number;
  /** Probability of generating a payload whose timestamp is outside the sliding window. Default 0.005 (0.5%). */
  expiredRate: number;
  /** Probability of duplicating a nonce so the second submission is a replay. Default 0.001 (0.1%). */
  duplicateRate: number;
}

export const DEFAULT_FAULT_INJECTION: FaultInjectionConfig = {
  malformedRate: 0.01,
  expiredRate: 0.005,
  duplicateRate: 0.001,
};

export interface LatencyHistogram {
  p50Ms: number;
  p90Ms: number;
  p95Ms: number;
  p99Ms: number;
  minMs: number;
  maxMs: number;
  avgMs: number;
  /** Number of samples contributing to the histogram. */
  sampleCount: number;
}

export interface LoadMetrics {
  profile: LoadProfile;
  startedAt: string;
  finishedAt: string;
  durationSec: number;
  concurrentClients: number;
  /** Configured fault injection (post-default). */
  faultInjection: FaultInjectionConfig;
  totalPayloads: number;
  accepted: number;
  rejected: number;
  /** Network/transport-level failures (DNS, ECONNRESET, timeouts). */
  errors: number;
  errorRate: number;
  /** Successful ingestions only. */
  throughputPerSec: number;
  /** Successful + server-rejected (still completed). */
  completedPerSec: number;
  latency: LatencyHistogram;
  /** Outcome breakdown - one entry per result class. */
  rejectionsByReason: Record<string, number>;
  /** Target adherence. */
  targets: {
    p99LatencyMs: number;
    p99Met: boolean;
    durationSec: number;
    durationMet: boolean;
  };
}

export function computeLatencyHistogram(samples: readonly number[]): LatencyHistogram {
  if (samples.length === 0) {
    return {
      p50Ms: 0,
      p90Ms: 0,
      p95Ms: 0,
      p99Ms: 0,
      minMs: 0,
      maxMs: 0,
      avgMs: 0,
      sampleCount: 0,
    };
  }

  const sorted = [...samples].sort((a, b) => a - b);
  const n = sorted.length;
  const pick = (q: number): number => {
    const idx = Math.min(n - 1, Math.max(0, Math.floor(q * n)));
    return sorted[idx] ?? 0;
  };
  const sum = sorted.reduce((acc, v) => acc + v, 0);
  const first = sorted[0] ?? 0;
  const last = sorted[n - 1] ?? 0;

  return {
    p50Ms: pick(0.5),
    p90Ms: pick(0.9),
    p95Ms: pick(0.95),
    p99Ms: pick(0.99),
    minMs: first,
    maxMs: last,
    avgMs: sum / n,
    sampleCount: n,
  };
}

export interface MockServerOptions {
  port: number;
  host: string;
  /** Mean artificial latency injected before responding, in ms. */
  latencyMs: number;
  /** Jitter applied to latency, as a fraction of mean (e.g. 0.5 = ±50%). */
  latencyJitter: number;
  /** Probability of returning 500 from any RPC route. */
  rpcFailureRate: number;
  /** Probability of returning 500 from /ingest (independent of validation). */
  ingestFailureRate: number;
  /** Window in ms for which a nonce is considered valid after first use. */
  nonceWindowMs: number;
}

export const DEFAULT_MOCK_OPTIONS: MockServerOptions = {
  port: 0,
  host: '127.0.0.1',
  latencyMs: 0,
  latencyJitter: 0,
  rpcFailureRate: 0,
  ingestFailureRate: 0,
  nonceWindowMs: 5000,
};
