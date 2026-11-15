import { prisma } from '../../database/prisma';
import { redis } from '../../database/redis';
import { AppError } from '../../middleware/error.middleware';
import {
  APPROVED_CUSTOMER_APP_ICONS,
  ALL_CUSTOMER_APP_ICONS,
  APPROVED_SELLER_APP_ICONS,
  LauncherIconConfigRecord,
} from './feature-flags.defaults';

export interface LauncherResolutionResult {
  applicationType: 'CUSTOMER' | 'SELLER';
  platform: 'ANDROID' | 'IOS';
  activeIconId: string;
  activeIconUrl: string;
  isSeasonalActive: boolean;
  campaignName: string | null;
  deepLinkUrl: string | null;
  publishedVersion: number;
  updatedAt: string;
}

export class LauncherCampaignService {
  private static instance: LauncherCampaignService;

  public static getInstance(): LauncherCampaignService {
    if (!LauncherCampaignService.instance) {
      LauncherCampaignService.instance = new LauncherCampaignService();
    }
    return LauncherCampaignService.instance;
  }

  private getCacheKey(appType: string, platform: string): string {
    return `remote_config:launcher:${appType.toLowerCase()}:${platform.toLowerCase()}`;
  }

  /**
   * Normalize and validate an icon identifier for a specific application.
   */
  public normalizeIconId(
    raw: string | null | undefined,
    appType: 'CUSTOMER' | 'SELLER',
    isSeasonal = false
  ): string {
    const defaultVal = appType === 'CUSTOMER' ? 'default' : 'seller_default';
    const seasonalVal = appType === 'CUSTOMER' ? 'seasonal' : 'seller_seasonal';

    if (!raw) return isSeasonal ? seasonalVal : defaultVal;
    const lower = raw.trim().toLowerCase();
    if (lower.length === 0) return isSeasonal ? seasonalVal : defaultVal;

    const approvedList =
      appType === 'CUSTOMER'
        ? (ALL_CUSTOMER_APP_ICONS as readonly string[])
        : (APPROVED_SELLER_APP_ICONS as readonly string[]);

    const exact = approvedList.find((id) => lower === id);
    if (exact) {
      return exact;
    }

    if (isSeasonal) {
      for (const id of approvedList) {
        if (
          id !== defaultVal &&
          id !== 'default' &&
          (lower.includes(`_${id}`) || lower.includes(`_${id}.`) || lower.includes(`/${id}.`))
        ) {
          return id;
        }
      }
      return seasonalVal;
    }

    for (const id of approvedList) {
      if (
        lower.includes(`_${id}.`) ||
        lower.includes(`/${id}.`) ||
        lower.endsWith(`/${id}`)
      ) {
        return id;
      }
    }

    return defaultVal;
  }

  /**
   * Validate that an icon identifier or URL is valid and approved.
   */
  public validateIconTarget(target: string, appType: 'CUSTOMER' | 'SELLER'): string {
    const trimmed = target.trim();
    const lower = trimmed.toLowerCase();
    const approvedList =
      appType === 'CUSTOMER'
        ? (ALL_CUSTOMER_APP_ICONS as readonly string[])
        : (APPROVED_SELLER_APP_ICONS as readonly string[]);

    // 1. Exact match has highest priority
    const exact = approvedList.find((id) => lower === id);
    if (exact) {
      return exact;
    }

    // 2. Filename and pattern matching
    const matched = approvedList.find(
      (id) =>
        lower.includes(`app_icon_${id}`) ||
        lower.includes(`seller_icon_${id}`) ||
        lower.includes(`_${id}.`) ||
        lower.includes(`/${id}.`) ||
        lower.endsWith(`/${id}`)
    );

    if (matched) {
      return matched;
    }

    if (
      trimmed.startsWith('http://') ||
      trimmed.startsWith('https://') ||
      trimmed.startsWith('/uploads/') ||
      trimmed.startsWith('uploads/') ||
      trimmed.startsWith('/storage/') ||
      trimmed.startsWith('storage/') ||
      trimmed.startsWith('assets/') ||
      /\.(png|jpg|jpeg|webp|svg|ico)$/i.test(trimmed)
    ) {
      return trimmed;
    }

    throw new AppError(
      `معرّف أيقونة التطبيق غير معتمد لـ [${appType}]. المعرفات المعتمدة: ${approvedList.join(', ')}`,
      400
    );
  }

