## Summary

Resolves issue #20 (High-Density Concurrent Simulated Load Testing Suite) and fixes CI failure #1 (Unit Tests + Load Test Smoke 15s timeouts in vitest default `threads` pool).

This PR adds the load-testing suite and the small Vitest config change required to make it green in CI.

## What's in this PR

### Mock ingestion gateway (`tests/load/mock_server.ts`)
Fastify standalone that wraps the production `createValidator` + `InMemoryNonceCache` so signature verification and nonce-window CAS are actually exercised:
- `POST /ingest` - validates `{ payload, publicKey }` signed telemetry
- `GET /ledgers/...` and `POST /transactions` - mocked Soroban RPC
- `GET /health` and `GET /_stats` - readiness + counter surface
- Configurable latency (mean + jitter) and per-route failure injection

### Load orchestrator (`tests/load/lib/run_load.ts`)
HTTP driver with concurrency-controlled worker promises, 1%/0.5%/0.1% fault injection (malformed/expired/duplicate), and a unified JSON metrics schema (`p50/p90/p95/p99`, `throughputPerSec`, `errorRate`, rejectionsByReason, target gates).

### Profiles (issue blueprint)
- `steady_state` - 1 payload/sec/device sustained load
- `burst` - 8 payloads/sec/device peak, 0 to 50k VU ramp
- `recovery` - 0.25 payloads/sec/device idle/peak cycles

The original `local` profile and `runSimulation()` API are kept intact for backward compatibility.

### k6 staging suites (`tests/load/k6_scripts/`)
Three k6 profiles plus an esbuild bundler so `tweetnacl` ships inlined in the snapshot for real staging runs. See `tests/load/k6_scripts/README.md` for the staging runbook.

### Smoke CI gate (`.github/workflows/load-test.yml`)
Runs `eslint`, `prettier --check`, `vitest tests/unit/load/`, and `cli_smoke.ts` on every PR touching the load suite or the ingestion validator.

### CI fix (`vitest.config.ts`)
Switches the unit-test pool to `forks` so each test file gets its own fresh Undici `fetch` agent. Without this, Node's shared `fetch` agent deadlocks its socket retry queue under the load suite's concurrent HTTP requests and the runner tests hang at the per-test timeout.

## Quality bar

- TypeScript strict passes (`tsc --noEmit`)
- Prettier clean
- ESLint clean
- 18 new load-suite unit tests (mock_server + simulation_runner)
- 14 mock ingestion unit tests covering signature accept/reject, replay CAS, stale timestamp, latency injection, fault injection

## Test plan for maintainers

```sh
npm run k6:bundle                          # build k6 snapshots
npm run test:load:unit                     # run the unit suite
SMOKE_PORT=0 npm run load:smoke            # full smoke + JSON metrics
npm run load:steady -- --http http://host  # run a profile against any target
```

## Related

- Closes #20
- Backward-compat verified: legacy `tsx tests/load/simulation_runner.ts N DUR` still works unchanged.
