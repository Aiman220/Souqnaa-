import { prisma } from '../../../database/prisma';
import { BannerCtaType, BannerStatus, BannerType } from '@prisma/client';
import { AppError } from '../../../middleware/error.middleware';
import { bannerCacheService } from './banner-cache.service';
import { deepLinkService } from './deep-link.service';

export interface CreateBannerInput {
  campaignId: string;
  name: string;
  title?: string;
  subtitle?: string;
  description?: string;
  desktopImageUrl?: string;
  tabletImageUrl?: string;
  mobileImageUrl: string;
  thumbnailUrl?: string;
  altText?: string;
  placementKey: string;
  bannerType?: BannerType;
  status?: BannerStatus;
  priority?: number;
  startAt?: Date | string;
  endAt?: Date | string;
  displayOrder?: number;
  targetingEnabled?: boolean;
  ctaText?: string;
  ctaType?: BannerCtaType;
  deepLinkUri?: string;
  deepLinkId?: string;
  backgroundColor?: string;
  textColor?: string;
  createdBy?: string;
  translations?: Array<{
    locale: string;
    title?: string;
    subtitle?: string;
    description?: string;
    ctaText?: string;
    imageUrl?: string;
    altText?: string;
  }>;
}

class BannerService {
  async createBanner(input: CreateBannerInput, sellerContext?: { sellerId: string }) {
    // 1. Verify Campaign
    const campaign = await prisma.campaign.findUnique({
      where: { id: input.campaignId },
    });
    if (!campaign) throw new AppError('Campaign not found', 404);

    // If seller context is present, enforce seller isolation
    if (sellerContext) {
      if (campaign.ownerType === 'SELLER' && campaign.ownerId !== sellerContext.sellerId) {
        throw new AppError('Unauthorized: cannot add banner to another seller campaign', 403);
      }
    }

    // 2. Resolve placement
    const placement = await prisma.bannerPlacement.findUnique({
      where: { key: input.placementKey },
    });
    if (!placement) throw new AppError(`Placement ${input.placementKey} not found`, 404);

    // 3. Resolve or create deep link if provided
    let finalDeepLinkId = input.deepLinkId;
    if (!finalDeepLinkId && input.deepLinkUri) {
      const resolved = await deepLinkService.resolveDeepLink(input.deepLinkUri);
      const createdDl = await prisma.deepLink.create({
        data: {
          type: resolved.type,
          targetId: resolved.targetId || null,
          path: resolved.uri,
          queryParameters: resolved.queryParameters || {},
          metadata: {},
          isActive: true,
        },
      });
      finalDeepLinkId = createdDl.id;
    }

    // 4. Initial status: SUBMITTED or DRAFT for sellers, APPROVED for admin by default
    let initialStatus: BannerStatus = input.status || 'APPROVED';
    if (sellerContext) {
      initialStatus = input.status === 'DRAFT' ? 'DRAFT' : 'SUBMITTED';
    }

    const banner = await prisma.promotionalBanner.create({
      data: {
        campaignId: campaign.id,
        placementId: placement.id,
        name: input.name,
        title: input.title || null,
        subtitle: input.subtitle || null,
        description: input.description || null,
        desktopImageUrl: input.desktopImageUrl || null,
        tabletImageUrl: input.tabletImageUrl || null,
        mobileImageUrl: input.mobileImageUrl,
        thumbnailUrl: input.thumbnailUrl || null,
        altText: input.altText || input.title || input.name,
        bannerType: input.bannerType || 'CAROUSEL',
        status: initialStatus,
        priority: input.priority ?? 0,
        startAt: input.startAt ? new Date(input.startAt) : null,
        endAt: input.endAt ? new Date(input.endAt) : null,
        displayOrder: input.displayOrder ?? 0,
        targetingEnabled: Boolean(input.targetingEnabled),
        deepLinkId: finalDeepLinkId || null,
        ctaText: input.ctaText || null,
        ctaType: input.ctaType || 'SHOP_NOW',
        backgroundColor: input.backgroundColor || '#FFFFFF',
        textColor: input.textColor || '#000000',
        isActive: true,
        createdBy: input.createdBy || null,
        translations: input.translations
          ? {
              create: input.translations.map((t) => ({
                locale: t.locale.toLowerCase(),
                title: t.title || null,
                subtitle: t.subtitle || null,
                description: t.description || null,
                ctaText: t.ctaText || null,
                imageUrl: t.imageUrl || null,
                altText: t.altText || null,
              })),
            }
          : undefined,
      },
      include: {
        placement: true,
        campaign: true,
        deepLink: true,
        translations: true,
      },
    });

    await bannerCacheService.invalidatePlacement(placement.key);
    return banner;
  }

