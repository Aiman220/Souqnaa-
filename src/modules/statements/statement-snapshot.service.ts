/**
 * SOUQNAA Marketplace — Statement Snapshot Service
 * Freezes and seals finalized statements into an immutable snapshot.
 * Guarantees reproducibility, version tracking, and cryptographic auditability.
 */

import crypto from 'crypto';
import { prisma } from '../../database/prisma';
import { AppError } from '../../middleware/error.middleware';
import { StatementStatus } from '@prisma/client';
import {
  StatementSnapshotDto,
  StatementSummary,
  StatementLineItemDto,
  StatementEngineVersions,
} from './statement.types';
import { StatementAuditService } from './statement-audit.service';
import { StatementAuditAction } from '@prisma/client';
import { CommissionEngine } from '../commission/commission.service';
import { SettlementEngine } from '../settlement/settlement.service';

export class StatementSnapshotService {
  public static readonly STATEMENT_ENGINE_VERSION = '1.0.0';
  public static readonly TAX_ENGINE_VERSION = '1.2.0';
  public static readonly COMMISSION_ENGINE_VERSION = CommissionEngine.VERSION;
  public static readonly SETTLEMENT_ENGINE_VERSION = SettlementEngine.VERSION;

  /**
   * Returns current active engine versions
   */
  public static getEngineVersions(): StatementEngineVersions {
    return {
      statementEngineVersion: this.STATEMENT_ENGINE_VERSION,
      taxEngineVersion: this.TAX_ENGINE_VERSION,
      commissionEngineVersion: this.COMMISSION_ENGINE_VERSION,
      settlementEngineVersion: this.SETTLEMENT_ENGINE_VERSION,
    };
  }

  /**
   * Generates a deterministic SHA-256 hash of the snapshot content for verification
   */
  public static computeVerificationHash(payload: {
    statementNumber: string;
    statementType: string;
    sellerId: string;
    currency: string;
    periodStart: string;
    periodEnd: string;
    summary: any;
    lineItemsCount: number;
  }): string {
    const raw = JSON.stringify(payload, Object.keys(payload).sort());
    return crypto.createHash('sha256').update(raw).digest('hex');
  }

