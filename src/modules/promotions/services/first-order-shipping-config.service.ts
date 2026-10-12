/**
 * SOUQNA — FIRST ORDER FREE SHIPPING ENGINE
 * Authoritative Promotion Configuration Service
 * Version: 1.0.0
 */

import { prisma } from '../../../database/prisma';
import { AppError } from '../../../middleware/error.middleware';
import { ShippingPromotionCostBearer } from '@prisma/client';
import { FirstOrderShippingConfigDto } from '../first-order-shipping.types';

export class FirstOrderShippingConfigService {
  private static cachedConfig: FirstOrderShippingConfigDto | null = null;
  private static cacheExpiresAt: number = 0;
  private static readonly CACHE_TTL_MS = 60 * 1000; // 60 seconds TTL

  /**
   * Retrieves the authoritative configuration with caching.
   * Auto-initializes default database record if absent.
   */
  public static async getConfig(): Promise<FirstOrderShippingConfigDto> {
    const now = Date.now();
    if (this.cachedConfig && now < this.cacheExpiresAt) {
      return this.cachedConfig;
    }

    let record = await prisma.firstOrderFreeShippingConfig.findFirst({
      orderBy: { createdAt: 'asc' },
    });

    if (!record) {
      // Initialize production default config
      record = await prisma.firstOrderFreeShippingConfig.create({
        data: {
          enabled: true,
          minOrderAmount: 0.0,
          maxDiscount: null, // Unlimited / full shipping covered by default
          costBearer: ShippingPromotionCostBearer.PLATFORM,
          platformSubsidyLimit: null,
          sellerContributionLimit: null,
          sharedPlatformPercentage: 70.0,
          allowedDeliveryMethods: ['standard', 'asap', 'scheduled'],
          allowedZones: [],
          allowedSellers: [],
          startAt: null,
          endAt: null,
          usageLimit: null,
          customerLimit: 1,
          platformBudget: 1000000.0, // 1,000,000 YER initial campaign budget
          consumedBudget: 0.0,
          requireVerifiedPhone: false,
          requireVerifiedEmail: false,
          abuseProtectionEnabled: true,
          eligibleOrderStatuses: ['CONFIRMED', 'PROCESSING', 'READY_TO_SHIP', 'SHIPPED', 'DELIVERED'],
          version: 1,
        },
      });
    }

    const dto: FirstOrderShippingConfigDto = {
      enabled: record.enabled,
      minOrderAmount: record.minOrderAmount,
      maxDiscount: record.maxDiscount,
      costBearer: record.costBearer,
      platformSubsidyLimit: record.platformSubsidyLimit,
      sellerContributionLimit: record.sellerContributionLimit,
      sharedPlatformPercentage: record.sharedPlatformPercentage ?? 70.0,
      allowedDeliveryMethods: record.allowedDeliveryMethods,
      allowedZones: record.allowedZones,
      allowedSellers: record.allowedSellers,
      startAt: record.startAt ? record.startAt.toISOString() : null,
      endAt: record.endAt ? record.endAt.toISOString() : null,
      usageLimit: record.usageLimit,
      customerLimit: record.customerLimit,
      platformBudget: record.platformBudget,
      consumedBudget: record.consumedBudget,
      requireVerifiedPhone: record.requireVerifiedPhone,
      requireVerifiedEmail: record.requireVerifiedEmail,
      abuseProtectionEnabled: record.abuseProtectionEnabled,
      eligibleOrderStatuses: record.eligibleOrderStatuses,
      version: record.version,
    };

    this.cachedConfig = dto;
    this.cacheExpiresAt = now + this.CACHE_TTL_MS;
    return dto;
  }

  /**
   * Invalidates in-memory cache
   */
  public static invalidateCache(): void {
    this.cachedConfig = null;
    this.cacheExpiresAt = 0;
  }

