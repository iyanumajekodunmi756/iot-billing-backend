/**
 * Unit tests for the mock ingestion gateway.
 *
 * Exercises the full ingestion path: device -> signed payload -> POST
 * /ingest -> validator (signature + nonce-window CAS) -> response.
 * Fault-injection tolerances are validated statistically in the
 * `simulation_runner.test.ts` companion suite.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { Buffer } from 'node:buffer';
import nacl from 'tweetnacl';
import { buildMockServer, type StartedMockServer } from '../../load/mock_server.js';
import { generateDevice, signPayload, buildUnsignedPayload } from '../../load/lib/sign_payload.js';
import { randomUUID } from 'node:crypto';

async function spinUp(
  opts: Parameters<typeof buildMockServer>[0] = {},
): Promise<{ server: StartedMockServer; url: string }> {
  const server = await buildMockServer({ port: 0, host: '127.0.0.1', ...opts });
  await server.start();
  return { server, url: server.url };
}

async function postIngest(
  url: string,
  body: object,
): Promise<{ status: number; json: Record<string, unknown> | null }> {
  const res = await fetch(`${url}/ingest`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  let json: Record<string, unknown> | null = null;
  try {
    json = (await res.json()) as Record<string, unknown>;
  } catch {
    json = null;
  }
  return { status: res.status, json };
}

describe('Mock Ingestion Gateway', () => {
  describe('health', () => {
    it('responds ok on /health', async (): Promise<void> => {
      const { server, url } = await spinUp();
      try {
        const res = await fetch(`${url}/health`);
        const body = (await res.json()) as { status: string };
        expect(res.status).toBe(200);
        expect(body.status).toBe('ok');
      } finally {
        await server.stop();
      }
    });
  });

  describe('/ingest happy path', () => {
    let server: StartedMockServer;
    let url: string;

    beforeEach(async (): Promise<void> => {
      const ctx = await spinUp();
      server = ctx.server;
      url = ctx.url;
    });
    afterEach(async (): Promise<void> => {
      await server.stop();
    });

    it('accepts a properly signed payload with matching public key', async (): Promise<void> => {
      const device = generateDevice(1);
      const payload = signPayload(device, buildUnsignedPayload(device));
      const { status, json } = await postIngest(url, { payload, publicKey: device.publicKeyHex });
      expect(status).toBe(200);
      expect(json?.['status']).toBe('accepted');
      expect(json?.['deviceId']).toBe(device.deviceId);
    });

    it('flat payload missing publicKey is rejected with reason', async (): Promise<void> => {
      const device = generateDevice(2);
      const payload = signPayload(device, buildUnsignedPayload(device));
      const { status, json } = await postIngest(url, payload);
      expect(status).toBe(400);
      expect(json?.['reason']).toBe('missing_public_key');
    });

    it('rejects forged signatures with 422', async (): Promise<void> => {
      const device = generateDevice(3);
      const unsigned = buildUnsignedPayload(device);
      const forgedSig = nacl.randomBytes(64);
      const payload = { ...unsigned, signature: Buffer.from(forgedSig).toString('hex') };
      const { status, json } = await postIngest(url, {
        payload,
        publicKey: device.publicKeyHex,
      });
      expect(status).toBe(422);
      expect(json?.['status']).toBe('rejected');
      expect(String(json?.['reason'])).toMatch(/signature/i);
    });

    it('rejects replayed nonce on second submission (CAS replay protection)', async (): Promise<void> => {
      const device = generateDevice(4);
      const fixedNonce = randomUUID();
      const first = signPayload(
        device,
        buildUnsignedPayload(device, { nonceOverride: fixedNonce }),
      );
      const a = await postIngest(url, { payload: first, publicKey: device.publicKeyHex });
      expect(a.status).toBe(200);
      const b = await postIngest(url, { payload: first, publicKey: device.publicKeyHex });
      expect(b.status).toBe(422);
      expect(String(b.json?.['reason'])).toMatch(/nonce/i);
    });

    it('rejects stale timestamp outside the sliding window', async (): Promise<void> => {
      const device = generateDevice(5);
      const stale = signPayload(
        device,
        buildUnsignedPayload(device, { timestampOverrideMs: Date.now() - 60_000 }),
      );
      const { status, json } = await postIngest(url, {
        payload: stale,
        publicKey: device.publicKeyHex,
      });
      expect(status).toBe(422);
      expect(String(json?.['reason'])).toMatch(/timestamp/i);
    });

    it('rejects malformed body with 400', async (): Promise<void> => {
      const res = await fetch(`${url}/ingest`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ unrelated: true }),
      });
      expect(res.status).toBe(400);
    });

    it('rejects payload missing the publicKey field with 400', async (): Promise<void> => {
      const device = generateDevice(6);
      const payload = signPayload(device, buildUnsignedPayload(device));
      const { status, json } = await postIngest(url, { payload });
      expect(status).toBe(400);
      expect(json?.['reason']).toBe('missing_public_key');
    });

    it('rejects when publicKey is structurally invalid (wrong length)', async (): Promise<void> => {
      const device = generateDevice(7);
      const payload = signPayload(device, buildUnsignedPayload(device));
      const { status, json } = await postIngest(url, {
        payload,
        publicKey: 'deadbeef',
      });
      expect(status).toBe(400);
      expect(json?.['reason']).toBe('invalid_public_key_length');
    });
  });

  describe('configurable latency and failure injection', () => {
    it('returns 500 when ingestFailureRate = 1', async (): Promise<void> => {
      const { server, url } = await spinUp({ ingestFailureRate: 1 });
      try {
        const device = generateDevice(10);
        const payload = signPayload(device, buildUnsignedPayload(device));
        const { status } = await postIngest(url, {
          payload,
          publicKey: device.publicKeyHex,
        });
        expect(status).toBe(500);
      } finally {
        await server.stop();
      }
    });

    it('returns 503 from /ledgers/latest when rpcFailureRate = 1', async (): Promise<void> => {
      const { server, url } = await spinUp({ rpcFailureRate: 1 });
      try {
        const res = await fetch(`${url}/ledgers/latest`);
        expect(res.status).toBe(503);
      } finally {
        await server.stop();
      }
    });

    it('injects approximate latency within jitter bound', async (): Promise<void> => {
      const mean = 50;
      const jitter = 0.5;
      const { server, url } = await spinUp({ latencyMs: mean, latencyJitter: jitter });
      try {
        const device = generateDevice(20);
        const payload = signPayload(device, buildUnsignedPayload(device));
        const start = Date.now();
        const res = await postIngest(url, {
          payload,
          publicKey: device.publicKeyHex,
        });
        const elapsed = Date.now() - start;
        expect(res.status).toBe(200);
        expect(elapsed).toBeGreaterThanOrEqual(0);
        expect(elapsed).toBeLessThanOrEqual(mean * (1 + jitter) + 150);
      } finally {
        await server.stop();
      }
    });
  });

  describe('/_stats counter', () => {
    it('reflects accept/reject counts', async (): Promise<void> => {
      const { server, url } = await spinUp();
      try {
        const device = generateDevice(99);
        const validBody = signPayload(device, buildUnsignedPayload(device));
        await postIngest(url, { payload: validBody, publicKey: device.publicKeyHex });
        for (let i = 0; i < 2; i++) {
          const unsigned = buildUnsignedPayload(device);
          const fake = {
            ...unsigned,
            signature: Buffer.from(nacl.randomBytes(64)).toString('hex'),
          };
          await postIngest(url, { payload: fake, publicKey: device.publicKeyHex });
        }
        const stats = server.stats();
        expect(stats.accepted).toBe(1);
        expect(stats.rejected).toBeGreaterThanOrEqual(2);
      } finally {
        await server.stop();
      }
    });
  });
});
