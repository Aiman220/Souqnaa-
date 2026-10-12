import { prisma } from '../../../database/prisma';
import { CustomerEvaluationContext, targetingService } from './targeting.service';
import { scheduleService } from './schedule.service';
import { bannerCacheService } from './banner-cache.service';
import { redis } from '../../../database/redis';

export interface FormattedBannerResponse {
  id: string;
  campaignId: string;
  campaignName: string;
  name: string;
  title: string;
  subtitle?: string | null;
  description?: string | null;
  imageUrl: string;
  mobileImageUrl: string;
  tabletImageUrl?: string | null;
  desktopImageUrl?: string | null;
  thumbnailUrl?: string | null;
  altText?: string | null;
  placementKey: string;
  bannerType: string;
  ctaText?: string | null;
  ctaType: string;
  deepLink?: {
    id?: string;
    uri: string;
    type: string;
    targetId?: string;
    path: string;
    queryParameters?: Record<string, any>;
  } | null;
  backgroundColor?: string | null;
  textColor?: string | null;
  priority: number;
  expiresAt?: string | null;
}

class BannerRecommendationService {
  /**
   * Evaluates frequency capping for a customer/session.
   * If customer has exceeded daily or session cap, returns false.
   */
  private async checkFrequencyCap(
    bannerId: string,
    campaignId: string,
    context: CustomerEvaluationContext
  ): Promise<boolean> {
    const actorId = context.userId || (context as any).sessionId;
    if (!actorId) return true;

    // Check caps configured in DB
    const cap = await prisma.bannerFrequencyCap.findFirst({
      where: {
        OR: [{ bannerId }, { campaignId }],
      },
    });

    if (!cap) return true;

    const dailyKey = `freq:day:${bannerId}:${actorId}`;
    const sessionKey = `freq:sess:${bannerId}:${actorId}`;

    const [dailyCount, sessionCount] = await Promise.all([
      redis.getCounter(dailyKey),
      redis.getCounter(sessionKey),
    ]);

    if (dailyCount >= cap.maxImpressionsPerDay) return false;
    if (sessionCount >= cap.maxImpressionsPerSession) return false;

    return true;
  }

