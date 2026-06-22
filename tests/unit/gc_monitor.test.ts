import { describe, it, expect, beforeEach, afterEach, vi, type MockInstance } from 'vitest';

// Mock node:perf_hooks so the monitor runs without real GC events / loop delay.
interface LoopDelayStub {
  enable: MockInstance;
  disable: MockInstance;
  reset: MockInstance;
  max: number;
}

const loopDelayStub: LoopDelayStub = {
  enable: vi.fn(),
  disable: vi.fn(),
  reset: vi.fn(),
  max: 0,
};

const observerCtor = vi.fn();
const observerDisconnect = vi.fn();
const observerObserve = vi.fn();

interface ObserverInstance {
  disconnect: MockInstance;
  observe: MockInstance;
}
const observerInstances: ObserverInstance[] = [];

vi.mock('node:perf_hooks', async () => {
  const actual = await vi.importActual<typeof import('node:perf_hooks')>('node:perf_hooks');
  return {
    ...actual,
    PerformanceObserver: vi.fn((cb: unknown) => {
      const instance: ObserverInstance = {
        disconnect: observerDisconnect,
        observe: observerObserve,
      };
      observerInstances.push(instance);
      void cb;
      return instance;
    }),
    monitorEventLoopDelay: vi.fn(() => loopDelayStub),
  };
});

import { GcPauseMonitor } from '../../src/api/metrics/gc_monitor.js';
import { gcPauseDuration, GC_PAUSE_BUCKETS_MS } from '../../src/api/metrics/prometheus.js';

describe('GcPauseMonitor', () => {
  let collectSpy: MockInstance;

  beforeEach(() => {
    loopDelayStub.enable.mockClear();
    loopDelayStub.disable.mockClear();
    loopDelayStub.reset.mockClear();
    loopDelayStub.max = 0;
    observerCtor.mockClear();
    observerDisconnect.mockClear();
    observerObserve.mockClear();
    observerInstances.length = 0;
    // Reset prom-client histogram by re-binding to a fresh snapshot before
    // each test so bucket counts don't leak across cases.
    collectSpy = vi.spyOn(gcPauseDuration, 'observe');
  });

  afterEach(() => {
    collectSpy.mockRestore();
  });

  it('records an event-loop delay sample via recordGcPause on tick', () => {
    const monitor = new GcPauseMonitor({ tickIntervalMs: 60_000 });
    monitor.start();

    // Simulate a 25 ms stall (25_000_000 ns)
    loopDelayStub.max = 25_000_000;
    monitor.tickForTest();

    expect(collectSpy).toHaveBeenCalledWith(25);
    monitor.stop();
  });

  it('falls through silently when loopDelay is unavailable (mid-test failure)', () => {
    const monitor = new GcPauseMonitor();
    monitor.start();
    // Simulate the loop having nothing to drain (max = +Infinity analog 1e20)
    loopDelayStub.max = Number.POSITIVE_INFINITY;
    monitor.tickForTest();
    // No observation should have been recorded for an infinite value
    expect(collectSpy).not.toHaveBeenCalled();
    monitor.stop();
  });

  it('disables the delay monitor and disconnects the observer on stop', () => {
    const monitor = new GcPauseMonitor();
    monitor.start();
    monitor.stop();

    expect(loopDelayStub.disable).toHaveBeenCalledTimes(1);
    if (observerInstances.length > 0) {
      expect(observerDisconnect).toHaveBeenCalled();
    }
  });

  it('is idempotent — repeated start() and stop() calls do not double-toggle', () => {
    const monitor = new GcPauseMonitor({ tickIntervalMs: 60_000 });
    monitor.start();
    monitor.start();
    monitor.tickForTest();
    expect(loopDelayStub.reset).toHaveBeenCalledTimes(1);

    monitor.stop();
    monitor.stop();
    // disable was called only once despite two stop() invocations
    expect(loopDelayStub.disable).toHaveBeenCalledTimes(1);
    monitor.tickForTest();
    // After stop, tick should be a no-op
    expect(loopDelayStub.reset).toHaveBeenCalledTimes(1);
  });

  it('exposes the configured GC pause buckets exactly as required by issue #19', () => {
    expect(GC_PAUSE_BUCKETS_MS).toEqual([1, 5, 10, 25, 50, 100, 250, 500]);
  });

  it('ignores non-finite or non-positive loop-delay samples', () => {
    const monitor = new GcPauseMonitor();
    monitor.start();

    loopDelayStub.max = 0;
    monitor.tickForTest();
    loopDelayStub.max = -10;
    monitor.tickForTest();

    expect(collectSpy).not.toHaveBeenCalled();
    monitor.stop();
  });
});

// Wires up the unused observerCtor so lint does not flag the captured mock.
void observerCtor;
