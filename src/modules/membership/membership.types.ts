import {
  MembershipStatus,
  MembershipAuditChangeType,
} from '@prisma/client';

export { MembershipStatus, MembershipAuditChangeType };

export type QualificationMetric =
  | 'COMPLETED_ORDERS'
  | 'PERIOD_SPEND'
  | 'LIFETIME_SPEND'
  | 'POINTS_BALANCE'
  | 'ACCOUNT_AGE_DAYS';

export type QualificationOperator = 'GTE' | 'GT' | 'LTE' | 'LT' | 'EQ' | 'BETWEEN';

export type QualificationPeriodType =
  | 'LIFETIME'
  | 'ROLLING_DAYS'
  | 'CALENDAR_YEAR'
  | 'CALENDAR_QUARTER'
  | 'CALENDAR_MONTH'
  | 'CUSTOM_PERIOD';

export type SpendCalculationBasis =
  | 'PRODUCT_SUBTOTAL'
  | 'NET_ORDER_AMOUNT'
  | 'PAID_AMOUNT'
  | 'AFTER_DISCOUNTS'
  | 'AFTER_REFUNDS';

export type DowngradePolicy =
  | 'KEEP_TIER'
  | 'DOWNGRADE'
  | 'GRACE_PERIOD'
  | 'MANUAL_REVIEW';

export interface QualificationRuleItem {
  metric: QualificationMetric;
  operator: QualificationOperator;
  value: number;
  minValue?: number;
  maxValue?: number;
  periodDays?: number;
}

export interface QualificationRulesConfig {
  logic: 'ALL' | 'ANY';
  rules: QualificationRuleItem[];
}

export interface BenefitConfig {
  perks: string[];
  perksAr: string[];
  coinsMultiplier?: number; // e.g. 1.0, 1.05, 1.1, 1.2, 1.35
  freeShipping?: boolean;
  minOrderForFreeShipping?: number;
  prioritySupport?: boolean;
  exclusiveCampaignAccess?: boolean;
  discountPercentage?: number;
  returnWindowDays?: number;
  earlyFlashSaleAccessHours?: number;
  birthdayGift?: boolean;
  sellerSpecificBenefits?: Record<string, any>;
}

export interface ValidityConfig {
  periodType: QualificationPeriodType;
  days?: number; // e.g. 365
  gracePeriodDays?: number; // e.g. 30
  downgradePolicy?: DowngradePolicy;
}

export interface CustomerMetricsSnapshot {
  userId: string;
  completedOrders: number;
  periodCompletedOrders: number;
  lifetimeSpend: number;
  periodSpend: number;
  pointsBalance: number;
  accountAgeDays: number;
  evaluationTimestamp: string;
}

export interface TierProgressMetricResult {
  metric: 'SPEND' | 'ORDERS';
  current: number;
  target: number;
  remaining: number;
  percentage: number;
}

export interface MembershipTierSummary {
  id: string;
  code: string;
  nameAr: string;
  nameEn: string;
  descriptionAr?: string | null;
  descriptionEn?: string | null;
  level: number;
  priority: number;
  isActive: boolean;
  icon?: string | null;
  badgeAssetUrl?: string | null;
  benefits: BenefitConfig;
  qualificationRules: QualificationRulesConfig;
  validityConfig: ValidityConfig;
}

export interface CustomerMembershipSummary {
  tierId: string;
  tierCode: string;
  tierNameAr: string;
  tierNameEn: string;
  level: number;
  status: MembershipStatus;
  startedAt: string;
  expiresAt: string | null;
  renewedAt: string | null;
  gracePeriodEnd: string | null;
  isGracePeriod: boolean;
  badge: {
    visible: boolean;
    imageUrl: string | null;
    icon: string | null;
  };
  metrics: {
    lifetimeSpend: number;
    periodSpend: number;
    completedOrders: number;
    periodCompletedOrders: number;
    pointsBalance: number;
  };
  benefits: BenefitConfig;
  progress: {
    nextTierCode: string | null;
    nextTierNameAr: string | null;
    nextTierNameEn: string | null;
    nextTierLevel: number | null;
    metric: 'SPEND' | 'ORDERS';
    current: number;
    target: number;
    remaining: number;
    percentage: number;
    spendProgress: TierProgressMetricResult | null;
    orderProgress: TierProgressMetricResult | null;
  } | null;
  override?: {
    isActive: boolean;
    reason: string;
    endAt: string | null;
  } | null;
}

export interface MembershipEvaluationResult {
  userId: string;
  previousTierId: string | null;
  targetTierId: string;
  previousTierCode: string | null;
  targetTierCode: string;
  isUpgraded: boolean;
  isDowngraded: boolean;
  tierChanged: boolean;
  changeType: MembershipAuditChangeType;
  reason: string;
  membership: any;
}