  /**
   * Recommends and returns ranked, eligible banners for a specific placement.
   */
  async getEligibleBannersForPlacement(
    placementKey: string,
    context: CustomerEvaluationContext,
    options?: { limit?: number; bypassCache?: boolean }
  ): Promise<{ placement: any; banners: FormattedBannerResponse[] }> {
    const placement = await prisma.bannerPlacement.findUnique({
      where: { key: placementKey },
    });

    if (!placement || !placement.isActive) {
      return { placement: null, banners: [] };
    }

    const locale = (context.language || 'ar').toLowerCase();
    const platform = (context.platform || 'MOBILE').toUpperCase();
    const segment = context.segments?.[0] || (context.isGuest ? 'GUEST' : 'REGISTERED');

    // Try Redis cache if not bypassing
    if (!options?.bypassCache) {
      const cached = await bannerCacheService.getCachedBanners<FormattedBannerResponse[]>(
        placementKey,
        locale,
        platform,
        segment
      );
      if (cached && Array.isArray(cached)) {
        return { placement, banners: cached };
      }
    }

    const now = new Date();

    // Fetch active candidates
    const rawBanners = await prisma.promotionalBanner.findMany({
      where: {
        placementId: placement.id,
        status: 'APPROVED',
        isActive: true,
        campaign: {
          status: { in: ['ACTIVE', 'SCHEDULED'] },
          startAt: { lte: now },
          endAt: { gt: now },
        },
      },
      include: {
        campaign: {
          include: {
            schedules: true,
            targetingRules: true,
          },
        },
        targetingRules: true,
        translations: true,
        deepLink: true,
      },
      orderBy: [
        { displayOrder: 'asc' },
        { priority: 'desc' },
        { createdAt: 'desc' },
      ],
    });

    const eligibleBanners: FormattedBannerResponse[] = [];

    for (const b of rawBanners) {
      // 1. Schedule check
      const scheduleResult = scheduleService.evaluateSchedule(
        b.campaign.startAt,
        b.campaign.endAt,
        b.campaign.status,
        b.campaign.schedules,
        b.campaign.timezone,
        now
      );

      if (!scheduleResult.isActive) {
        continue;
      }

      // Check banner-specific date override if present
      if (b.startAt && now < b.startAt) continue;
      if (b.endAt && now > b.endAt) continue;

      // 2. Targeting check (campaign level + banner level)
      if (b.campaign.targetingEnabled && b.campaign.targetingRules.length > 0) {
        if (!targetingService.isEligible(b.campaign.targetingRules, context)) {
          continue;
        }
      }

      if (b.targetingEnabled && b.targetingRules.length > 0) {
        if (!targetingService.isEligible(b.targetingRules, context)) {
          continue;
        }
      }

      // 3. Frequency capping check
      const capAllowed = await this.checkFrequencyCap(b.id, b.campaignId, context);
      if (!capAllowed) {
        continue;
      }

      // 4. Resolve translation
      const translation = b.translations.find((t) => t.locale.toLowerCase() === locale);
      const title = translation?.title || b.title || b.name;
      const subtitle = translation?.subtitle || b.subtitle;
      const description = translation?.description || b.description;
      const ctaText = translation?.ctaText || b.ctaText;

      // 5. Select responsive image according to platform
      let selectedImage = b.mobileImageUrl;
      if (platform === 'DESKTOP' || platform === 'WEB') {
        selectedImage = b.desktopImageUrl || b.tabletImageUrl || b.mobileImageUrl;
      } else if (platform === 'TABLET') {
        selectedImage = b.tabletImageUrl || b.mobileImageUrl;
      }
      if (translation?.imageUrl) {
        selectedImage = translation.imageUrl;
      }

      eligibleBanners.push({
        id: b.id,
        campaignId: b.campaignId,
        campaignName: b.campaign.name,
        name: b.name,
        title,
        subtitle,
        description,
        imageUrl: selectedImage,
        mobileImageUrl: b.mobileImageUrl,
        tabletImageUrl: b.tabletImageUrl,
        desktopImageUrl: b.desktopImageUrl,
        thumbnailUrl: b.thumbnailUrl,
        altText: translation?.altText || b.altText || title,
        placementKey: placement.key,
        bannerType: b.bannerType,
        ctaText,
        ctaType: b.ctaType,
        deepLink: b.deepLink
          ? {
              id: b.deepLink.id,
              uri: b.deepLink.path,
              type: b.deepLink.type,
              targetId: b.deepLink.targetId || undefined,
              path: b.deepLink.path,
              queryParameters: (b.deepLink.queryParameters as Record<string, any>) || {},
            }
          : b.campaignId
          ? {
              id: `dl-${b.id}`,
              uri: `/campaign/${b.campaignId}`,
              type: 'CAMPAIGN',
              targetId: b.campaignId,
              path: `/campaign/${b.campaignId}`,
              queryParameters: {},
            }
          : null,
        backgroundColor: b.backgroundColor,
        textColor: b.textColor,
        priority: b.priority,
        expiresAt: b.campaign.endAt.toISOString(),
      });

      const maxLimit = Math.max(options?.limit || 0, placement.maxItems || 0, 8);
      if (eligibleBanners.length >= maxLimit) {
        break;
      }
    }

    // Cache the result in Redis
    await bannerCacheService.setCachedBanners(
      placementKey,
      locale,
      platform,
      segment,
      eligibleBanners
    );

    return {
      placement: {
        key: placement.key,
        name: placement.name,
        slotType: placement.slotType,
        carouselEnabled: placement.carouselEnabled,
        autoplayEnabled: placement.autoplayEnabled,
        autoplayInterval: placement.autoplayInterval,
        maxItems: placement.maxItems,
      },
      banners: eligibleBanners,
    };
  }
}

export const bannerRecommendationService = new BannerRecommendationService();