  /**
   * Retrieve single configuration for an application + platform pair.
   */
  public async getConfig(
    applicationType: 'CUSTOMER' | 'SELLER',
    platform: 'ANDROID' | 'IOS'
  ): Promise<LauncherIconConfigRecord> {
    const cacheKey = this.getCacheKey(applicationType, platform);
    try {
      const cached = await redis.get(cacheKey);
      if (cached) {
        return JSON.parse(cached);
      }
    } catch (_) {}

    const record = await prisma.launcherIconConfig.findUnique({
      where: {
        applicationType_platform: {
          applicationType: applicationType as any,
          platform: platform as any,
        },
      },
    });

    if (record) {
      const parsed: LauncherIconConfigRecord = {
        id: record.id,
        applicationType: record.applicationType as any,
        platform: record.platform as any,
        defaultIconId: record.defaultIconId,
        defaultIconUrl: record.defaultIconUrl,
        seasonalIconId: record.seasonalIconId,
        seasonalIconUrl: record.seasonalIconUrl,
        seasonalEnabled: record.seasonalEnabled,
        campaignName: record.campaignName,
        campaignDeepLink: record.campaignDeepLink,
        campaignStartAt: record.campaignStartAt ? record.campaignStartAt.toISOString() : null,
        campaignEndAt: record.campaignEndAt ? record.campaignEndAt.toISOString() : null,
        timezone: record.timezone,
        publishedVersion: record.publishedVersion,
        updatedAt: record.updatedAt.toISOString(),
        updatedBy: record.updatedBy,
      };

      try {
        await redis.set(cacheKey, JSON.stringify(parsed), 60);
      } catch (_) {}

      return parsed;
    }

    // Default fallback if not yet seeded
    const isCustomer = applicationType === 'CUSTOMER';
    const fallback: LauncherIconConfigRecord = {
      id: `${applicationType}_${platform}`,
      applicationType,
      platform,
      defaultIconId: isCustomer ? 'default' : 'seller_default',
      defaultIconUrl: isCustomer
        ? '/uploads/branding/souqnaa-app-icon.png'
        : '/uploads/branding/seller_app_icon.png',
      seasonalIconId: isCustomer ? 'seasonal' : 'seller_seasonal',
      seasonalIconUrl: '',
      seasonalEnabled: false,
      campaignName: '',
      campaignDeepLink: isCustomer ? 'souqnaa-customer://app/open' : 'souqnaa-seller://app/open',
      campaignStartAt: null,
      campaignEndAt: null,
      timezone: 'Asia/Aden',
      publishedVersion: 1,
      updatedAt: new Date().toISOString(),
      updatedBy: null,
    };

    return fallback;
  }

  /**
   * Retrieve all 4 independent launcher configurations.
   */
  public async getAllConfigs(): Promise<Record<string, LauncherIconConfigRecord>> {
    const pairs: Array<['CUSTOMER' | 'SELLER', 'ANDROID' | 'IOS']> = [
      ['CUSTOMER', 'ANDROID'],
      ['CUSTOMER', 'IOS'],
      ['SELLER', 'ANDROID'],
      ['SELLER', 'IOS'],
    ];

    const results: Record<string, LauncherIconConfigRecord> = {};
    for (const [app, plat] of pairs) {
      results[`${app}_${plat}`] = await this.getConfig(app, plat);
    }
    return results;
  }

  /**
   * Campaign Scheduling Engine: Authoritative resolution of active icon.
   *
   * IF seasonalEnabled = false:
   *   activeIcon = defaultIcon
   * ELSE IF currentTime < campaignStartAt:
   *   activeIcon = defaultIcon
   * ELSE IF campaignStartAt <= currentTime < campaignEndAt:
   *   activeIcon = seasonalIcon
   * ELSE:
   *   activeIcon = defaultIcon
   */
  public resolveLauncherIcon(
    config: LauncherIconConfigRecord,
    currentTime: Date = new Date()
  ): LauncherResolutionResult {
    const {
      applicationType,
      platform,
      defaultIconId,
      defaultIconUrl,
      seasonalIconId,
      seasonalIconUrl,
      seasonalEnabled,
      campaignName,
      campaignDeepLink,
      campaignStartAt,
      campaignEndAt,
      publishedVersion,
      updatedAt,
    } = config;

    const baseIcon = defaultIconId || (applicationType === 'CUSTOMER' ? 'default' : 'seller_default');
    const baseIconUrl = defaultIconUrl || '';

    // If seasonal campaign is not enabled, or seasonal asset is missing/empty, return default icon
    if (!seasonalEnabled || !seasonalIconUrl || seasonalIconUrl.trim().length === 0) {
      return {
        applicationType,
        platform,
        activeIconId: baseIcon,
        activeIconUrl: baseIconUrl,
        isSeasonalActive: false,
        campaignName: null,
        deepLinkUrl: campaignDeepLink || null,
        publishedVersion,
        updatedAt: typeof updatedAt === 'string' ? updatedAt : updatedAt.toISOString(),
      };
    }

    const nowUtcMs = currentTime.getTime();
    const startUtcMs = campaignStartAt ? new Date(campaignStartAt).getTime() : null;
    const endUtcMs = campaignEndAt ? new Date(campaignEndAt).getTime() : null;

    // Check future campaign start boundary
    if (startUtcMs !== null && !isNaN(startUtcMs) && nowUtcMs < startUtcMs) {
      return {
        applicationType,
        platform,
        activeIconId: baseIcon,
        activeIconUrl: baseIconUrl,
        isSeasonalActive: false,
        campaignName: campaignName || null,
        deepLinkUrl: campaignDeepLink || null,
        publishedVersion,
        updatedAt: typeof updatedAt === 'string' ? updatedAt : updatedAt.toISOString(),
      };
    }

    // Check campaign expiration boundary
    if (endUtcMs !== null && !isNaN(endUtcMs) && nowUtcMs >= endUtcMs) {
      return {
        applicationType,
        platform,
        activeIconId: baseIcon,
        activeIconUrl: baseIconUrl,
        isSeasonalActive: false,
        campaignName: campaignName || null,
        deepLinkUrl: campaignDeepLink || null,
        publishedVersion,
        updatedAt: typeof updatedAt === 'string' ? updatedAt : updatedAt.toISOString(),
      };
    }

    // Active seasonal campaign window
    const activeSeasonalId =
      seasonalIconId || (applicationType === 'CUSTOMER' ? 'seasonal' : 'seller_seasonal');

    return {
      applicationType,
      platform,
      activeIconId: activeSeasonalId,
      activeIconUrl: seasonalIconUrl,
      isSeasonalActive: true,
      campaignName: campaignName || null,
      deepLinkUrl: campaignDeepLink || null,
      publishedVersion,
      updatedAt: typeof updatedAt === 'string' ? updatedAt : updatedAt.toISOString(),
    };
  }

