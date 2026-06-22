import { defineConfig } from 'vitest/config';

// `poolMatchGlobs` confines the forks pool to ONLY the load suite. The
// default `threads` pool is fine for every other test file.
//
// The load suite uses Node's global `fetch` (Undici). Under the
// concurrent HTTP request loop of the runner tests, the shared Undici
// agent's connection pool deadlocks its socket queue on some Node
// builds - the tests hang at the per-test timeout. Running the load
// suite in a fresh forked process gives every test file its own
// dedicated Undici instance.
export default defineConfig({
  test: {
    globals: true,
    environment: 'node',
    poolMatchGlobs: [['tests/unit/load/**', 'forks']],
    include: ['tests/unit/**/*.test.ts'],
    exclude: ['tests/load/**', 'tests/load/k6_scripts/**', 'node_modules', 'dist'],
    coverage: {
      provider: 'v8',
      include: ['src/**/*.ts'],
      exclude: ['src/**/*.sql'],
    },
    // 10s global default keeps the failure signal loud for any
    // non-load test that genuinely hangs. The load suite under
    // tests/unit/load/** applies per-test 30s overrides in
    // simulation_runner.test.ts since the AbortController-capped
    // load profiles still incur CI cold-start overhead.
    testTimeout: 10000,
  },
});