  async updateBanner(id: string, data: Partial<CreateBannerInput>, sellerContext?: { sellerId: string }) {
    const existing = await prisma.promotionalBanner.findUnique({
      where: { id },
      include: { campaign: true, placement: true },
    });
    if (!existing) throw new AppError('Banner not found', 404);

    if (sellerContext) {
      if (existing.campaign.ownerType !== 'SELLER' || existing.campaign.ownerId !== sellerContext.sellerId) {
        throw new AppError('Unauthorized to update this banner', 403);
      }
    }

    const ALLOWED_FIELDS = [
      'name',
      'title',
      'subtitle',
      'description',
      'desktopImageUrl',
      'tabletImageUrl',
      'mobileImageUrl',
      'thumbnailUrl',
      'altText',
      'bannerType',
      'status',
      'priority',
      'displayOrder',
      'targetingEnabled',
      'ctaText',
      'ctaType',
      'backgroundColor',
      'textColor',
      'isActive',
    ];

    const sanitizedData: any = {};
    for (const key of ALLOWED_FIELDS) {
      if (key in data && (data as any)[key] !== undefined) {
        sanitizedData[key] = (data as any)[key];
      }
    }

    const legacyImageUrl = (data as any).imageUrl;
    if (legacyImageUrl) {
      if (!sanitizedData.desktopImageUrl) sanitizedData.desktopImageUrl = legacyImageUrl;
      if (!sanitizedData.mobileImageUrl) sanitizedData.mobileImageUrl = legacyImageUrl;
    }

    // Ensure mobileImageUrl is never empty if desktopImageUrl exists
    if (sanitizedData.desktopImageUrl && !sanitizedData.mobileImageUrl && !existing.mobileImageUrl) {
      sanitizedData.mobileImageUrl = sanitizedData.desktopImageUrl;
    }

    if (data.placementKey && data.placementKey !== existing.placement.key) {
      const p = await prisma.bannerPlacement.findUnique({ where: { key: data.placementKey } });
      if (!p) throw new AppError(`Placement ${data.placementKey} not found`, 404);
      sanitizedData.placementId = p.id;
    }

    if (data.deepLinkUri && data.deepLinkUri.trim().length > 0) {
      try {
        const resolved = await deepLinkService.resolveDeepLink(data.deepLinkUri.trim());
        const createdDl = await prisma.deepLink.create({
          data: {
            type: resolved.type,
            targetId: resolved.targetId || null,
            path: resolved.uri,
            queryParameters: resolved.queryParameters || {},
            isActive: true,
          },
        });
        sanitizedData.deepLinkId = createdDl.id;
      } catch {
        const createdDl = await prisma.deepLink.create({
          data: {
            type: 'EXTERNAL_URL',
            path: data.deepLinkUri.trim(),
            isActive: true,
          },
        });
        sanitizedData.deepLinkId = createdDl.id;
      }
    }

    if (data.startAt) sanitizedData.startAt = new Date(data.startAt);
    if (data.endAt) sanitizedData.endAt = new Date(data.endAt);

    const updated = await prisma.promotionalBanner.update({
      where: { id },
      data: sanitizedData,
      include: {
        placement: true,
        campaign: true,
        deepLink: true,
        translations: true,
      },
    });

    await bannerCacheService.invalidatePlacement(existing.placement.key);
    if (data.placementKey) {
      await bannerCacheService.invalidatePlacement(data.placementKey);
    }
    return updated;
  }

  async deleteBanner(id: string, sellerContext?: { sellerId: string }) {
    const existing = await prisma.promotionalBanner.findUnique({
      where: { id },
      include: { campaign: true, placement: true },
    });
    if (!existing) throw new AppError('Banner not found', 404);

    if (sellerContext) {
      if (existing.campaign.ownerType !== 'SELLER' || existing.campaign.ownerId !== sellerContext.sellerId) {
        throw new AppError('Unauthorized to delete this banner', 403);
      }
    }

    // Soft delete: Mark the banner as DRAFT and inactive, and move its linked campaign to DRAFT
    // This allows it to be safely restored/reactivated anytime from either tab
    const updated = await prisma.promotionalBanner.update({
      where: { id },
      data: { status: 'DRAFT', isActive: false },
    });

    if (existing.campaignId) {
      await prisma.campaign.update({
        where: { id: existing.campaignId },
        data: { status: 'DRAFT' },
      });
    }

    await bannerCacheService.invalidatePlacement(existing.placement.key);
    await bannerCacheService.invalidateAllBanners();
    return updated;
  }