  /**
   * Update and publish a specific application + platform launcher configuration.
   */
  public async updateLauncherConfig(
    applicationType: 'CUSTOMER' | 'SELLER',
    platform: 'ANDROID' | 'IOS',
    updates: Partial<LauncherIconConfigRecord>,
    adminUser: { id: string; email?: string }
  ): Promise<LauncherIconConfigRecord> {
    const existing = await this.getConfig(applicationType, platform);

    // 1. Validate dates if provided
    let startAt: Date | null = existing.campaignStartAt ? new Date(existing.campaignStartAt) : null;
    let endAt: Date | null = existing.campaignEndAt ? new Date(existing.campaignEndAt) : null;

    if (updates.campaignStartAt !== undefined) {
      startAt = updates.campaignStartAt ? new Date(updates.campaignStartAt) : null;
      if (startAt && isNaN(startAt.getTime())) {
        throw new AppError('صيغة تاريخ بداية الحملة غير صالحة', 400);
      }
    }

    if (updates.campaignEndAt !== undefined) {
      endAt = updates.campaignEndAt ? new Date(updates.campaignEndAt) : null;
      if (endAt && isNaN(endAt.getTime())) {
        throw new AppError('صيغة تاريخ نهاية الحملة غير صالحة', 400);
      }
    }

    if (startAt && endAt && endAt.getTime() <= startAt.getTime()) {
      throw new AppError('تاريخ نهاية الحملة يجب أن يكون بعد تاريخ البداية بشكل صحيح', 400);
    }

    // 2. Validate icon targets if provided
    let defaultIconId = existing.defaultIconId;
    if (updates.defaultIconId !== undefined && updates.defaultIconId.trim().length > 0) {
      defaultIconId = this.validateIconTarget(updates.defaultIconId, applicationType);
    }

    let defaultIconUrl = existing.defaultIconUrl;
    if (updates.defaultIconUrl !== undefined && updates.defaultIconUrl.trim().length > 0) {
      defaultIconUrl = updates.defaultIconUrl.trim();
    }

    let seasonalIconId = existing.seasonalIconId;
    if (updates.seasonalIconId !== undefined) {
      if (updates.seasonalIconId && updates.seasonalIconId.trim().length > 0) {
        seasonalIconId = this.validateIconTarget(updates.seasonalIconId, applicationType);
      } else {
        seasonalIconId = applicationType === 'CUSTOMER' ? 'seasonal' : 'seller_seasonal';
      }
    }

    let seasonalIconUrl = existing.seasonalIconUrl;
    if (updates.seasonalIconUrl !== undefined) {
      seasonalIconUrl = updates.seasonalIconUrl ? updates.seasonalIconUrl.trim() : '';
    }

    const seasonalEnabled =
      updates.seasonalEnabled !== undefined ? Boolean(updates.seasonalEnabled) : existing.seasonalEnabled;

    const campaignName =
      updates.campaignName !== undefined ? updates.campaignName : existing.campaignName;

    const campaignDeepLink =
      updates.campaignDeepLink !== undefined ? updates.campaignDeepLink : existing.campaignDeepLink;

    const timezone = updates.timezone || existing.timezone || 'Asia/Aden';
    const newVersion = (existing.publishedVersion || 1) + 1;

    // 3. Atomically upsert into database
    const upserted = await prisma.launcherIconConfig.upsert({
      where: {
        applicationType_platform: {
          applicationType: applicationType as any,
          platform: platform as any,
        },
      },
      create: {
        applicationType: applicationType as any,
        platform: platform as any,
        defaultIconId,
        defaultIconUrl,
        seasonalIconId,
        seasonalIconUrl,
        seasonalEnabled,
        campaignName,
        campaignDeepLink,
        campaignStartAt: startAt,
        campaignEndAt: endAt,
        timezone,
        publishedVersion: newVersion,
        updatedBy: adminUser.email || adminUser.id,
      },
      update: {
        defaultIconId,
        defaultIconUrl,
        seasonalIconId,
        seasonalIconUrl,
        seasonalEnabled,
        campaignName,
        campaignDeepLink,
        campaignStartAt: startAt,
        campaignEndAt: endAt,
        timezone,
        publishedVersion: newVersion,
        updatedBy: adminUser.email || adminUser.id,
      },
    });

    const result: LauncherIconConfigRecord = {
      id: upserted.id,
      applicationType: upserted.applicationType as any,
      platform: upserted.platform as any,
      defaultIconId: upserted.defaultIconId,
      defaultIconUrl: upserted.defaultIconUrl,
      seasonalIconId: upserted.seasonalIconId,
      seasonalIconUrl: upserted.seasonalIconUrl,
      seasonalEnabled: upserted.seasonalEnabled,
      campaignName: upserted.campaignName,
      campaignDeepLink: upserted.campaignDeepLink,
      campaignStartAt: upserted.campaignStartAt ? upserted.campaignStartAt.toISOString() : null,
      campaignEndAt: upserted.campaignEndAt ? upserted.campaignEndAt.toISOString() : null,
      timezone: upserted.timezone,
      publishedVersion: upserted.publishedVersion,
      updatedAt: upserted.updatedAt.toISOString(),
      updatedBy: upserted.updatedBy,
    };

    // 4. Invalidate Redis and Memory Cache
    const cacheKey = this.getCacheKey(applicationType, platform);
    try {
      await redis.del(cacheKey);
      await redis.delPattern('remote_config:*');
    } catch (_) {}

    // 5. Audit Logging
    await prisma.featureFlagAuditLog.create({
      data: {
        featureKey: `launcher_${applicationType.toLowerCase()}_${platform.toLowerCase()}`,
        action: seasonalEnabled ? 'ENABLE_CAMPAIGN' : 'UPDATE_CONFIG',
        oldValue: JSON.stringify(existing),
        newValue: JSON.stringify(result),
        reason: `تحديث أيقونة التطبيق والحملة الموسمية لـ [${applicationType} - ${platform}]`,
        changedBy: adminUser.email || adminUser.id,
      },
    });

    return result;
  }

