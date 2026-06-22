/**
 * Device + payload primitives shared by every runner mode.
 *
 * The signatures produced here MUST be byte-identical to what real IoT
 * devices would emit on the wire (Ed25519 over the canonical JSON of the
 * unsigned payload), so the mock server validates them through the same
 * `validateSignature` / `createValidator` code paths used in production.
 */

import nacl from 'tweetnacl';
import { Buffer } from 'node:buffer';
import { randomUUID } from 'node:crypto';
import type { FaultInjectionConfig, SignedTelemetryPayload } from './types.js';
import { DEFAULT_FAULT_INJECTION } from './types.js';

export interface SimulatedDevice {
  deviceId: string;
  publicKey: Uint8Array;
  secretKey: Uint8Array;
  /** Key in hex - handy for log lines and the k6 JS bundle inspection. */
  publicKeyHex: string;
}

export function generateDevice(id: number): SimulatedDevice {
  const keyPair = nacl.sign.keyPair();
  return {
    deviceId: `sim-device-${id.toString().padStart(5, '0')}`,
    publicKey: keyPair.publicKey,
    secretKey: keyPair.secretKey,
    publicKeyHex: Buffer.from(keyPair.publicKey).toString('hex'),
  };
}

export interface PayloadOpts {
  timestampOverrideMs?: number;
  nonceOverride?: string;
  /** Force a payload whose signature is structurally invalid (random bytes). */
  malformedSignature?: boolean;
}

/**
 * Build a single signed payload. Returns JUST the unsigned structure
 * (no signature) so callers can decide what to do with it under fault
 * injection - the wire signer ({@link signPayload}) always signs the
 * canonical payload bytes.
 */
export function buildUnsignedPayload(
  device: SimulatedDevice,
  opts: PayloadOpts = {},
): Omit<SignedTelemetryPayload, 'signature'> {
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

/**
 * Sign a payload with the device's Ed25519 secret key, producing a
 * Stellar-compatible detached signature over the canonical JSON.
 */
export function signPayload(
  device: SimulatedDevice,
  unsigned: Omit<SignedTelemetryPayload, 'signature'>,
  opts: PayloadOpts = {},
): SignedTelemetryPayload {
  const message = Buffer.from(JSON.stringify(unsigned), 'utf-8');
  let signature: string;
  if (opts.malformedSignature === true) {
    // Real forged signature strategy: 64 random bytes - the right SHAPE
    // but never valid against the device key.
    const randomSig = nacl.randomBytes(64);
    signature = Buffer.from(randomSig).toString('hex');
  } else {
    const sigBytes = nacl.sign.detached(message, device.secretKey);
    signature = Buffer.from(sigBytes).toString('hex');
  }
  return { ...unsigned, signature };
}

/**
 * Probability-checked fault injection matcher. Returns the chosen fault
 * kind or undefined if no fault fires this iteration. The order is fixed
 * (malformed -> expired -> duplicate) so the rates don't accidentally
 * overlap on the same sample.
 */
export function rollFault(
  roll: number,
  config: FaultInjectionConfig = DEFAULT_FAULT_INJECTION,
): 'malformed' | 'expired' | 'duplicate' | undefined {
  const cumulative = config.malformedRate;
  if (roll < cumulative) return 'malformed';
  if (roll < cumulative + config.expiredRate) return 'expired';
  if (roll < cumulative + config.expiredRate + config.duplicateRate) return 'duplicate';
  return undefined;
}
