import { prisma } from '../../../database/prisma';
import { redis } from '../../../database/redis';
import { BannerAnalyticsEventType } from '@prisma/client';

export interface TrackEventParams {
  bannerId: string;
  eventType: BannerAnalyticsEventType;
  customerId?: string | null;
  sessionId?: string | null;
  anonymousId?: string | null;
  platform?: string | null;
  deviceType?: string | null;
  locale?: string | null;
  ipAddress?: string | null;
  metadata?: Record<string, any>;
}

export interface TrackConversionParams {
  bannerId: string;
  orderId?: string | null;
  customerId?: string | null;
  sessionId?: string | null;
  revenue: number;
  currency?: string;
  attributionWindowDays?: number;
}

const DEDUPLICATION_TTL_SECONDS = 600; // 10 minutes per impression session

class BannerAnalyticsService {
  /**
   * Tracks an event with impression deduplication.
   * Returns true if event was newly counted, false if deduplicated.
   */
  async trackEvent(params: TrackEventParams): Promise<boolean> {
    const { bannerId, eventType, customerId, sessionId, anonymousId } = params;

    // Deduplication for IMPRESSION
    if (eventType === 'IMPRESSION') {
      const actorId = customerId || sessionId || anonymousId;
      if (actorId) {
        const dedupKey = `dedup:imp:${bannerId}:${actorId}`;
        const exists = await redis.get(dedupKey);
        if (exists) {
          // Already recorded recently, skip incrementing aggregate count
          return false;
        }
        // Mark as recorded
        await redis.set(dedupKey, '1', DEDUPLICATION_TTL_SECONDS);
      }
    }

    // Resolve banner to find campaignId & placementId
    const banner = await prisma.promotionalBanner.findUnique({
      where: { id: bannerId },
      select: { id: true, campaignId: true, placementId: true },
    });

    if (!banner) return false;

    // Record event in database
    await prisma.bannerAnalyticsEvent.create({
      data: {
        bannerId: banner.id,
        campaignId: banner.campaignId,
        placementId: banner.placementId,
        eventType,
        customerId: customerId || null,
        sessionId: sessionId || null,
        anonymousId: anonymousId || null,
        platform: params.platform || 'MOBILE',
        deviceType: params.deviceType || null,
        locale: params.locale || 'ar',
        ipAddress: params.ipAddress || null,
        metadata: params.metadata || {},
      },
    });

    // Update aggregate denormalized counters on banner
    if (eventType === 'IMPRESSION') {
      await prisma.promotionalBanner.update({
        where: { id: banner.id },
        data: { impressionCount: { increment: 1 } },
      });
    } else if (eventType === 'CLICK') {
      await prisma.promotionalBanner.update({
        where: { id: banner.id },
        data: { clickCount: { increment: 1 } },
      });
    }

    return true;
  }

  /**
   * Tracks a conversion and creates attribution record.
   */
  async trackConversion(params: TrackConversionParams): Promise<void> {
    const { bannerId, orderId, customerId, sessionId, revenue, currency = 'YER', attributionWindowDays = 7 } = params;

    const banner = await prisma.promotionalBanner.findUnique({
      where: { id: bannerId },
      select: { id: true, campaignId: true, placementId: true },
    });

    if (!banner) return;

    // Increment banner conversion counter
    await prisma.promotionalBanner.update({
      where: { id: banner.id },
      data: { conversionCount: { increment: 1 } },
    });

    // Create attribution record
    await prisma.campaignAttribution.create({
      data: {
        campaignId: banner.campaignId,
        bannerId: banner.id,
        placementId: banner.placementId,
        customerId: customerId || null,
        sessionId: sessionId || null,
        orderId: orderId || null,
        touchpointType: 'CLICK',
        revenue: Math.max(0, revenue),
        currency,
        attributionWindowDays,
      },
    });

    // Also record analytics event
    await prisma.bannerAnalyticsEvent.create({
      data: {
        bannerId: banner.id,
        campaignId: banner.campaignId,
        placementId: banner.placementId,
        eventType: 'CONVERSION',
        customerId: customerId || null,
        sessionId: sessionId || null,
        metadata: { orderId, revenue, currency },
      },
    });
  }

