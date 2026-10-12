/**
 * SOUQNAA Marketplace — Tax Statement Domain Service (TAX_STATEMENT)
 * Generates and manages seller tax statements consuming authoritative Tax Engine snapshots.
 */

import { prisma } from '../../database/prisma';
import { AppError } from '../../middleware/error.middleware';
import { StatementType, StatementStatus, StatementPeriodType, StatementAuditAction } from '@prisma/client';
import { StatementNumberService } from './statement-number.service';
import { StatementPeriodService } from './statement-period.service';
import { StatementAggregationService } from './statement-aggregation.service';
import { StatementSnapshotService } from './statement-snapshot.service';
import { StatementAuditService } from './statement-audit.service';
import { config } from '../../config';

export class TaxStatementService {
  /**
   * Generates or retrieves an existing TAX_STATEMENT with strict idempotency.
   */
  public static async generateStatement(params: {
    sellerId: string;
    periodType?: StatementPeriodType;
    referenceDate?: Date;
    customStart?: Date;
    customEnd?: Date;
    actorId: string;
    actorRole?: string;
    autoFinalize?: boolean;
  }) {
    const { periodStart, periodEnd, periodType, timezone } = StatementPeriodService.resolvePeriodBounds({
      periodType: params.periodType,
      referenceDate: params.referenceDate,
      customStart: params.customStart,
      customEnd: params.customEnd,
    });

    const currency = config.marketplace.currency || 'YER';

    // 1. Idempotency Check
    const existing = await prisma.financialStatement.findFirst({
      where: {
        sellerId: params.sellerId,
        statementType: StatementType.TAX_STATEMENT,
        periodStart,
        periodEnd,
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

    // 2. Generate unique atomic statement number: SQ-TAX-STMT-YYYY-XXXXXX
    const statementNumber = await StatementNumberService.generateNextNumber(StatementType.TAX_STATEMENT);

    // 3. Aggregate authoritative tax snapshot data
    const aggregated = await StatementAggregationService.aggregateTaxStatement({
      sellerId: params.sellerId,
      periodStart,
      periodEnd,
    });

    // 4. Create Draft Statement
    const statement = await prisma.$transaction(async (tx) => {
      const created = await tx.financialStatement.create({
        data: {
          statementNumber,
          statementType: StatementType.TAX_STATEMENT,
          status: StatementStatus.READY,
          periodType,
          periodStart,
          periodEnd,
          timezone,
          currency,
          sellerId: params.sellerId,
        },
      });

      await tx.statementAuditLog.create({
        data: {
          statementId: created.id,
          statementType: StatementType.TAX_STATEMENT,
          actorId: params.actorId,
          actorRole: params.actorRole,
          action: StatementAuditAction.STATEMENT_CREATED,
          reason: 'Tax statement initialized',
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
   * Retrieves a tax statement by ID.
   */
  public static async getStatementById(statementId: string) {
    const statement = await prisma.financialStatement.findUnique({
      where: { id: statementId },
      include: {
        snapshot: true,
        lines: { orderBy: { lineIndex: 'asc' } },
        auditLogs: { orderBy: { createdAt: 'desc' } },
        seller: {
          include: {
            stores: true,
            user: { select: { firstName: true, lastName: true, email: true, phone: true } },
          },
        },
      },
    });

    if (!statement) {
      throw new AppError('كشف الإقرار الضريبي غير موجود', 404);
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
   * Lists tax statements with pagination.
   */
  public static async listStatements(params: {
    sellerId?: string;
    statementNumber?: string;
    status?: StatementStatus;
    page?: number;
    limit?: number;
  }) {
    const where: any = {
      statementType: StatementType.TAX_STATEMENT,
    };

    if (params.sellerId) where.sellerId = params.sellerId;
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
          seller: { select: { id: true, stores: { select: { name: true } } } },
        },
        orderBy: { periodStart: 'desc' },
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
