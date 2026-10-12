/**
 * SOUQNAA Marketplace — Statement Audit Service
 * Maintains an immutable append-only audit trail of all financial statement lifecycle actions.
 * Never deletes or alters historical audit history.
 */

import { prisma } from '../../database/prisma';
import { StatementType, StatementAuditAction } from '@prisma/client';

export interface RecordStatementAuditInput {
  statementId: string;
  statementType: StatementType;
  actorId: string;
  actorRole?: string;
  action: StatementAuditAction;
  reason?: string;
  metadata?: Record<string, any>;
}

export class StatementAuditService {
  /**
   * Records an immutable audit log entry.
   */
  public static async log(input: RecordStatementAuditInput) {
    return await prisma.statementAuditLog.create({
      data: {
        statementId: input.statementId,
        statementType: input.statementType,
        actorId: input.actorId,
        actorRole: input.actorRole,
        action: input.action,
        reason: input.reason,
        metadata: input.metadata ? JSON.stringify(input.metadata) : null,
      },
    });
  }

  /**
   * Retrieves full audit history for a statement.
   */
  public static async getStatementAuditLogs(statementId: string) {
    return await prisma.statementAuditLog.findMany({
      where: { statementId },
      orderBy: { createdAt: 'asc' },
    });
  }

  /**
   * Retrieves platform-wide statement audit history for admins.
   */
  public static async listAdminAuditLogs(params: {
    statementType?: StatementType;
    action?: StatementAuditAction;
    actorId?: string;
    page?: number;
    limit?: number;
  }) {
    const where: any = {};
    if (params.statementType) where.statementType = params.statementType;
    if (params.action) where.action = params.action;
    if (params.actorId) where.actorId = params.actorId;

    const page = params.page || 1;
    const limit = params.limit || 50;

    const [total, logs] = await Promise.all([
      prisma.statementAuditLog.count({ where }),
      prisma.statementAuditLog.findMany({
        where,
        include: {
          statement: {
            select: {
              statementNumber: true,
              statementType: true,
              sellerId: true,
            },
          },
        },
        orderBy: { createdAt: 'desc' },
        skip: (page - 1) * limit,
        take: limit,
      }),
    ]);

    return {
      logs,
      total,
      page,
      limit,
      totalPages: Math.ceil(total / limit),
    };
  }
}
