import type { FastifyInstance } from 'fastify';
import { circuitBreakerState, circuitBreakerQueueDepth } from './metrics/prometheus.js';

interface MetricEntry {
  labels: Partial<Record<string, string | number>>;
  value: number;
}

export function registerCircuitHealth(app: FastifyInstance): void {
  app.get('/circuit-health', async () => {
    const stateMetric = (await circuitBreakerState.get()).values.find(
      (v: MetricEntry) => v.labels['client'] === 'soroban',
    );
    const queueMetric = (await circuitBreakerQueueDepth.get()).values.find(
      (v: MetricEntry) => v.labels['client'] === 'soroban',
    );
    return {
      state: stateMetric ? stateMetric.value : 0,
      queueDepth: queueMetric ? queueMetric.value : 0,
    };
  });
}