  /**
   * Updates configuration with elevated RBAC and immutable audit logging.
   */
  public static async updateConfig(params: {
    actorId: string;
    reason: string;
    updates: Partial<FirstOrderShippingConfigDto>;
  }): Promise<FirstOrderShippingConfigDto> {
    if (!params.reason || params.reason.trim().length < 5) {
      throw new AppError('سبب التعديل إلزامي ويجب أن يوضح الغرض من التغيير الإداري', 400);
    }

    const existing = await this.getConfig();

    const dataToUpdate: any = {
      version: { increment: 1 },
      updatedBy: params.actorId,
    };

    if (params.updates.enabled !== undefined) dataToUpdate.enabled = Boolean(params.updates.enabled);
    if (params.updates.minOrderAmount !== undefined) dataToUpdate.minOrderAmount = Math.max(0, Number(params.updates.minOrderAmount));
    if (params.updates.maxDiscount !== undefined) {
      dataToUpdate.maxDiscount = params.updates.maxDiscount !== null ? Math.max(0, Number(params.updates.maxDiscount)) : null;
    }
    if (params.updates.costBearer !== undefined) {
      if (!Object.values(ShippingPromotionCostBearer).includes(params.updates.costBearer)) {
        throw new AppError('جهة تحمل تكلفة التوصيل غير صالحة', 400);
      }
      dataToUpdate.costBearer = params.updates.costBearer;
    }
    if (params.updates.platformSubsidyLimit !== undefined) {
      dataToUpdate.platformSubsidyLimit = params.updates.platformSubsidyLimit !== null ? Math.max(0, Number(params.updates.platformSubsidyLimit)) : null;
    }
    if (params.updates.sellerContributionLimit !== undefined) {
      dataToUpdate.sellerContributionLimit = params.updates.sellerContributionLimit !== null ? Math.max(0, Number(params.updates.sellerContributionLimit)) : null;
    }
    if (params.updates.sharedPlatformPercentage !== undefined) {
      dataToUpdate.sharedPlatformPercentage = Math.min(100, Math.max(0, Number(params.updates.sharedPlatformPercentage)));
    }
    if (params.updates.allowedDeliveryMethods !== undefined) {
      dataToUpdate.allowedDeliveryMethods = params.updates.allowedDeliveryMethods;
    }
    if (params.updates.allowedZones !== undefined) dataToUpdate.allowedZones = params.updates.allowedZones;
    if (params.updates.allowedSellers !== undefined) dataToUpdate.allowedSellers = params.updates.allowedSellers;
    if (params.updates.startAt !== undefined) {
      dataToUpdate.startAt = params.updates.startAt ? new Date(params.updates.startAt) : null;
    }
    if (params.updates.endAt !== undefined) {
      dataToUpdate.endAt = params.updates.endAt ? new Date(params.updates.endAt) : null;
    }
    if (params.updates.usageLimit !== undefined) {
      dataToUpdate.usageLimit = params.updates.usageLimit !== null ? Math.max(1, Number(params.updates.usageLimit)) : null;
    }
    if (params.updates.customerLimit !== undefined) {
      dataToUpdate.customerLimit = Math.max(1, Number(params.updates.customerLimit));
    }
    if (params.updates.platformBudget !== undefined) {
      dataToUpdate.platformBudget = params.updates.platformBudget !== null ? Math.max(0, Number(params.updates.platformBudget)) : null;
    }
    if (params.updates.requireVerifiedPhone !== undefined) {
      dataToUpdate.requireVerifiedPhone = Boolean(params.updates.requireVerifiedPhone);
    }
    if (params.updates.requireVerifiedEmail !== undefined) {
      dataToUpdate.requireVerifiedEmail = Boolean(params.updates.requireVerifiedEmail);
    }
    if (params.updates.abuseProtectionEnabled !== undefined) {
      dataToUpdate.abuseProtectionEnabled = Boolean(params.updates.abuseProtectionEnabled);
    }
    if (params.updates.eligibleOrderStatuses !== undefined) {
      dataToUpdate.eligibleOrderStatuses = params.updates.eligibleOrderStatuses;
    }

    const currentRecord = await prisma.firstOrderFreeShippingConfig.findFirst({
      orderBy: { createdAt: 'asc' },
    });

    if (!currentRecord) {
      throw new AppError('إعدادات الحملة غير متوفرة', 404);
    }

    const updated = await prisma.$transaction(async (tx) => {
      const up = await tx.firstOrderFreeShippingConfig.update({
        where: { id: currentRecord.id },
        data: dataToUpdate,
      });

      // Audit Log
      await tx.promotionConfigAuditLog.create({
        data: {
          actorId: params.actorId,
          promotionType: 'FIRST_ORDER_FREE_SHIPPING',
          action: 'UPDATE_CONFIG',
          reason: params.reason,
          previousValue: JSON.stringify(existing),
          newValue: JSON.stringify(up),
        },
      });

      return up;
    });

    this.invalidateCache();
    return this.getConfig();
  }

  /**
   * Concurrency-safe budget check and reservation
   */
  public static async checkAndReserveBudget(
    subsidyAmount: number,
    tx?: any
  ): Promise<{ hasBudget: boolean; remaining: number | null }> {
    const client = tx || prisma;
    const configRecord = await client.firstOrderFreeShippingConfig.findFirst({
      orderBy: { createdAt: 'asc' },
    });

    if (!configRecord || configRecord.platformBudget === null) {
      return { hasBudget: true, remaining: null };
    }

    const remaining = configRecord.platformBudget - configRecord.consumedBudget;
    if (remaining < subsidyAmount) {
      return { hasBudget: false, remaining };
    }

    return { hasBudget: true, remaining: remaining - subsidyAmount };
  }
}
