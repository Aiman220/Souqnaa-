/**
 * SOUQNAA Marketplace — Settlement Statement Domain Service (SETTLEMENT_STATEMENT)
 * Generates and manages statements for seller settlements.
 */

import { prisma } from '../../database/prisma';
import { AppError } from '../../middleware/error.middleware';
import { StatementType, StatementStatus, StatementAuditAction } from '@prisma/client';
import { StatementNumberService } from './statement-number.service';
import { StatementAggregationService } from './statement-aggregation.service';
import { StatementSnapshotService } from './statement-snapshot.service';
import { StatementAuditService } from './statement-audit.service';
import { config } from '../../config';

export class SettlementStatementService {
  /**
   * Generates or retrieves an existing SETTLEMENT_STATEMENT for a specific settlement.
   * Enforces idempotency on (settlementId + statementType).
   */
  public static async generateStatement(params: {
    settlementId: string;
    actorId: string;
    actorRole?: string;
    autoFinalize?: boolean;
  }) {
    // 1. Idempotency Check: look for existing settlement statement for this settlementId
    const existing = await prisma.financialStatement.findFirst({
      where: {
        settlementId: params.settlementId,
        statementType: StatementType.SETTLEMENT_STATEMENT,
      },
      include: {
        snapshot: true,
        lines: { orderBy: { lineIndex: 'asc' } },
        auditLogs: { orderBy: { createdAt: 'desc' } },
      },
    });

    if (existing) {
      if (existing.status === StatementStatus.FINALIZED && existing.snapshot) {
        return {
          statement: existing,
          snapshot: await StatementSnapshotService.getSnapshot(existing.id),
        };
      }
      return { statement: existing };
    }

    // 2. Aggregate authoritative data from SettlementEngine
    const aggregated = await StatementAggregationService.aggregateSettlementStatement(params.settlementId);

    // 3. Generate unique atomic statement number: SQ-SET-STMT-YYYY-XXXXXX
    const statementNumber = await StatementNumberService.generateNextNumber(StatementType.SETTLEMENT_STATEMENT);

    const currency = aggregated.currency || config.marketplace.currency || 'YER';

    // 4. Create Draft Statement
    const statement = await prisma.$transaction(async (tx) => {
      const created = await tx.financialStatement.create({
        data: {
          statementNumber,
          statementType: StatementType.SETTLEMENT_STATEMENT,
          status: StatementStatus.READY,
          periodStart: aggregated.periodStart,
          periodEnd: aggregated.periodEnd,
          timezone: config.marketplace.timezone || 'Asia/Aden',
          currency,
          sellerId: aggregated.sellerId,
          settlementId: params.settlementId,
        },
      });

      await tx.statementAuditLog.create({
        data: {
          statementId: created.id,
          statementType: StatementType.SETTLEMENT_STATEMENT,
          actorId: params.actorId,
          actorRole: params.actorRole,
          action: StatementAuditAction.STATEMENT_CREATED,
          reason: `Settlement statement created for settlement ${aggregated.summary.settlementNumber}`,
        },
      });

      return created;
    });

    // 5. Finalize immediately if requested
    if (params.autoFinalize !== false) {
      const snapshot = await StatementSnapshotService.freezeStatement({
        statementId: statement.id,
        summary: aggregated.summary,
        lineItems: aggregated.lineItems,
        sourceReferences: aggregated.sourceReferences,
        actorId: params.actorId,
        actorRole: params.actorRole,
      });

      const finalizedStatement = await prisma.financialStatement.findUnique({
        where: { id: statement.id },
        include: {
          snapshot: true,
          lines: { orderBy: { lineIndex: 'asc' } },
          auditLogs: { orderBy: { createdAt: 'desc' } },
        },
      });

      return {
        statement: finalizedStatement,
        snapshot,
      };
    }

    return { statement };
  }

  /**
   * Retrieves a settlement statement by ID or settlementId.
   */
  public static async getStatementByIdOrSettlementId(idOrSettlementId: string) {
    const statement = await prisma.financialStatement.findFirst({
      where: {
        OR: [
          { id: idOrSettlementId },
          { settlementId: idOrSettlementId, statementType: StatementType.SETTLEMENT_STATEMENT },
        ],
      },
      include: {
        snapshot: true,
        lines: { orderBy: { lineIndex: 'asc' } },
        auditLogs: { orderBy: { createdAt: 'desc' } },
        settlement: true,
        seller: {
          include: {
            stores: true,
            user: { select: { firstName: true, lastName: true, email: true, phone: true } },
          },
        },
      },
    });

    if (!statement) {
      throw new AppError('كشف التسوية المالية غير موجود', 404);
    }

    const snapshot = statement.snapshot
      ? await StatementSnapshotService.getSnapshot(statement.id)
      : null;

    return {
      statement,
      snapshot,
    };
  }

  /**
   * Lists settlement statements with pagination and search.
   */
  public static async listStatements(params: {
    sellerId?: string;
    statementNumber?: string;
    settlementId?: string;
    status?: StatementStatus;
    page?: number;
    limit?: number;
  }) {
    const where: any = {
      statementType: StatementType.SETTLEMENT_STATEMENT,
    };

    if (params.sellerId) where.sellerId = params.sellerId;
    if (params.settlementId) where.settlementId = params.settlementId;
    if (params.status) where.status = params.status;
    if (params.statementNumber) {
      where.statementNumber = { contains: params.statementNumber, mode: 'insensitive' };
    }

    const page = params.page || 1;
    const limit = params.limit || 20;

    const [total, statements] = await Promise.all([
      prisma.financialStatement.count({ where }),
      prisma.financialStatement.findMany({
        where,
        include: {
          snapshot: true,
          settlement: { select: { settlementNumber: true, status: true, netSettlementAmount: true } },
          seller: { select: { id: true, stores: { select: { name: true } } } },
        },
        orderBy: { createdAt: 'desc' },
        skip: (page - 1) * limit,
        take: limit,
      }),
    ]);

    return {
      statements,
      total,
      page,
      limit,
      totalPages: Math.ceil(total / limit),
    };
  }
}