  /**
   * Freezes a statement into a finalized, immutable StatementSnapshot.
   */
  public static async freezeStatement(params: {
    statementId: string;
    summary: StatementSummary;
    lineItems: StatementLineItemDto[];
    sourceReferences: {
      orderIds: string[];
      sellerOrderIds: string[];
      transactionIds: string[];
      taxSnapshotIds: string[];
      refundIds: string[];
      settlementId?: string | null;
    };
    actorId: string;
    actorRole?: string;
  }): Promise<StatementSnapshotDto> {
    const statement = await prisma.financialStatement.findUnique({
      where: { id: params.statementId },
      include: {
        snapshot: true,
        seller: {
          include: {
            stores: true,
            user: { select: { firstName: true, lastName: true, phone: true } },
          },
        },
      },
    });

    if (!statement) {
      throw new AppError('الكشف المالي غير موجود', 404);
    }

    if (statement.status === StatementStatus.FINALIZED) {
      throw new AppError('الكشف المالي معتمد ومجمد بالفعل ولا يمكن تعديله', 400);
    }

    const versions = this.getEngineVersions();
    const primaryStore = statement.seller.stores?.[0];
    const sellerName = primaryStore?.name || `${statement.seller.user?.firstName || ''} ${statement.seller.user?.lastName || ''}`.trim() || 'متجر سوقناا';

    const verificationHash = this.computeVerificationHash({
      statementNumber: statement.statementNumber,
      statementType: statement.statementType,
      sellerId: statement.sellerId,
      currency: statement.currency,
      periodStart: statement.periodStart.toISOString(),
      periodEnd: statement.periodEnd.toISOString(),
      summary: params.summary,
      lineItemsCount: params.lineItems.length,
    });

    const metadata = {
      storeName: primaryStore?.name || sellerName,
      sellerCrNumber: statement.seller.crNumber,
      sellerTaxNumber: statement.seller.taxNumber,
      sellerName,
      verificationHash,
      qrPayload: `SOUQNAA-STMT|${statement.statementNumber}|${statement.statementType}|${statement.sellerId}|${statement.currency}|${verificationHash.slice(0, 16)}`,
    };

    return await prisma.$transaction(async (tx) => {
      // 1. Create immutable snapshot record
      const createdSnapshot = await tx.statementSnapshot.create({
        data: {
          statementId: statement.id,
          statementNumber: statement.statementNumber,
          statementType: statement.statementType,
          sellerId: statement.sellerId,
          settlementId: statement.settlementId,
          periodStart: statement.periodStart,
          periodEnd: statement.periodEnd,
          currency: statement.currency,
          summary: JSON.stringify(params.summary),
          lineItems: JSON.stringify(params.lineItems),
          sourceReferences: JSON.stringify(params.sourceReferences),
          calculationVersions: JSON.stringify(versions),
          metadata: JSON.stringify(metadata),
        },
      });

      // 2. Insert statement lines for querying
      if (params.lineItems.length > 0) {
        await tx.statementLine.createMany({
          data: params.lineItems.map((li) => ({
            statementId: statement.id,
            lineIndex: li.lineIndex,
            transactionDate: li.transactionDate,
            reference: li.reference,
            orderId: li.orderId,
            sellerOrderId: li.sellerOrderId,
            transactionId: li.transactionId,
            type: li.type,
            description: li.description,
            grossAmount: li.grossAmount,
            discountAmount: li.discountAmount,
            taxAmount: li.taxAmount,
            commissionAmount: li.commissionAmount,
            adjustmentAmount: li.adjustmentAmount,
            feeAmount: li.feeAmount,
            netAmount: li.netAmount,
            currency: li.currency || statement.currency,
            status: li.status || 'COMPLETED',
            sourceType: li.sourceType,
            sourceId: li.sourceId,
            metadata: li.metadata ? JSON.stringify(li.metadata) : null,
          })),
        });
      }

      // 3. Update statement status to FINALIZED
      await tx.financialStatement.update({
        where: { id: statement.id },
        data: {
          status: StatementStatus.FINALIZED,
          finalizedAt: new Date(),
          statementEngineVersion: versions.statementEngineVersion,
          taxEngineVersion: versions.taxEngineVersion,
          commissionEngineVersion: versions.commissionEngineVersion,
          settlementEngineVersion: versions.settlementEngineVersion,
        },
      });

      // 4. Log immutable audit entry
      await tx.statementAuditLog.create({
        data: {
          statementId: statement.id,
          statementType: statement.statementType,
          actorId: params.actorId,
          actorRole: params.actorRole,
          action: StatementAuditAction.STATEMENT_FINALIZED,
          reason: 'Statement calculation finalized and immutable snapshot sealed',
          metadata: JSON.stringify({ verificationHash, versions }),
        },
      });

      return {
        statementId: statement.id,
        statementNumber: statement.statementNumber,
        statementType: statement.statementType,
        sellerId: statement.sellerId,
        settlementId: statement.settlementId,
        periodStart: statement.periodStart,
        periodEnd: statement.periodEnd,
        currency: statement.currency,
        summary: params.summary,
        lineItems: params.lineItems,
        sourceReferences: params.sourceReferences,
        calculationVersions: versions,
        metadata,
        createdAt: createdSnapshot.createdAt,
      };
    });
  }

  /**
   * Retrieves the immutable snapshot for a finalized statement.
   */
  public static async getSnapshot(statementId: string): Promise<StatementSnapshotDto | null> {
    const snapshot = await prisma.statementSnapshot.findUnique({
      where: { statementId },
    });

    if (!snapshot) return null;

    return {
      statementId: snapshot.statementId,
      statementNumber: snapshot.statementNumber,
      statementType: snapshot.statementType,
      sellerId: snapshot.sellerId,
      settlementId: snapshot.settlementId,
      periodStart: snapshot.periodStart,
      periodEnd: snapshot.periodEnd,
      currency: snapshot.currency,
      summary: JSON.parse(snapshot.summary),
      lineItems: JSON.parse(snapshot.lineItems),
      sourceReferences: JSON.parse(snapshot.sourceReferences),
      calculationVersions: JSON.parse(snapshot.calculationVersions),
      metadata: snapshot.metadata ? JSON.parse(snapshot.metadata) : undefined,
      createdAt: snapshot.createdAt,
    };
  }

