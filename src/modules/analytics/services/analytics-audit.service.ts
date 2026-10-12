import { prisma } from '../../../database/prisma';

export interface AuditLogParams {
  actorId: string;
  actorRole: string;
  sellerId?: string;
  action: string;
  resource: string;
  filters?: Record<string, any>;
  ipAddress?: string;
  userAgent?: string;
  metadata?: Record<string, any>;
}

export class AnalyticsAuditService {
  /**
   * Records an audit log entry for analytical views, exports, and administrative actions.
   */
  public static async log(params: AuditLogParams): Promise<void> {
    try {
      await (prisma as any).analyticsAuditLog?.create?.({
        data: {
          actorId: params.actorId,
          actorRole: params.actorRole,
          sellerId: params.sellerId,
          action: params.action,
          resource: params.resource,
          filters: params.filters ? JSON.stringify(params.filters) : null,
          ipAddress: params.ipAddress,
          userAgent: params.userAgent,
          metadata: params.metadata ? JSON.stringify(params.metadata) : null,
        },
      });
    } catch (err) {
      // Non-blocking: audit failure should never break active user analytics requests
      console.error('[AnalyticsAuditService] Audit logging failed:', err);
    }
  }
}
