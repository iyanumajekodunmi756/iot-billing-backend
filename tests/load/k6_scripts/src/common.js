/**
 * Shared HTTP + payload primitives used by every k6 profile.
 *
 * IMPORTANT: k6 has no native Ed25519 support, and it cannot import npm
 * packages at runtime. We compile this file (along with the three
 * profile scripts) via esbuild into a single `bundle.js` snapshot that
 * k6 runs directly. The bundling step happens in
 * `tests/load/k6_scripts/build.ts` and is wired up via
 * `npm run k6:bundle`.
 *
 * Bundling inlines `tweetnacl` so signing is fully local - no
 * round-trip per payload.
 */

import nacl from 'tweetnacl';
import { Buffer } from 'buffer';
import { randomUUID } from 'crypto';
import encoding from 'k6/encoding';

export const DEFAULT_FAULT_INJECTION = {
  malformedRate: 0.01,
  expiredRate: 0.005,
  duplicateRate: 0.001,
};

function buildUnsignedPayload(device, opts = {}) {
  return {
    deviceId: device.deviceId,
    timestamp: opts.timestampOverrideMs ?? Date.now(),
    nonce: opts.nonceOverride ?? randomUUID(),
    metrics: {
      energy_kwh: Math.random() * 100,
      water_l: Math.random() * 50,
      gas_m3: Math.random() * 20,
      temperature: 15 + Math.random() * 30,
    },
  };
}

export function generateDevice(id) {
  const keyPair = nacl.sign.keyPair();
  return {
    deviceId: `sim-device-${id.toString().padStart(5, '0')}`,
    publicKey: Buffer.from(keyPair.publicKey),
    publicKeyHex: Buffer.from(keyPair.publicKey).toString('hex'),
    secretKey: Buffer.from(keyPair.secretKey),
  };
}

export function signPayload(device, unsigned, opts = {}) {
  const message = Buffer.from(JSON.stringify(unsigned), 'utf-8');
  let signature;
  if (opts.malformedSignature === true) {
    const randomSig = nacl.randomBytes(64);
    signature = Buffer.from(randomSig).toString('hex');
  } else {
    const sigBytes = nacl.sign.detached(message, device.secretKey);
    signature = Buffer.from(sigBytes).toString('hex');
  }
  return { ...unsigned, signature };
}

export function rollFault(roll, config = DEFAULT_FAULT_INJECTION) {
  const cumulative = config.malformedRate;
  if (roll < cumulative) return 'malformed';
  if (roll < cumulative + config.expiredRate) return 'expired';
  if (roll < cumulative + config.expiredRate + config.duplicateRate) return 'duplicate';
  return undefined;
}

export function generatePayload(device, faultConfig = DEFAULT_FAULT_INJECTION) {
  const fault = rollFault(Math.random(), faultConfig);
  let payload;
  if (fault === 'malformed') {
    payload = buildUnsignedPayload(device, { malformedSignature: true });
    return { payload: signPayload(device, payload, { malformedSignature: true }), fault };
  }
  if (fault === 'expired') {
    payload = buildUnsignedPayload(device, { timestampOverrideMs: Date.now() - 60_000 });
    return { payload: signPayload(device, payload), fault };
  }
  payload = buildUnsignedPayload(device);
  return { payload: signPayload(device, payload), fault: null };
}

/**
 * Encode the JSON payload using k6's native `encoding` namespace. We
 * convert manually so we don't depend on `JSON.stringify` behaviour
 * between k6 versions - k6 re-exports a JSON-compatible encoder that
 * tolerates huge payloads under the wire.
 */
export function encodeBody(device, payload) {
  const body = { payload, publicKey: device.publicKeyHex };
  return encoding.jsonEncode(body);
}

export function defaultOptions() {
  return {
    headers: {
      'Content-Type': 'application/json',
    },
    timeout: '10s',
    // k6 tags for per-profile aggregation.
    tags: { build: 'load-test-suite' },
  };
}
