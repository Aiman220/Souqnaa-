/**
 * SOUQNAA Marketplace — Financial Statements Engine Types & Interfaces
 * Production-grade type definitions for SELLER_STATEMENT, SETTLEMENT_STATEMENT,
 * COMMISSION_STATEMENT, and TAX_STATEMENT.
 */

import {
  StatementType,
  StatementStatus,
  StatementPeriodType,
  StatementLineType,
  StatementAuditAction,
} from '@prisma/client';

export {
  StatementType,
  StatementStatus,
  StatementPeriodType,
  StatementLineType,
  StatementAuditAction,
};

export interface StatementPeriodBounds {
  periodType: StatementPeriodType;
  periodStart: Date;
  periodEnd: Date;
  timezone: string;
}

export interface StatementLineItemDto {
  lineIndex: number;
  transactionDate: Date;
  reference: string;
  orderId?: string;
  sellerOrderId?: string;
  transactionId?: string;
  type: StatementLineType;
  description: string;
  grossAmount: number;
  discountAmount: number;
  taxAmount: number;
  commissionAmount: number;
  adjustmentAmount: number;
  feeAmount: number;
  netAmount: number;
  currency: string;
  status: string;
  sourceType?: string;
  sourceId?: string;
  metadata?: Record<string, any>;
}

export interface SellerStatementSummary {
  openingBalance: number;
  grossSales: number;
  productDiscounts: number;
  refunds: number;
  tax: number;
  platformCommission: number;
  paymentFees: number;
  deliveryAdjustments: number;
  otherAuthorizedAdjustments: number;
  withdrawals: number;
  deposits: number;
  netActivity: number;
  closingBalance: number;
  totalOrdersCount: number;
  totalRefundsCount: number;
}

export interface SettlementStatementSummary {
  settlementNumber: string;
  settlementId: string;
  settlementDate: Date | null;
  grossSales: number;
  productDiscounts: number;
  refunds: number;
  platformCommission: number;
  paymentFees: number;
  authorizedAdjustments: number;
  taxAdjustments: number;
  netSettlement: number;
  settlementStatus: string;
  paymentReference?: string | null;
  totalOrdersCount: number;
}

export interface CommissionStatementSummary {
  grossSales: number;
  eligibleSales: number;
  commissionBase: number;
  effectiveCommissionRate: number;
  commissionAmount: number;
  commissionAdjustments: number;
  taxOnCommission: number;
  totalCommission: number;
  totalOrdersCount: number;
}

export interface TaxStatementSummary {
  grossTaxableSales: number;
  taxExemptSales: number;
  zeroRatedSales: number;
  taxableAmount: number;
  taxCollected: number;
  taxRefunded: number;
  netTax: number;
  totalTransactionsCount: number;
}

export type StatementSummary =
  | SellerStatementSummary
  | SettlementStatementSummary
  | CommissionStatementSummary
  | TaxStatementSummary;

export interface StatementEngineVersions {
  statementEngineVersion: string;
  taxEngineVersion: string;
  commissionEngineVersion: string;
  settlementEngineVersion: string;
}

export interface StatementSnapshotDto {
  statementId: string;
  statementNumber: string;
  statementType: StatementType;
  sellerId: string;
  settlementId?: string | null;
  periodStart: Date;
  periodEnd: Date;
  currency: string;
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
  calculationVersions: StatementEngineVersions;
  metadata?: {
    storeName?: string;
    sellerCrNumber?: string | null;
    sellerTaxNumber?: string | null;
    sellerName?: string;
    verificationHash?: string;
    qrPayload?: string;
  };
  createdAt: Date;
}

export interface GenerateStatementInput {
  sellerId: string;
  statementType: StatementType;
  periodType?: StatementPeriodType;
  periodStart?: Date;
  periodEnd?: Date;
  settlementId?: string;
  autoFinalize?: boolean;
}

export interface StatementQueryFilters {
  sellerId?: string;
  statementType?: StatementType;
  status?: StatementStatus;
  statementNumber?: string;
  settlementId?: string;
  orderId?: string;
  transactionId?: string;
  dateFrom?: Date;
  dateTo?: Date;
  currency?: string;
  page?: number;
  limit?: number;
}
