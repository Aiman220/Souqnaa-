/**
 * SOUQNA — FIRST ORDER FREE SHIPPING ENGINE
 * Authoritative Type Definitions & Interfaces
 * Version: 1.0.0
 */

import {
  ShippingPromotionCostBearer,
  PromotionReservationStatus,
  FirstOrderEligibilityStatus,
} from '@prisma/client';

import { DeviceIntegrityStatus, IntegrityEvidenceInput } from '../integrity/integrity.types';

export {
  ShippingPromotionCostBearer,
  PromotionReservationStatus,
  FirstOrderEligibilityStatus,
  DeviceIntegrityStatus,
};

export interface FirstOrderShippingConfigDto {
  enabled: boolean;
  minOrderAmount: number;
  maxDiscount: number | null;
  costBearer: ShippingPromotionCostBearer;
  platformSubsidyLimit: number | null;
  sellerContributionLimit: number | null;
  sharedPlatformPercentage: number;
  allowedDeliveryMethods: string[];
  allowedZones: string[];
  allowedSellers: string[];
  startAt: string | null;
  endAt: string | null;
  usageLimit: number | null;
  customerLimit: number;
  platformBudget: number | null;
  consumedBudget: number;
  requireVerifiedPhone: boolean;
  requireVerifiedEmail: boolean;
  abuseProtectionEnabled: boolean;
  eligibleOrderStatuses: string[];
  version: number;
}

export interface FirstOrderEligibilityInput {
  customerId: string;
  cartSubtotal: number;
  deliveryMethod?: string;
  deliveryZoneId?: string | null;
  deliveryZoneName?: string | null;
  sellerIds?: string[];
  ipAddress?: string;
  userAgent?: string;
  deviceId?: string;
  integrityEvidence?: IntegrityEvidenceInput;
}

export interface FirstOrderEligibilityResult {
  eligible: boolean;
  status: FirstOrderEligibilityStatus;
  messageAr: string;
  messageEn: string;
  minOrderAmount: number;
  maxDiscount: number | null;
  costBearer: ShippingPromotionCostBearer;
  expiresAt?: string;
  reservationId?: string;
  riskScore?: number;
  abuseSuspected?: boolean;
}

export interface FirstOrderAbuseEvaluation {
  abuseSuspected: boolean;
  riskScore: number; // 0 - 100
  reasons: string[];
  signals: {
    accountAgeDays: number;
    phoneVerified: boolean;
    emailVerified: boolean;
    priorOrdersCount: number;
    matchingPhoneCount: number;
    matchingAddressCount: number;
    deviceIntegrityStatus: DeviceIntegrityStatus;
    deviceIntegrityOk: boolean;
  };
}

export interface MultiSellerShippingAllocation {
  sellerId: string;
  originalDeliveryFee: number;
  shippingPromotionDiscount: number;
  customerDeliveryCharge: number;
  platformShippingSubsidy: number;
  sellerShippingContribution: number;
  sellerDeliveryReimbursement: number;
}

export interface FirstOrderShippingCalculation {
  originalShippingAmount: number;
  shippingPromotionDiscount: number;
  customerShippingCharge: number;
  platformShippingSubsidy: number;
  sellerShippingContribution: number;
  sellerDeliveryReimbursement: number;
  costBearer: ShippingPromotionCostBearer;
  isFullyFree: boolean;
  sellerBreakdown: MultiSellerShippingAllocation[];
}

export interface AdminFirstOrderDashboardMetrics {
  campaignActive: boolean;
  campaignBudget: number | null;
  consumedBudget: number;
  remainingBudget: number | null;
  budgetUtilizationPercentage: number;
  totalOrdersUsingPromotion: number;
  totalShippingDiscount: number;
  totalPlatformSubsidy: number;
  totalSellerContribution: number;
  totalSellerReimbursement: number;
  averageOrderValue: number;
  averageShippingDiscount: number;
  conversionRate: number;
  cancellationRate: number;
  refundRate: number;
  totalReservationsCount: number;
  activeReservationsCount: number;
  consumedReservationsCount: number;
  releasedReservationsCount: number;
  expiredReservationsCount: number;
  abuseEventsDetectedCount: number;
  costBearerBreakdown: {
    platform: number;
    seller: number;
    shared: number;
  };
}
