/**
 * SOUQNA — UNIVERSAL SHIPPING PROMOTIONS SYSTEM
 * Universal Orchestrator Service
 * Version: 2.0.0
 */

import { prisma } from '../../../database/prisma';
import {
  UniversalPromotionRuleContext,
  PromotionEvaluationResult,
  StackingEvaluationResult,
  CreateShippingPromotionDto,
  UpdateShippingPromotionDto,
  ShippingPromotionStatus,
} from '../universal-shipping-promotion.types';
import { ShippingPromotionCalculationEngine } from './shipping-promotion-calculation.engine';
import { ShippingPromotionStackingEngine } from './shipping-promotion-stacking.engine';

export class UniversalShippingPromotionService {
  /**
   * Authoritatively evaluates all active shipping promotions for a customer checkout or cart context.
   * Resolves stacking policies and returns the aggregate financial allocation.
   */
  public static async evaluateCheckout(params: {
    context: UniversalPromotionRuleContext;
  }): Promise<StackingEvaluationResult> {
    const { context } = params;

    // 1. Fetch active shipping promotions
    const activePromotions = await prisma.shippingPromotion.findMany({
      where: {
        status: 'ACTIVE',
      },
      orderBy: { priority: 'desc' },
    });

    if (activePromotions.length === 0) {
      return {
        appliedPromotions: [],
        rejectedPromotions: [],
        aggregateCalculation: {
          originalShippingAmount: context.delivery.originalShippingAmount,
          customerShippingCharge: context.delivery.originalShippingAmount,
          shippingPromotionDiscount: 0,
          platformShippingSubsidy: 0,
          sellerShippingContribution: 0,
          sellerDeliveryReimbursement: 0,
          fundingType: 'PLATFORM',
          isFreeShipping: context.delivery.originalShippingAmount === 0,
          sellerBreakdown: [],
        },
      };
    }

    // 2. Fetch customer usage count for these promotions
    const usageCounts = await prisma.promotionUsage.groupBy({
      by: ['shippingPromotionId'],
      where: {
        customerId: context.customer.id,
        shippingPromotionId: { in: activePromotions.map((p) => p.id) },
        status: 'CONSUMED',
      },
      _count: { id: true },
    });

    const usageMap = new Map<string, number>();
    for (const u of usageCounts) {
      if (u.shippingPromotionId) {
        usageMap.set(u.shippingPromotionId, u._count.id);
      }
    }

    // 3. Evaluate each promotion
    const eligiblePromotions: PromotionEvaluationResult[] = [];
    const rejectedPromotions: Array<{
      promotionId: string;
      promotionCode: string;
      reasonCode: any;
    }> = [];

    for (const promo of activePromotions) {
      const customerUses = usageMap.get(promo.id) ?? 0;
      const result = ShippingPromotionCalculationEngine.evaluatePromotion({
        promotion: promo,
        context,
        customerUsageCount: customerUses,
      });

      if (result.eligible && result.calculation && result.calculation.shippingPromotionDiscount > 0) {
        eligiblePromotions.push(result);
      } else {
        rejectedPromotions.push({
          promotionId: promo.id,
          promotionCode: promo.code,
          reasonCode: result.reasonCode,
        });
      }
    }

    // 4. Resolve Stacking
    const stackingResult = ShippingPromotionStackingEngine.resolveStacking({
      eligiblePromotions,
      originalShippingAmount: context.delivery.originalShippingAmount,
    });

    // Merge rejected promotions
    stackingResult.rejectedPromotions.push(...rejectedPromotions);

    return stackingResult;
  }

