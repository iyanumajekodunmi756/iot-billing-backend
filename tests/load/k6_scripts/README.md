# High-Density Load Test Suite (issue #20)

This suite replaces the previous `simulation_runner.ts` that only
exercised `validateSignature()` in-process. The new design:

- **Mock Ingestion Gateway** (`./mock_server.ts`) - Fastify server
  exposing `POST /ingest` plus mocked Soroban RPC routes
  (`/ledgers/*`, `/transactions`), with configurable latency and
  per-route failure injection. It runs the SAME `createValidator` +
  `InMemoryNonceCache` code path used in production.
- **Load Runner** (`./simulation_runner.ts`) - Backward-compatible
  runner that now supports HTTP profiles (`steady_state`, `burst`,
  `recovery`) against any ingestion target. The original local
  in-process validation mode is kept as the `local` profile.
- **k6 Profiles** (`./k6_scripts/`) - Three k6 snapshot bundles
  covering the three profiles from the issue blueprint:
  `steady_state`, `burst`, `recovery`. Bundled via esbuild
  (`npm run k6:bundle`) so `tweetnacl` ships inside the snapshot.

## Quickstart

```
# 1. start the mock gateway
npm run load:mock

# 2. in another shell, send a single request via curl
curl -X POST http://localhost:4000/ingest \
  -H 'content-type: application/json' \
  -d '{"payload":{...},"publicKey":"..."}'

# 3. run the bundled profiles against it
npm run k6:bundle
npm run k6:steady -- --vus 50000 --duration 300s \
  -e TARGET_URL=http://localhost:4000
```

## Profiles

Each profile targets ~50k VUs as required by the issue. Always read
the `--summary-export=report.json` output for the agreed schema
(p50/p95/p99, error rate, throughput).

| Profile        | Scenario                                                         |
| -------------- | ---------------------------------------------------------------- |
| `steady_state` | 1 payload/sec/device held for the full duration. Spec baseline.  |
| `burst`        | 0 -> 50k VUs in 30s, hold 60s, ramp down. Connection-pool churn. |
| `recovery`     | Two full 0 -> 50k cycles. Confirms nonce cache + sync cleanup.   |

## Fault injection

Defaults match the issue:

- 1% malformed (random but length-correct signatures)
- 0.5% expired (timestamp 60s in the past - outside the 5s window)
- 0.1% duplicate (nonce replay - exercised twice on the same tick)

Pass `DEFAULT_FAULT_INJECTION` overrides via env:

```
FAULT_MALFORMED=0.05 npm run k6:steady
```

## Staging runbook (issue #20 requirement)

CI runs the **`load:smoke`** script as a smoke test. The full 50k
profile is intended for a real staging cluster:

```
# Bundle once
npm run k6:bundle

# Run against staging
TARGET_URL=https://ingest.staging.example.com \
  npm run k6:steady -- --vus 50000 --duration 300s \
  --summary-export=reports/steady_state.json
```

JSON reports land in `reports/`. Surface the P50/P95/P99 columns in
the staging dashboard and gate deploys on `p99Met=true`.

## Backward compatibility

The original `runSimulation()` function and `simulation_runner.ts`
CLI signature (`tsx tests/load/simulation_runner.ts N DURATION`) still
work unchanged; they now select the `local` profile by default. To
target HTTP, prefix with a profile name:

```
tsx tests/load/simulation_runner.ts steady_state 50000 300 --http http://staging
tsx tests/load/simulation_runner.ts burst 50000 60 --http http://staging
tsx tests/load/simulation_runner.ts recovery 50000 600 --http http://staging
```