  /**
   * Constructs a fallback snapshot on-the-fly from a FinancialStatement database record
   * if an immutable StatementSnapshot row has not been sealed yet.
   */
  public static buildFallbackSnapshot(statement: any): StatementSnapshotDto {
    const summary = statement.summary
      ? (typeof statement.summary === 'string' ? JSON.parse(statement.summary) : statement.summary)
      : {};

    const lineItems: StatementLineItemDto[] = (statement.lines || []).map((l: any) => ({
      lineIndex: l.lineIndex,
      transactionDate: l.transactionDate,
      reference: l.orderNumber || l.orderId || statement.statementNumber,
      orderId: l.orderId || undefined,
      orderNumber: l.orderNumber || undefined,
      sellerOrderId: l.sellerOrderId || undefined,
      transactionId: l.transactionId || undefined,
      type: l.lineType,
      description: l.description,
      grossAmount: Number(l.grossAmount || 0),
      discountAmount: Number(l.discountAmount || 0),
      taxAmount: Number(l.taxAmount || 0),
      commissionAmount: Number(l.commissionAmount || 0),
      adjustmentAmount: Number(l.adjustmentAmount || 0),
      feeAmount: Number(l.feeAmount || 0),
      netAmount: Number(l.netAmount || 0),
      currency: statement.currency || 'YER',
      status: 'COMPLETED',
      metadata: l.metadata ? (typeof l.metadata === 'string' ? JSON.parse(l.metadata) : l.metadata) : undefined,
    }));

    const versions: StatementEngineVersions = {
      statementEngineVersion: statement.statementEngineVersion || this.STATEMENT_ENGINE_VERSION,
      taxEngineVersion: statement.taxEngineVersion || this.TAX_ENGINE_VERSION,
      commissionEngineVersion: statement.commissionEngineVersion || this.COMMISSION_ENGINE_VERSION,
      settlementEngineVersion: statement.settlementEngineVersion || this.SETTLEMENT_ENGINE_VERSION,
    };

    const parsedSourceRefs = statement.sourceReferences
      ? (typeof statement.sourceReferences === 'string' ? JSON.parse(statement.sourceReferences) : statement.sourceReferences)
      : {
          orderIds: [],
          sellerOrderIds: [],
          transactionIds: [],
          taxSnapshotIds: [],
          refundIds: [],
          settlementId: statement.settlementId,
        };

    const parsedMeta = statement.metadata
      ? (typeof statement.metadata === 'string' ? JSON.parse(statement.metadata) : statement.metadata)
      : {};

    const storeName = statement.seller?.stores?.[0]?.name || parsedMeta.storeName || 'متجر سوقناا';
    const sellerName = statement.seller?.user
      ? `${statement.seller.user.firstName || ''} ${statement.seller.user.lastName || ''}`.trim()
      : (parsedMeta.sellerName || 'تاجر سوقناا');

    return {
      statementId: statement.id,
      statementNumber: statement.statementNumber,
      statementType: statement.statementType,
      sellerId: statement.sellerId,
      settlementId: statement.settlementId,
      periodStart: statement.periodStart,
      periodEnd: statement.periodEnd,
      currency: statement.currency || 'YER',
      summary,
      lineItems,
      sourceReferences: parsedSourceRefs,
      calculationVersions: versions,
      metadata: {
        storeName,
        sellerName,
        sellerCrNumber: statement.seller?.commercialRegister || parsedMeta.sellerCrNumber,
        sellerTaxNumber: statement.seller?.taxNumber || parsedMeta.sellerTaxNumber,
        ...parsedMeta,
      },
      createdAt: statement.createdAt || new Date(),
    };
  }
}