  /**
   * Creates a new universal shipping promotion with validation and audit logging.
   */
  public static async createPromotion(
    dto: CreateShippingPromotionDto,
    actorId: string
  ) {
    const existing = await prisma.shippingPromotion.findUnique({
      where: { code: dto.code },
    });

    if (existing) {
      throw new Error(`Promotion code '${dto.code}' already exists`);
    }

    const created = await prisma.shippingPromotion.create({
      data: {
        code: dto.code.trim().toUpperCase(),
        name: dto.name,
        nameAr: dto.nameAr,
        description: dto.description,
        descriptionAr: dto.descriptionAr,
        type: dto.type,
        fundingType: dto.fundingType,
        status: 'ACTIVE',
        priority: dto.priority ?? 0,
        startAt: dto.startAt ? new Date(dto.startAt) : null,
        endAt: dto.endAt ? new Date(dto.endAt) : null,
        minimumOrderAmount: dto.minimumOrderAmount ?? 0,
        maximumDiscountAmount: dto.maximumDiscountAmount,
        percentageDiscount: dto.percentageDiscount ?? 100,
        fixedDiscount: dto.fixedDiscount,
        customerEligibilityRules: dto.customerEligibilityRules || {},
        sellerEligibilityRules: dto.sellerEligibilityRules || {},
        orderEligibilityRules: dto.orderEligibilityRules || {},
        deliveryEligibilityRules: dto.deliveryEligibilityRules || {},
        locationEligibilityRules: dto.locationEligibilityRules || {},
        allowedDeliveryMethods: dto.allowedDeliveryMethods || ['standard', 'asap', 'scheduled'],
        allowedZones: dto.allowedZones || [],
        allowedSellers: dto.allowedSellers || [],
        allowedProducts: dto.allowedProducts || [],
        allowedCategories: dto.allowedCategories || [],
        platformSubsidyRate: dto.platformSubsidyRate ?? 70.0,
        sellerContributionRate: dto.sellerContributionRate ?? 30.0,
        platformSubsidyLimit: dto.platformSubsidyLimit,
        sellerContributionLimit: dto.sellerContributionLimit,
        customerUsageLimit: dto.customerUsageLimit ?? 1,
        sellerUsageLimit: dto.sellerUsageLimit,
        globalUsageLimit: dto.globalUsageLimit,
        campaignId: dto.campaignId,
        campaignBudget: dto.campaignBudget,
        remainingBudget: dto.campaignBudget,
        consumedBudget: 0,
        requiresVerifiedPhone: dto.requiresVerifiedPhone ?? false,
        requiresVerifiedEmail: dto.requiresVerifiedEmail ?? false,
        abuseProtectionEnabled: dto.abuseProtectionEnabled ?? true,
        stackingPolicy: dto.stackingPolicy ?? 'BEST_SHIPPING_PROMOTION',
        reservationRequired: dto.reservationRequired ?? true,
        createdBy: actorId,
        updatedBy: actorId,
      },
    });

    // Audit log
    await prisma.shippingPromotionAuditLog.create({
      data: {
        promotionId: created.id,
        actorId,
        action: 'CREATE',
        newValue: JSON.stringify(created),
        reason: 'Universal shipping promotion created',
      },
    });

    return created;
  }

  /**
   * Updates an existing promotion.
   */
  public static async updatePromotion(
    id: string,
    dto: UpdateShippingPromotionDto,
    actorId: string
  ) {
    const existing = await prisma.shippingPromotion.findUnique({
      where: { id },
    });

    if (!existing) {
      throw new Error(`Promotion ${id} not found`);
    }

    const updated = await prisma.shippingPromotion.update({
      where: { id },
      data: {
        ...(dto.name !== undefined && { name: dto.name }),
        ...(dto.nameAr !== undefined && { nameAr: dto.nameAr }),
        ...(dto.description !== undefined && { description: dto.description }),
        ...(dto.descriptionAr !== undefined && { descriptionAr: dto.descriptionAr }),
        ...(dto.status !== undefined && { status: dto.status }),
        ...(dto.priority !== undefined && { priority: dto.priority }),
        ...(dto.startAt !== undefined && { startAt: dto.startAt ? new Date(dto.startAt) : null }),
        ...(dto.endAt !== undefined && { endAt: dto.endAt ? new Date(dto.endAt) : null }),
        ...(dto.minimumOrderAmount !== undefined && { minimumOrderAmount: dto.minimumOrderAmount }),
        ...(dto.maximumDiscountAmount !== undefined && { maximumDiscountAmount: dto.maximumDiscountAmount }),
        ...(dto.percentageDiscount !== undefined && { percentageDiscount: dto.percentageDiscount }),
        ...(dto.fixedDiscount !== undefined && { fixedDiscount: dto.fixedDiscount }),
        ...(dto.allowedDeliveryMethods !== undefined && { allowedDeliveryMethods: dto.allowedDeliveryMethods }),
        ...(dto.allowedZones !== undefined && { allowedZones: dto.allowedZones }),
        ...(dto.allowedSellers !== undefined && { allowedSellers: dto.allowedSellers }),
        ...(dto.allowedProducts !== undefined && { allowedProducts: dto.allowedProducts }),
        ...(dto.allowedCategories !== undefined && { allowedCategories: dto.allowedCategories }),
        ...(dto.platformSubsidyRate !== undefined && { platformSubsidyRate: dto.platformSubsidyRate }),
        ...(dto.sellerContributionRate !== undefined && { sellerContributionRate: dto.sellerContributionRate }),
        ...(dto.platformSubsidyLimit !== undefined && { platformSubsidyLimit: dto.platformSubsidyLimit }),
        ...(dto.sellerContributionLimit !== undefined && { sellerContributionLimit: dto.sellerContributionLimit }),
        ...(dto.customerUsageLimit !== undefined && { customerUsageLimit: dto.customerUsageLimit }),
        ...(dto.sellerUsageLimit !== undefined && { sellerUsageLimit: dto.sellerUsageLimit }),
        ...(dto.globalUsageLimit !== undefined && { globalUsageLimit: dto.globalUsageLimit }),
        ...(dto.campaignBudget !== undefined && { campaignBudget: dto.campaignBudget }),
        ...(dto.requiresVerifiedPhone !== undefined && { requiresVerifiedPhone: dto.requiresVerifiedPhone }),
        ...(dto.requiresVerifiedEmail !== undefined && { requiresVerifiedEmail: dto.requiresVerifiedEmail }),
        ...(dto.stackingPolicy !== undefined && { stackingPolicy: dto.stackingPolicy }),
        updatedBy: actorId,
      },
    });

    await prisma.shippingPromotionAuditLog.create({
      data: {
        promotionId: id,
        actorId,
        action: 'UPDATE',
        previousValue: JSON.stringify(existing),
        newValue: JSON.stringify(updated),
        reason: 'Universal shipping promotion updated',
      },
    });

    return updated;
  }

