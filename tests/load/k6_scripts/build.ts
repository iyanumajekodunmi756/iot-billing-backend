/**
 * Build script that compiles the three k6 profiles into standalone
 * "snapshot" bundles that k6's bundled node-style runtime can ingest
 * directly. Run with `npm run k6:bundle`.
 *
 * We use esbuild with `--bundle --format=esm` so third-party libraries
 * (`tweetnacl` for Ed25519, `crypto` polyfills) ship inlined into the
 * snapshot. No external resolution at k6 startup = reproducible runs.
 *
 * Output:
 *   dist/k6/steady_state.js
 *   dist/k6/burst.js
 *   dist/k6/recovery.js
 */

import { build } from 'esbuild';
import { existsSync, mkdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const here = path.dirname(fileURLToPath(import.meta.url));
const outDir = path.resolve(here, '../dist/k6');

if (!existsSync(outDir)) {
  mkdirSync(outDir, { recursive: true });
}

const profiles = [
  { name: 'steady_state', entry: path.resolve(here, 'src/steady_state.js') },
  { name: 'burst', entry: path.resolve(here, 'src/burst.js') },
  { name: 'recovery', entry: path.resolve(here, 'src/recovery.js') },
];

async function main(): Promise<void> {
  for (const profile of profiles) {
    const outPath = path.resolve(outDir, `${profile.name}.js`);
    console.log(`[k6:bundle] -> ${outPath}`);
    await build({
      entryPoints: [profile.entry],
      bundle: true,
      format: 'esm',
      target: 'es2020',
      platform: 'neutral',
      outfile: outPath,
      // k6 implements the webcrypto and buffer APIs natively but does
      // not support `tweetnacl`. Inlining it as a plain dep is enough.
      external: ['k6/*', 'k6'],
      minify: false,
      sourcemap: false,
      logLevel: 'info',
    });
  }
  console.log('[k6:bundle] done.');
}

main().catch((err: unknown) => {
  console.error('[k6:bundle] failed:', err);
  process.exit(1);
});