  /**
   * Generates admin analytics metrics across all or specific campaigns.
   */
  async getAdminAnalytics(campaignId?: string) {
    const whereBanner = campaignId ? { campaignId } : {};

    const [totalCampaigns, activeCampaigns, banners, attributions, recentEvents] = await Promise.all([
      prisma.campaign.count(),
      prisma.campaign.count({ where: { status: 'ACTIVE' } }),
      prisma.promotionalBanner.findMany({
        where: whereBanner,
        select: {
          id: true,
          name: true,
          impressionCount: true,
          clickCount: true,
          conversionCount: true,
          placement: { select: { key: true, name: true } },
          campaign: { select: { id: true, name: true } },
        },
      }),
      prisma.campaignAttribution.findMany({
        where: campaignId ? { campaignId } : undefined,
        select: { revenue: true, currency: true },
      }),
      prisma.bannerAnalyticsEvent.groupBy({
        by: ['platform', 'locale'],
        where: campaignId ? { campaignId } : undefined,
        _count: { id: true },
      }),
    ]);

    const totalImpressions = banners.reduce((sum, b) => sum + b.impressionCount, 0);
    const totalClicks = banners.reduce((sum, b) => sum + b.clickCount, 0);
    const totalConversions = banners.reduce((sum, b) => sum + b.conversionCount, 0);
    const totalRevenue = attributions.reduce((sum, a) => sum + (a.revenue || 0), 0);
    const overallCtr = totalImpressions > 0 ? (totalClicks / totalImpressions) * 100 : 0.0;
    const conversionRate = totalClicks > 0 ? (totalConversions / totalClicks) * 100 : 0.0;

    // CTR by banner
    const bannerBreakdown = banners.map((b) => ({
      bannerId: b.id,
      name: b.name,
      campaignName: b.campaign?.name,
      placementKey: b.placement?.key,
      impressions: b.impressionCount,
      clicks: b.clickCount,
      conversions: b.conversionCount,
      ctr: b.impressionCount > 0 ? Number(((b.clickCount / b.impressionCount) * 100).toFixed(2)) : 0.0,
    }));

    return {
      totalCampaigns,
      activeCampaigns,
      totalImpressions,
      totalClicks,
      totalConversions,
      overallCtr: Number(overallCtr.toFixed(2)),
      conversionRate: Number(conversionRate.toFixed(2)),
      totalRevenue,
      bannerBreakdown,
      platformBreakdown: recentEvents,
    };
  }

  /**
   * Seller analytics strictly isolated to seller's owned banners.
   */
  async getSellerAnalytics(sellerId: string) {
    const banners = await prisma.promotionalBanner.findMany({
      where: {
        campaign: {
          ownerType: 'SELLER',
          ownerId: sellerId,
        },
      },
      select: {
        id: true,
        name: true,
        impressionCount: true,
        clickCount: true,
        conversionCount: true,
        campaign: { select: { id: true, name: true, status: true } },
      },
    });

    const bannerIds = banners.map((b) => b.id);

    const attributions = await prisma.campaignAttribution.findMany({
      where: { bannerId: { in: bannerIds } },
      select: { revenue: true, orderId: true },
    });

    const totalImpressions = banners.reduce((acc, b) => acc + b.impressionCount, 0);
    const totalClicks = banners.reduce((acc, b) => acc + b.clickCount, 0);
    const totalConversions = banners.reduce((acc, b) => acc + b.conversionCount, 0);
    const totalRevenue = attributions.reduce((acc, a) => acc + (a.revenue || 0), 0);
    const ctr = totalImpressions > 0 ? (totalClicks / totalImpressions) * 100 : 0.0;

    return {
      totalBanners: banners.length,
      totalImpressions,
      totalClicks,
      totalConversions,
      ctr: Number(ctr.toFixed(2)),
      totalRevenue,
      banners: banners.map((b) => ({
        id: b.id,
        name: b.name,
        campaignName: b.campaign.name,
        impressions: b.impressionCount,
        clicks: b.clickCount,
        conversions: b.conversionCount,
        ctr: b.impressionCount > 0 ? Number(((b.clickCount / b.impressionCount) * 100).toFixed(2)) : 0.0,
      })),
    };
  }
}

export const bannerAnalyticsService = new BannerAnalyticsService();
