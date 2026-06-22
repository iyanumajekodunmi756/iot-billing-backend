import { PerformanceObserver, monitorEventLoopDelay } from 'node:perf_hooks';
import { recordGcPause } from './prometheus.js';

/**
 * The minimum sampling resolution (in milliseconds) of the event-loop monitor.
 * Smaller values yield finer-grained samples but increase overhead. The V8
 * `monitorEventLoopDelay` value is a good proxy for GC-induced stalls even on
 * Node builds that do not expose `gc` entries to `PerformanceObserver`.
 */
const DEFAULT_LOOP_DELAY_RESOLUTION_MS = 20;

/**
 * How often (in milliseconds) we drain the event-loop delay histogram and
 * record the maximum observed delay as a GC-pause sample. 1 s is small enough
 * to keep lag low and large enough to amortize overhead.
 */
const DEFAULT_TICK_INTERVAL_MS = 1_000;

/**
 * Whether the running Node version actually exposes `gc` perf entries to a
 * `PerformanceObserver`. Determined once at module-load.
 */
const supportsGcObserver: boolean = ((): boolean => {
  try {
    const probe = new PerformanceObserver(() => {
      /* no-op */
    });
    // Some Node builds throw synchronously when 'gc' is unsupported.
    probe.observe({ type: 'gc', buffered: false });
    probe.disconnect();
    return true;
  } catch {
    return false;
  }
})();

export interface GcPauseMonitorOptions {
  loopDelayResolutionMs?: number;
  tickIntervalMs?: number;
}

/**
 * Records garbage-collection pause durations into the Prometheus
 * `node_gc_pause_duration_ms` histogram.
 *
 * Two signal sources are combined:
 *
 * 1. `PerformanceObserver({ type: 'gc', buffered: true })` — when the runtime
 *    exposes GC entries (typically with `--expose-gc`), each native GC event
 *    is observed verbatim. This is the authoritative signal.
 *
 * 2. `perf_hooks.monitorEventLoopDelay` — always available. The max delay in
 *    each tick window is a strong proxy for the worst GC-induced stall of
 *    that window and is recorded as an additional sample so dashboards are
 *    useful even on Node builds without GC observability.
 *
 * Both sources are throttled to be explicit observation calls: a single GC
 * pause therefore produces a histogram count of 1 (from the perf observer)
 * and may be matched in the same tick window by the loop-delay sample if it
 * was the dominant stall. This is intentional — the buckets are bucket
 * counters, not exclusive timers.
 */
export class GcPauseMonitor {
  private readonly resolutionMs: number;
  private readonly tickIntervalMs: number;
  private gcObserver: PerformanceObserver | null = null;
  private loopDelay: ReturnType<typeof monitorEventLoopDelay> | null = null;
  private tickHandle: ReturnType<typeof setInterval> | null = null;
  private running = false;

  constructor(options: GcPauseMonitorOptions = {}) {
    this.resolutionMs = options.loopDelayResolutionMs ?? DEFAULT_LOOP_DELAY_RESOLUTION_MS;
    this.tickIntervalMs = options.tickIntervalMs ?? DEFAULT_TICK_INTERVAL_MS;
  }

  /** Start observing GC pauses. Idempotent: subsequent calls are no-ops. */
  start(): void {
    if (this.running) return;
    this.running = true;

    this.startLoopDelayMonitor();
    this.startGcObserver();
    this.startTicker();
  }

  /** Stop observing and release all resources. Idempotent. */
  stop(): void {
    if (!this.running) {
      return;
    }
    this.running = false;

    if (this.tickHandle !== null) {
      clearInterval(this.tickHandle);
      this.tickHandle = null;
    }
    if (this.loopDelay !== null) {
      this.loopDelay.disable();
      this.loopDelay = null;
    }
    if (this.gcObserver !== null) {
      this.gcObserver.disconnect();
      this.gcObserver = null;
    }
  }

  /** True while the monitor is actively collecting samples. */
  isRunning(): boolean {
    return this.running;
  }

  /**
   * Drain the current event-loop-delay window and record the max as a
   * GC-pause proxy. Public for testability; production code lets the ticker
   * invoke this every `tickIntervalMs`.
   */
  tickForTest(): void {
    this.drainLoopDelay();
  }

  private startLoopDelayMonitor(): void {
    try {
      this.loopDelay = monitorEventLoopDelay({ resolution: this.resolutionMs });
      this.loopDelay.enable();
    } catch {
      // Very old Node versions (rare in practice) might throw on
      // monitorEventLoopDelay; fall back to just the GC observer.
      this.loopDelay = null;
    }
  }

  private startGcObserver(): void {
    if (!supportsGcObserver) return;
    try {
      this.gcObserver = new PerformanceObserver((list) => {
        for (const entry of list.getEntries()) {
          // Performance GC entries come back with `entryType === 'gc'` and a
          // `duration` in milliseconds; ignore anything malformed.
          if (entry.entryType === 'gc' && entry.duration > 0) {
            recordGcPause(entry.duration);
          }
        }
      });
      this.gcObserver.observe({ type: 'gc', buffered: false });
    } catch {
      this.gcObserver = null;
    }
  }

  private startTicker(): void {
    if (this.loopDelay === null) return;
    this.tickHandle = setInterval(() => {
      this.drainLoopDelay();
    }, this.tickIntervalMs);
    // Background collectors must never block process exit.
    const handle = this.tickHandle as { unref?: () => void };
    handle.unref?.();
  }

  private drainLoopDelay(): void {
    if (this.loopDelay === null) return;
    const maxNs = this.loopDelay.max;
    // `max` is initially +Infinity before any sample is taken; treat as no-op.
    if (Number.isFinite(maxNs) && maxNs > 0) {
      recordGcPause(maxNs / 1_000_000);
    }
    this.loopDelay.reset();
  }
}

/** Convenience factory — tests can pass overrides, production uses defaults. */
export function createGcPauseMonitor(options: GcPauseMonitorOptions = {}): GcPauseMonitor {
  return new GcPauseMonitor(options);
}