  /**
   * Updates promotion status (e.g. PAUSE, RESUME, CANCEL).
   */
  public static async setStatus(
    id: string,
    status: ShippingPromotionStatus,
    actorId: string,
    reason?: string
  ) {
    const existing = await prisma.shippingPromotion.findUnique({
      where: { id },
    });

    if (!existing) {
      throw new Error(`Promotion ${id} not found`);
    }

    const updated = await prisma.shippingPromotion.update({
      where: { id },
      data: {
        status,
        updatedBy: actorId,
      },
    });

    await prisma.shippingPromotionAuditLog.create({
      data: {
        promotionId: id,
        actorId,
        action: `SET_STATUS_${status}`,
        previousValue: existing.status,
        newValue: status,
        reason: reason || `Status changed to ${status}`,
      },
    });

    return updated;
  }

  /**
   * Retrieves promotion details and aggregated metrics.
   */
  public static async getPromotionAnalytics(promotionId: string) {
    const promo = await prisma.shippingPromotion.findUnique({
      where: { id: promotionId },
      include: {
        campaign: { select: { id: true, name: true } },
      },
    });

    if (!promo) {
      throw new Error(`Promotion ${promotionId} not found`);
    }

    const usageAggregation = await prisma.promotionUsage.aggregate({
      where: {
        shippingPromotionId: promotionId,
        status: 'CONSUMED',
      },
      _count: { id: true },
      _sum: {
        discountAmount: true,
        platformSubsidy: true,
        sellerContribution: true,
        sellerDeliveryReimbursement: true,
        originalShippingAmount: true,
      },
    });

    return {
      promotion: promo,
      metrics: {
        totalOrders: usageAggregation._count.id ?? 0,
        totalShippingDiscount: usageAggregation._sum.discountAmount ?? 0,
        totalPlatformSubsidy: usageAggregation._sum.platformSubsidy ?? 0,
        totalSellerContribution: usageAggregation._sum.sellerContribution ?? 0,
        totalSellerReimbursement: usageAggregation._sum.sellerDeliveryReimbursement ?? 0,
        totalOriginalShipping: usageAggregation._sum.originalShippingAmount ?? 0,
        consumedBudget: promo.consumedBudget,
        remainingBudget: promo.remainingBudget,
        budgetUtilizationRate:
          promo.campaignBudget && promo.campaignBudget > 0
            ? Math.round((promo.consumedBudget / promo.campaignBudget) * 10000) / 100
            : 0,
      },
    };
  }
}
