import type { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify';
import type { Prisma } from '@prisma/client';
import { getEnv } from '../../config/env.js';
import { IngestionStateMachine, IngestionState } from '../../core/ingestion/state_machine.js';
import type { LedgerEventSynchronizer } from '../../core/blockchain/event_listener.js';

interface ForceSettleBody {
  recordId: string;
  reason?: string;
}

interface ForceRollbackBody {
  recordId: string;
  reason?: string;
}

interface AdminActionResponse {
  success: boolean;
  recordId: string;
  action: string;
  previousState: string;
  newState: string;
  reason: string;
  timestamp: number;
}

/**
 * Verify the admin secret key header for authorization.
 */
function verifyAdminAuth(request: FastifyRequest, reply: FastifyReply): boolean {
  const env = getEnv();
  const authHeader = request.headers['x-admin-key'] as string | undefined;

  if (env.ADMIN_SECRET_KEY == null || env.ADMIN_SECRET_KEY === '') {
    void reply.status(503).send({
      error: 'Admin secret key not configured',
      message: 'Set ADMIN_SECRET_KEY environment variable to enable admin endpoints',
    });
    return false;
  }

  if (authHeader == null || authHeader === '' || authHeader !== env.ADMIN_SECRET_KEY) {
    void reply.status(401).send({
      error: 'Unauthorized',
      message: 'Invalid or missing X-Admin-Key header',
    });
    return false;
  }

  return true;
}

export function registerAdminRoutes(
  app: FastifyInstance,
  synchronizer?: LedgerEventSynchronizer,
): void {
  /**
   * POST /api/admin/force-settle
   * Force a billing record into SETTLED state.
   */
  app.post<{ Body: ForceSettleBody }>(
    '/api/admin/force-settle',
    {
      schema: {
        body: {
          type: 'object',
          required: ['recordId'],
          properties: {
            recordId: { type: 'string' },
            reason: { type: 'string' },
          },
        },
      },
    },
    async (request: FastifyRequest<{ Body: ForceSettleBody }>, reply: FastifyReply) => {
      if (!verifyAdminAuth(request, reply)) return;

      const { recordId, reason = 'Admin force settle' } = request.body;

      // Create a state machine in TENTATIVE state (as if it was mid-flight)
      // In production, this would load the actual record's state from the database
      const sm = new IngestionStateMachine(IngestionState.TENTATIVE);

      if (!sm.canTransitionTo(IngestionState.SETTLED)) {
        return reply.status(409).send({
          success: false,
          recordId,
          action: 'force-settle',
          error: `Cannot force settle: current state does not allow transition to SETTLED`,
        });
      }

      const previousState = sm.getState();
      const transitioned = sm.transition(IngestionState.SETTLED, reason);

      if (!transitioned) {
        return reply.status(409).send({
          success: false,
          recordId,
          action: 'force-settle',
          error: 'State transition rejected',
        });
      }

      const response: AdminActionResponse = {
        success: true,
        recordId,
        action: 'force-settle',
        previousState,
        newState: IngestionState.SETTLED,
        reason,
        timestamp: Date.now(),
      };

      return reply.send(response);
    },
  );

  /**
   * POST /api/admin/force-rollback
   * Force a billing record into ROLLED_BACK state and trigger reconciliation.
   */
  app.post<{ Body: ForceRollbackBody }>(
    '/api/admin/force-rollback',
    {
      schema: {
        body: {
          type: 'object',
          required: ['recordId'],
          properties: {
            recordId: { type: 'string' },
            reason: { type: 'string' },
          },
        },
      },
    },
    async (request: FastifyRequest<{ Body: ForceRollbackBody }>, reply: FastifyReply) => {
      if (!verifyAdminAuth(request, reply)) return;

      const { recordId, reason = 'Admin force rollback' } = request.body;

      // Create a state machine in TENTATIVE state (as if it was mid-flight)
      // In production, this would load the actual record's state from the database
      const sm = new IngestionStateMachine(IngestionState.TENTATIVE);

      if (!sm.canTransitionTo(IngestionState.ROLLED_BACK)) {
        return reply.status(409).send({
          success: false,
          recordId,
          action: 'force-rollback',
          error: `Cannot force rollback: current state does not allow transition to ROLLED_BACK`,
        });
      }

      const previousState = sm.getState();
      const rolledBack = sm.transition(IngestionState.ROLLED_BACK, reason);

      if (!rolledBack) {
        return reply.status(409).send({
          success: false,
          recordId,
          action: 'force-rollback',
          error: 'State transition rejected',
        });
      }

      // After rollback, transition to RECONCILING
      const reconciling = sm.transition(
        IngestionState.RECONCILING,
        'Administrative reconciliation triggered after force rollback',
      );

      const response: AdminActionResponse = {
        success: true,
        recordId,
        action: 'force-rollback',
        previousState,
        newState: reconciling ? IngestionState.RECONCILING : IngestionState.ROLLED_BACK,
        reason,
        timestamp: Date.now(),
      };

      return reply.send(response);
    },
  );

  /**
   * PATCH /api/admin/certificates/:serial/revoke
   * Revokes a hardware certificate by serial and triggers hot-reload via NOTIFY.
   */
  app.patch<{ Params: { serial: string } }>(
    '/api/admin/certificates/:serial/revoke',
    {
      schema: {
        params: {
          type: 'object',
          properties: {
            serial: { type: 'string' },
          },
        },
      },
    },
    async (request, reply) => {
      if (!verifyAdminAuth(request, reply)) return;

      const { serial } = request.params;

      const { PrismaClient } = await import('@prisma/client');
      const prisma = new PrismaClient();

      try {
        const cert = await prisma.hardwareCertificate.findUnique({
          where: { serial },
        });

        if (!cert) {
          return await reply.status(404).send({ success: false, error: 'Certificate not found' });
        }

        if (cert.revoked) {
          return await reply
            .status(400)
            .send({ success: false, error: 'Certificate is already revoked' });
        }

        await prisma.$transaction(async (tx: Prisma.TransactionClient) => {
          await tx.hardwareCertificate.update({
            where: { serial },
            data: { revoked: true },
          });

          // Trigger NOTIFY
          const payload = JSON.stringify({ serial });
          await tx.$executeRawUnsafe(`NOTIFY cert_updates, '${payload}'`);
        });

        return await reply.send({ success: true, serial, action: 'revoke', timestamp: Date.now() });
      } catch (err) {
        request.log.error(err);
        return await reply.status(500).send({ success: false, error: 'Internal server error' });
      } finally {
        await prisma.$disconnect();
      }
    },
  );

  /**
   * GET /api/admin/sync-status
   * Returns the current ledger synchronizer state.
   */
  app.get('/api/admin/sync-status', async (request: FastifyRequest, reply: FastifyReply) => {
    if (!verifyAdminAuth(request, reply)) return;

    if (!synchronizer) {
      return reply.status(503).send({
        error: 'Sync service not available',
        message: 'LedgerEventSynchronizer is not configured',
      });
    }

    return reply.send({ ...synchronizer.getSyncState(), timestamp: Date.now() });
  });
}
