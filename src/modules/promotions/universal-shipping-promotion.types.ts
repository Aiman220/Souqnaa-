/**
 * SOUQNA — UNIVERSAL SHIPPING PROMOTIONS SYSTEM
 * Universal Types & Domain Definitions
 * Version: 2.0.0
 */

import {
  ShippingPromotionType,
  ShippingFundingType,
  ShippingPromotionStatus,
  ShippingPromotionStackingPolicy,
  PromotionReservationStatus,
} from '@prisma/client';

export {
  ShippingPromotionType,
  ShippingFundingType,
  ShippingPromotionStatus,
  ShippingPromotionStackingPolicy,
  PromotionReservationStatus,
};

export type PromotionReasonCode =
  | 'ELIGIBLE'
  | 'NOT_FIRST_ORDER'
  | 'NOT_NEW_CUSTOMER'
  | 'MINIMUM_SPEND_NOT_REACHED'
  | 'SELLER_NOT_ELIGIBLE'
  | 'ZONE_NOT_SUPPORTED'
  | 'DELIVERY_METHOD_NOT_SUPPORTED'
  | 'PROMOTION_EXPIRED'
  | 'PROMOTION_PAUSED'
  | 'PROMOTION_NOT_STARTED'
  | 'PROMOTION_BUDGET_EXHAUSTED'
  | 'CUSTOMER_USAGE_LIMIT_REACHED'
  | 'SELLER_USAGE_LIMIT_REACHED'
  | 'GLOBAL_USAGE_LIMIT_REACHED'
  | 'STACKING_NOT_ALLOWED'
  | 'PHONE_NOT_VERIFIED'
  | 'EMAIL_NOT_VERIFIED'
  | 'PROMOTION_NOT_FOUND'
  | 'PROMOTION_INACTIVE'
  | 'OUTSIDE_PROMOTION_WINDOW'
  | 'ORDER_STATUS_NOT_QUALIFIED'
  | 'MEMBERSHIP_TIER_NOT_QUALIFIED'
  | 'ABUSE_RESTRICTED';

export interface CustomerEvaluationContext {
  id: string;
  isNewCustomer?: boolean;
  completedOrderCount: number;
  accountAgeDays?: number;
  isPhoneVerified: boolean;
  isEmailVerified: boolean;
  isRestricted?: boolean;
  ipAddress?: string;
  membershipTier?: string;
  membershipTierLevel?: number;
}

export interface SellerEvaluationContext {
  id: string;
  previousOrderCountFromSeller: number; // completed orders customer made specifically with this seller
  isActive: boolean;
  isPromotionEnabled: boolean;
}

export interface OrderEvaluationContext {
  subtotal: number;
  itemCount: number;
  sellerCount: number;
  productIds: string[];
  categoryIds: string[];
}

export interface DeliveryEvaluationContext {
  deliveryMethod: string;
  deliveryZone?: string;
  distanceKm?: number;
  originalShippingAmount: number;
  sellerDeliveries: Array<{
    sellerId: string;
    deliveryFee: number;
    deliveryMethod?: string;
    deliveryZone?: string;
    distanceKm?: number;
  }>;
}

export interface TimeEvaluationContext {
  now?: Date;
  dayOfWeek?: number; // 0 = Sunday, 6 = Saturday
  hourOfDay?: number; // 0-23
}

export interface UniversalPromotionRuleContext {
  customer: CustomerEvaluationContext;
  order: OrderEvaluationContext;
  delivery: DeliveryEvaluationContext;
  sellers?: SellerEvaluationContext[];
  time?: TimeEvaluationContext;
}

export interface RuleEvaluationResult {
  ruleName: string;
  passed: boolean;
  reasonCode: PromotionReasonCode;
  message?: string;
}

export interface SellerShippingFundingAllocation {
  sellerId: string;
  originalDeliveryFee: number;
  shippingPromotionDiscount: number;
  customerDeliveryCharge: number;
  platformShippingSubsidy: number;
  sellerShippingContribution: number;
  sellerDeliveryReimbursement: number;
}

export interface ShippingFundingBreakdown {
  originalShippingAmount: number;
  customerShippingCharge: number;
  shippingPromotionDiscount: number;
  platformShippingSubsidy: number;
  sellerShippingContribution: number;
  sellerDeliveryReimbursement: number;
  fundingType: ShippingFundingType;
  isFreeShipping: boolean; // TRUE only if customerShippingCharge === 0
  sellerBreakdown: SellerShippingFundingAllocation[];
}

export interface PromotionEvaluationResult {
  eligible: boolean;
  promotionId: string;
  promotionCode: string;
  promotionName: string;
  promotionNameAr?: string | null;
  promotionType: ShippingPromotionType;
  fundingType: ShippingFundingType;
  priority: number;
  reasonCode: PromotionReasonCode;
  matchedRules: string[];
  failedRules: string[];
  expiresAt?: Date | null;
  calculation?: ShippingFundingBreakdown;
}

export interface StackingEvaluationResult {
  appliedPromotions: PromotionEvaluationResult[];
  rejectedPromotions: Array<{
    promotionId: string;
    promotionCode: string;
    reasonCode: PromotionReasonCode;
  }>;
  aggregateCalculation: ShippingFundingBreakdown;
}

export interface UniversalReservationResult {
  reservationId: string;
  promotionId: string;
  promotionCode: string;
  status: PromotionReservationStatus;
  expiresAt: Date;
  calculation: ShippingFundingBreakdown;
  idempotencyKey?: string | null;
}

export interface CreateShippingPromotionDto {
  code: string;
  name: string;
  nameAr?: string;
  description?: string;
  descriptionAr?: string;
  type: ShippingPromotionType;
  fundingType: ShippingFundingType;
  priority?: number;
  startAt?: string | null;
  endAt?: string | null;
  minimumOrderAmount?: number;
  maximumDiscountAmount?: number | null;
  percentageDiscount?: number;
  fixedDiscount?: number | null;
  customerEligibilityRules?: Record<string, any>;
  sellerEligibilityRules?: Record<string, any>;
  orderEligibilityRules?: Record<string, any>;
  deliveryEligibilityRules?: Record<string, any>;
  locationEligibilityRules?: Record<string, any>;
  allowedDeliveryMethods?: string[];
  allowedZones?: string[];
  allowedSellers?: string[];
  allowedProducts?: string[];
  allowedCategories?: string[];
  platformSubsidyRate?: number;
  sellerContributionRate?: number;
  platformSubsidyLimit?: number | null;
  sellerContributionLimit?: number | null;
  customerUsageLimit?: number | null;
  sellerUsageLimit?: number | null;
  globalUsageLimit?: number | null;
  campaignId?: string | null;
  campaignBudget?: number | null;
  requiresVerifiedPhone?: boolean;
  requiresVerifiedEmail?: boolean;
  abuseProtectionEnabled?: boolean;
  stackingPolicy?: ShippingPromotionStackingPolicy;
  reservationRequired?: boolean;
}

export interface UpdateShippingPromotionDto extends Partial<CreateShippingPromotionDto> {
  status?: ShippingPromotionStatus;
}
