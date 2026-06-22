import { getDiagnosticsTracer } from '../diagnostics/tracer.js';
import { DOMAIN_BLOCKCHAIN, TELEMETRY_DOMAIN_ATTR } from '../diagnostics/sampler.js';
import { BackoffCalculator } from './backoff.js';
import { circuitBreakerState, circuitBreakerQueueDepth } from '../../api/metrics/prometheus.js';

export enum CircuitState {
  CLOSED = 'CLOSED',
  OPEN = 'OPEN',
  HALF_OPEN = 'HALF_OPEN',
}

interface CircuitBreakerConfig {
  failureThreshold: number;
  successThreshold: number;
  timeoutMs: number;
}

const DEFAULT_CONFIG: CircuitBreakerConfig = {
  failureThreshold: 5,
  successThreshold: 2,
  timeoutMs: 30_000,
};

interface QueuedRequest {
  fn: () => Promise<{ hash: string; status: string }>;
  resolve: (value: { hash: string; status: string }) => void;
  reject: (reason?: Error) => void;
}

export class SorobanRpcClient {
  private state: CircuitState = CircuitState.CLOSED;
  private failureCount = 0;
  private successCount = 0;
  private lastFailureTime = 0;
  private config: CircuitBreakerConfig;
  private tracer = getDiagnosticsTracer();

  private readonly maxQueueSize = 10_000;
  private requestQueue: QueuedRequest[] = [];

  private processing = false;
  private backoff = new BackoffCalculator();

  private readonly clientLabel = 'soroban';
  constructor(
    private rpcUrl: string,
    config: Partial<CircuitBreakerConfig> = {},
  ) {
    this.config = { ...DEFAULT_CONFIG, ...config };
  }

  async submitTransaction(txEnvelope: string): Promise<{ hash: string; status: string }> {
    // Back‑pressure check
    if (this.requestQueue.length >= this.maxQueueSize) {
      circuitBreakerQueueDepth.set({ client: this.clientLabel }, this.requestQueue.length);
      throw new Error('Backpressure: request queue is full');
    }

    return new Promise((resolve, reject) => {
      this.requestQueue.push({
        fn: () => this._executeTx(txEnvelope),
        resolve,
        reject,
      });
      circuitBreakerQueueDepth.set({ client: this.clientLabel }, this.requestQueue.length);
      // Trigger processing if not already started
      void this.processQueue();
    });
  }

  /** Internal execution without circuit‑breaker checks */
  private async _executeTx(txEnvelope: string): Promise<{ hash: string; status: string }> {
    return this.tracer.traceAsync(
      'blockchain.submitTransaction',
      async (span) => {
        span.setAttribute('rpc.url', this.rpcUrl);
        const headers = this.tracer.injectTraceContext({
          'Content-Type': 'application/json',
        });
        const response = await fetch(`${this.rpcUrl}/transactions`, {
          method: 'POST',
          headers,
          body: JSON.stringify({ tx: txEnvelope }),
        });
        if (!response.ok) {
          throw new Error(`RPC error: ${response.statusText}`);
        }
        const result = (await response.json()) as { hash: string; status: string };
        span.setAttribute('tx.hash', result.hash);
        span.setAttribute('tx.status', result.status);
        this.onSuccess();
        return result;
      },
      { [TELEMETRY_DOMAIN_ATTR]: DOMAIN_BLOCKCHAIN },
    );
  }

  /** Process queued requests respecting circuit state */
  private async processQueue(): Promise<void> {
    if (this.processing) return;
    this.processing = true;
    while (this.requestQueue.length > 0) {
      if (this.state === CircuitState.OPEN) {
        const delay = this.backoff.nextDelay();
        await new Promise((r) => setTimeout(r, delay));
        // If timeout elapsed, move to HALF_OPEN
        if (Date.now() - this.lastFailureTime > this.config.timeoutMs) {
          this.state = CircuitState.HALF_OPEN;
          circuitBreakerState.set({ client: this.clientLabel }, 1);
        }
      }

      const queuedRequest = this.requestQueue.shift();
      if (!queuedRequest) continue;

      const { fn, resolve, reject } = queuedRequest;
      circuitBreakerQueueDepth.set({ client: this.clientLabel }, this.requestQueue.length);
      try {
        const result = await fn();
        resolve(result);
      } catch (e) {
        reject(e as Error);
      }

      if (this.state === CircuitState.OPEN) {
        // Stop processing further until back‑off completes
        continue;
      }
      if (this.state === CircuitState.HALF_OPEN) {
        // Only one probe allowed; exit loop
        break;
      }
    }
    this.processing = false;
  }

  /** Drain queue when circuit closes */
  private drainQueue(): void {
    if (this.state === CircuitState.CLOSED) {
      void this.processQueue();
    }
  }

  private onSuccess(): void {
    // Reset backoff on any success
    this.backoff.reset();
    // Update metrics based on state transitions
    if (this.state === CircuitState.HALF_OPEN) {
      this.successCount += 1;
      if (this.successCount >= this.config.successThreshold) {
        this.state = CircuitState.CLOSED;
        this.failureCount = 0;
        this.successCount = 0;
        circuitBreakerState.set({ client: this.clientLabel }, 0);
        // Drain any queued requests now that circuit is closed
        this.drainQueue();
      }
    } else {
      this.failureCount = 0;
    }
    // Ensure gauge reflects current state (in case of CLOSED without HALF_OPEN)
    if (this.state === CircuitState.CLOSED) {
      circuitBreakerState.set({ client: this.clientLabel }, 0);
    }
  }

  private onFailure(): void {
    this.failureCount += 1;
    this.lastFailureTime = Date.now();
    if (this.failureCount >= this.config.failureThreshold) {
      this.state = CircuitState.OPEN;
      this.successCount = 0;
      circuitBreakerState.set({ client: this.clientLabel }, 2);
    }
  }

  getState(): CircuitState {
    return this.state;
  }

  reset(): void {
    this.state = CircuitState.CLOSED;
    this.failureCount = 0;
    this.successCount = 0;
  }
}