  /**
   * Idempotent background reconciliation of all campaign schedules.
   * Restores default icon if campaign expired or not yet started.
   */
  public async reconcileAllCampaignSchedules(
    now: Date = new Date()
  ): Promise<{ reconciledCount: number; changed: string[] }> {
    const configs = await prisma.launcherIconConfig.findMany({
      where: { seasonalEnabled: true },
    });

    let reconciledCount = 0;
    const changed: string[] = [];

    for (const c of configs) {
      if (c.campaignEndAt && now.getTime() >= c.campaignEndAt.getTime()) {
        // Campaign has expired! Automatically deactivate seasonal icon and restore default
        await prisma.launcherIconConfig.update({
          where: { id: c.id },
          data: {
            seasonalEnabled: false,
            publishedVersion: c.publishedVersion + 1,
            updatedBy: 'system:scheduler',
          },
        });

        const cacheKey = this.getCacheKey(c.applicationType, c.platform);
        try {
          await redis.del(cacheKey);
          await redis.delPattern('remote_config:*');
        } catch (_) {}

        await prisma.featureFlagAuditLog.create({
          data: {
            featureKey: `launcher_${c.applicationType.toLowerCase()}_${c.platform.toLowerCase()}`,
            action: 'CAMPAIGN_EXPIRED',
            oldValue: JSON.stringify({ seasonalEnabled: true, campaignEndAt: c.campaignEndAt }),
            newValue: JSON.stringify({ seasonalEnabled: false }),
            reason: `انتهاء مدة الحملة الموسمية واستعادة الأيقونة الافتراضية تلقائياً`,
            changedBy: 'system:scheduler',
          },
        });

        reconciledCount++;
        changed.push(`${c.applicationType}_${c.platform}`);
      }
    }

    return { reconciledCount, changed };
  }
}

export const launcherCampaignService = LauncherCampaignService.getInstance();
