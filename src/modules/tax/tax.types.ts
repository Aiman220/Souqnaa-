/**
 * SOUQNAA Marketplace — Production-Grade Tax Engine Types
 * Pure TypeScript definitions for tax rules, calculations, breakdowns, and audit snapshots.
 */

import {
  TaxCalculationMethod,
  TaxTargetType,
  TaxExemptionEntityType,
  DiscountTaxTreatment,
  RoundingStrategy,
  RoundingLevel,
} from '@prisma/client';

export interface TaxCalculationItemInput {
  id: string; // CartItem ID or client temporary item identifier
  productId: string;
  variantId?: string | null;
  sellerId: string;
  categoryId?: string | null;
  productNameAr: string;
  productNameEn: string;
  unitPrice: number;
  quantity: number;
  discountAmount?: number; // Applicable voucher or promotional discount
}

export interface TaxCalculationFeeInput {
  type: 'SHIPPING' | 'PLATFORM_FEE' | 'PAYMENT_FEE';
  sellerId?: string;
  amount: number;
}

export interface TaxCalculationInput {
  items: TaxCalculationItemInput[];
  shippingAmount?: number;
  platformFee?: number;
  paymentFee?: number;
  sellerShippingAmounts?: Record<string, number>;
  customerId?: string;
  currency?: string;
  notes?: string;
}

export interface ItemTaxBreakdown {
  itemId: string;
  productId: string;
  variantId?: string | null;
  sellerId: string;
  productNameAr: string;
  productNameEn: string;
  unitPrice: number;
  quantity: number;
  grossAmount: number;
  discountAmount: number;
  taxableAmount: number;
  taxRate: number;
  taxAmount: number;
  calculationMethod: TaxCalculationMethod;
  priceIncludesTax: boolean;
  ruleId?: string | null;
  ruleCode?: string | null;
  ruleName?: string | null;
  ruleVersion: number;
  isExempt: boolean;
  exemptionReason?: string | null;
}

export interface SellerTaxBreakdown {
  sellerId: string;
  sellerSubtotal: number;
  sellerDiscount: number;
  sellerTaxableAmount: number;
  sellerProductTax: number;
  sellerShippingAmount: number;
  sellerShippingTax: number;
  sellerTotalTax: number;
  sellerTotal: number;
  items: ItemTaxBreakdown[];
}

export interface TaxCalculationResult {
  subtotal: number;
  discountTotal: number;
  taxableSubtotal: number;
  productTax: number;
  shippingTax: number;
  platformFeeTax: number;
  paymentFeeTax: number;
  totalTax: number;
  grandTotal: number;
  currency: string;
  priceIncludesTax: boolean;
  discountTreatment: DiscountTaxTreatment;
  roundingStrategy: RoundingStrategy;
  roundingLevel: RoundingLevel;
  tax: {
    name: string;
    rate: number;
    amount: number;
    taxableAmount: number;
  };
  breakdown: ItemTaxBreakdown[];
  sellerBreakdowns: Record<string, SellerTaxBreakdown>;
  calculatedAt: string;
  configVersion: number;
}

export interface RefundTaxItemInput {
  orderItemId: string;
  quantity: number;
  refundAmount: number;
}

export interface RefundTaxCalculationInput {
  orderId: string;
  items: RefundTaxItemInput[];
  refundShipping?: boolean;
  shippingRefundAmount?: number;
}

export interface RefundTaxItemResult {
  orderItemId: string;
  productId: string;
  sellerId: string;
  originalTax: number;
  previouslyRefundedTax: number;
  refundableTax: number;
  remainingTax: number;
}

export interface RefundTaxCalculationResult {
  orderId: string;
  totalRefundableTax: number;
  totalRefundableAmount: number;
  shippingTaxRefund: number;
  items: RefundTaxItemResult[];
  calculationReference: string;
  currency: string;
}

export interface CreateTaxRuleDto {
  name: string;
  code: string;
  description?: string;
  rate: number;
  calculationMethod?: TaxCalculationMethod;
  priceIncludesTax?: boolean;
  appliesToProducts?: boolean;
  appliesToShipping?: boolean;
  appliesToPlatformFees?: boolean;
  appliesToPaymentFees?: boolean;
  appliesToDiscounts?: boolean;
  active?: boolean;
  priority?: number;
  targetType?: TaxTargetType;
  targetId?: string | null;
  effectiveFrom?: string | Date | null;
  effectiveUntil?: string | Date | null;
}

export interface UpdateTaxRuleDto {
  name?: string;
  code?: string;
  description?: string;
  rate?: number;
  calculationMethod?: TaxCalculationMethod;
  priceIncludesTax?: boolean;
  appliesToProducts?: boolean;
  appliesToShipping?: boolean;
  appliesToPlatformFees?: boolean;
  appliesToPaymentFees?: boolean;
  appliesToDiscounts?: boolean;
  active?: boolean;
  priority?: number;
  targetType?: TaxTargetType;
  targetId?: string | null;
  effectiveFrom?: string | Date | null;
  effectiveUntil?: string | Date | null;
  changeReason?: string;
}

export interface CreateTaxExemptionDto {
  entityType: TaxExemptionEntityType;
  entityId: string;
  reason: string;
  validFrom?: string | Date | null;
  validUntil?: string | Date | null;
}

export interface UpdateTaxConfigDto {
  taxEnabled?: boolean;
  taxInclusivePrices?: boolean;
  taxOnShippingEnabled?: boolean;
  taxOnPlatformFeesEnabled?: boolean;
  taxOnPaymentFeesEnabled?: boolean;
  discountTreatment?: DiscountTaxTreatment;
  roundingStrategy?: RoundingStrategy;
  roundingLevel?: RoundingLevel;
  defaultTaxRuleId?: string | null;
  defaultRate?: number;
  currency?: string;
}
