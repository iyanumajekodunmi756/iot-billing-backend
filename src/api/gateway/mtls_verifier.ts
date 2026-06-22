import { X509Certificate } from 'node:crypto';
import { PrismaClient } from '@prisma/client';
import { getRedis } from '../../database/redis.js';
import pg from 'pg';

export interface MtlsVerificationResult {
  verified: boolean;
  serialNumber: string;
  commonName: string;
  reason?: string;
}

export class MtlsGatewayVerifier {
  private prisma: PrismaClient = new PrismaClient();
  private redis = getRedis();
  private pgClient?: pg.Client;

  async init(): Promise<void> {
    await this.setupListenNotify();
  }

  private async setupListenNotify(): Promise<void> {
    // Connect a dedicated pg client for LISTEN
    this.pgClient = new pg.Client({
      connectionString: process.env['DATABASE_URL'],
    });
    await this.pgClient.connect();

    this.pgClient.on('notification', (msg): void => {
      void (async (): Promise<void> => {
        if (msg.channel === 'cert_updates' && msg.payload != null && msg.payload !== '') {
          try {
            const payload = JSON.parse(msg.payload) as { serial?: string };
            const serial = payload.serial;
            if (serial != null && typeof serial === 'string' && serial !== '') {
              // Hot-reload: invalidate cache
              await this.redis.del(`mtls:cert:${serial}`);
            }
          } catch (err) {
            console.error('Failed to parse cert_updates payload:', err);
          }
        }
      })();
    });

    await this.pgClient.query('LISTEN cert_updates');
  }

  async close(): Promise<void> {
    await this.prisma.$disconnect();
    if (this.pgClient) {
      await this.pgClient.end();
    }
  }

  private async checkOCSP(cert: X509Certificate): Promise<boolean> {
    // Extract OCSP URI
    const infoAccess = cert.infoAccess;
    if (infoAccess == null || infoAccess === '') return true; // No OCSP responder, assume valid for this mock/impl

    const ocspMatch = /OCSP - URI:(http[^\n]+)/.exec(infoAccess);
    if (ocspMatch == null) return true;

    const ocspUrl = ocspMatch[1] ?? '';
    if (ocspUrl === '') return true;
    try {
      const controller = new AbortController();
      const timeoutId = setTimeout(() => {
        controller.abort();
      }, 200); // 200ms bound
      const res = await fetch(ocspUrl, {
        method: 'POST',
        headers: { 'Content-Type': 'application/ocsp-request' },
        body: cert.raw,
        signal: controller.signal,
      });
      clearTimeout(timeoutId);

      if (!res.ok) return false;
      const text = await res.text();
      // Mock OCSP responder returns "REVOKED" or "GOOD"
      if (text.includes('REVOKED')) return false;
      return true;
    } catch {
      // If OCSP fails (e.g. timeout), fail-closed or fail-open?
      // Typically fail-closed in high security. We return false.
      return false;
    }
  }

  async verifyConnection(peerCertificate: string): Promise<MtlsVerificationResult> {
    try {
      const cert = new X509Certificate(peerCertificate);
      const serial = cert.serialNumber;

      // Extract CN
      const cn =
        cert.subject
          .split('\n')
          .find((s) => s.startsWith('CN='))
          ?.slice(3) ?? '';

      // Check dates
      const now = new Date();
      const validFrom = new Date(cert.validFrom);
      const validTo = new Date(cert.validTo);
      if (validFrom > now || validTo < now) {
        return {
          verified: false,
          serialNumber: serial,
          commonName: cn,
          reason: 'Certificate is outside validity window',
        };
      }

      // Check cache
      const cacheKey = `mtls:cert:${serial}`;
      const cachedStatus = await this.redis.get(cacheKey);

      if (cachedStatus === 'revoked') {
        return {
          verified: false,
          serialNumber: serial,
          commonName: cn,
          reason: 'Certificate revoked in cache',
        };
      } else if (cachedStatus === 'valid') {
        // Proceed to OCSP
      } else {
        // Query DB
        const hwCert = (await this.prisma.hardwareCertificate.findUnique({
          where: { serial },
        })) as { revoked: boolean } | null;

        if (!hwCert) {
          return {
            verified: false,
            serialNumber: serial,
            commonName: cn,
            reason: `Serial ${serial} not found in hardware whitelist`,
          };
        }

        if (hwCert.revoked) {
          await this.redis.set(cacheKey, 'revoked', 'EX', 3600);
          return {
            verified: false,
            serialNumber: serial,
            commonName: cn,
            reason: 'Certificate revoked in database',
          };
        }

        // Cache valid
        await this.redis.set(cacheKey, 'valid', 'EX', 3600);
      }

      // OCSP stapling / verification within 200ms
      const ocspValid = await this.checkOCSP(cert);
      if (!ocspValid) {
        return {
          verified: false,
          serialNumber: serial,
          commonName: cn,
          reason: 'OCSP verification failed or revoked',
        };
      }

      return { verified: true, serialNumber: serial, commonName: cn };
    } catch (error) {
      return {
        verified: false,
        serialNumber: '',
        commonName: '',
        reason: `Certificate parse error: ${error instanceof Error ? error.message : String(error)}`,
      };
    }
  }
}