  async submitBannerForApproval(id: string, sellerId: string) {
    const banner = await prisma.promotionalBanner.findUnique({
      where: { id },
      include: { campaign: true },
    });
    if (!banner) throw new AppError('Banner not found', 404);

    if (banner.campaign.ownerType !== 'SELLER' || banner.campaign.ownerId !== sellerId) {
      throw new AppError('Unauthorized', 403);
    }

    return prisma.promotionalBanner.update({
      where: { id },
      data: { status: 'SUBMITTED' },
    });
  }

  async approveBanner(id: string) {
    const banner = await prisma.promotionalBanner.findUnique({
      where: { id },
      include: { placement: true, campaign: true },
    });
    if (!banner) throw new AppError('Banner not found', 404);

    // If campaign is not active (e.g. was PAUSED, PENDING_APPROVAL, DRAFT, or ARCHIVED), activate it!
    if (banner.campaign.status !== 'ACTIVE' && banner.campaign.status !== 'SCHEDULED') {
      const now = new Date();
      const endAt = banner.campaign.endAt > now ? banner.campaign.endAt : new Date(now.getTime() + 30 * 24 * 60 * 60 * 1000);
      await prisma.campaign.update({
        where: { id: banner.campaignId },
        data: {
          status: 'ACTIVE',
          startAt: banner.campaign.startAt <= now ? banner.campaign.startAt : now,
          endAt,
        },
      });
    }

    const updated = await prisma.promotionalBanner.update({
      where: { id },
      data: { status: 'APPROVED', isActive: true },
      include: {
        campaign: true,
        placement: true,
        deepLink: true,
        translations: true,
      },
    });

    await bannerCacheService.invalidatePlacement(banner.placement.key);
    await bannerCacheService.invalidateAllBanners();
    return updated;
  }

  async rejectBanner(id: string, reason?: string) {
    const banner = await prisma.promotionalBanner.findUnique({
      where: { id },
      include: { placement: true },
    });
    if (!banner) throw new AppError('Banner not found', 404);

    const updated = await prisma.promotionalBanner.update({
      where: { id },
      data: { status: 'REJECTED' },
    });

    await bannerCacheService.invalidatePlacement(banner.placement.key);
    return updated;
  }

  async pauseBanner(id: string) {
    const banner = await prisma.promotionalBanner.findUnique({
      where: { id },
      include: { placement: true, campaign: true },
    });
    if (!banner) throw new AppError('Banner not found', 404);

    const updated = await prisma.promotionalBanner.update({
      where: { id },
      data: { status: 'PAUSED', isActive: false },
    });

    // Synchronize parent campaign: when banner is paused, pause its campaign as well
    if (banner.campaignId) {
      await prisma.campaign.update({
        where: { id: banner.campaignId },
        data: { status: 'PAUSED' },
      });
    }

    await bannerCacheService.invalidatePlacement(banner.placement.key);
    await bannerCacheService.invalidateAllBanners();
    return updated;
  }

  async getBanners(filters?: {
    campaignId?: string;
    placementKey?: string;
    status?: BannerStatus;
    sellerId?: string;
    search?: string;
  }) {
    const where: any = {};
    if (filters?.campaignId) where.campaignId = filters.campaignId;
    if (filters?.placementKey) {
      where.placement = { key: filters.placementKey };
    }
    if (filters?.status) where.status = filters.status;
    if (filters?.sellerId) {
      where.campaign = { ownerType: 'SELLER', ownerId: filters.sellerId };
    }
    if (filters?.search) {
      where.OR = [
        { name: { contains: filters.search, mode: 'insensitive' } },
        { title: { contains: filters.search, mode: 'insensitive' } },
      ];
    }

    const banners = await prisma.promotionalBanner.findMany({
      where,
      include: {
        campaign: true,
        placement: true,
        deepLink: true,
        translations: true,
      },
      orderBy: [{ priority: 'desc' }, { displayOrder: 'asc' }, { createdAt: 'desc' }],
    });

    return banners.map((b) => ({
      ...b,
      imageUrl: b.mobileImageUrl || b.desktopImageUrl || '',
      placementKey: b.placement?.key || '',
    }));
  }

  async getBannerById(id: string) {
    const banner = await prisma.promotionalBanner.findUnique({
      where: { id },
      include: {
        campaign: true,
        placement: true,
        deepLink: true,
        translations: true,
        targetingRules: true,
        frequencyCaps: true,
      },
    });
    if (!banner) throw new AppError('Banner not found', 404);
    return banner;
  }
}

export const bannerService = new BannerService();
