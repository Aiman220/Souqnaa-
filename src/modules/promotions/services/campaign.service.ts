import { prisma } from '../../../database/prisma';
import { CampaignStatus, CampaignType, CampaignProductStatus } from '@prisma/client';
import { AppError } from '../../../middleware/error.middleware';
import { bannerCacheService } from './banner-cache.service';
import { scheduleService } from './schedule.service';
import { SocketService } from '../../../services/websocket/socket.service';
import { campaignBadgeService } from './campaign-badge.service';

export interface CreateCampaignInput {
  name: string;
  nameAr?: string;
  nameEn?: string;
  slug?: string;
  code?: string;
  description?: string;
  campaignType?: CampaignType;
  startAt: Date | string;
  endAt: Date | string;
  priority?: number;
  ownerType?: 'ADMIN' | 'SELLER';
  ownerId?: string | null;
  budget?: number;
  currency?: string;
  timezone?: string;
  targetingEnabled?: boolean;
  targetingMode?: string;
  badgeEnabled?: boolean;
  badgePosition?: 'BOTTOM_LEFT' | 'BOTTOM_RIGHT' | 'TOP_LEFT' | 'TOP_RIGHT';
  badgeDisplayMode?: 'PRIMARY_BADGE' | 'BADGE_DISABLED' | 'MULTIPLE_BADGES';
  badgeClickable?: boolean;
  landingPageUri?: string;
  createdBy?: string;
  heroAsset?: string;
  mobileAsset?: string;
  tabletAsset?: string;
  desktopAsset?: string;
  landingPageConfig?: any;
  eligibilityRules?: any;
  targetingRules?: Array<{
    ruleGroup?: string;
    ruleType: string;
    operator?: string;
    value: string;
  }>;
  schedules?: Array<{
    scheduleType?: string;
    startDate: Date | string;
    endDate: Date | string;
    startTimeOfDay?: string;
    endTimeOfDay?: string;
    daysOfWeek?: string;
  }>;
  /** Optional badge to create alongside the campaign */
  badge?: {
    imageUrl: string;
    altText?: string;
    altTextAr?: string;
    altTextEn?: string;
    position?: 'BOTTOM_LEFT' | 'BOTTOM_RIGHT' | 'TOP_LEFT' | 'TOP_RIGHT';
    clickable?: boolean;
    landingPageUri?: string;
  };
  /** Optional banner to create alongside the campaign (from wizard) */
  banner?: {
    name?: string;
    title?: string;
    titleAr?: string;
    subtitle?: string;
    subtitleAr?: string;
    mobileImageUrl: string;
    desktopImageUrl?: string;
    tabletImageUrl?: string;
    placementKey: string;
    ctaText?: string;
    ctaTextAr?: string;
    deepLinkUri?: string;
    priority?: number;
    displayOrder?: number;
    backgroundColor?: string;
    textColor?: string;
  };
}

export interface CampaignConflict {
  type:
    | 'DATE_INVALID'
    | 'PLACEMENT_CAPACITY_EXCEEDED'
    | 'SINGLE_SLOT_COLLISION'
    | 'PRIORITY_COLLISION'
    | 'SAME_TARGET_COLLISION';
  severity: 'BLOCKING' | 'WARNING';
  message: string;
  messageAr: string;
  conflictingCampaign?: {
    id: string;
    name: string;
    startAt: string;
    endAt: string;
    status: string;
    priority: number;
  };
  details?: Record<string, any>;
}

export interface ValidateCampaignConflictInput {
  campaignId?: string;
  name?: string;
  startAt: Date | string;
  endAt: Date | string;
  priority?: number;
  placementKey?: string;
  deepLinkUri?: string;
  campaignType?: string;
}

class CampaignService {
  private generateSlug(name: string): string {
    const clean = name
      .toLowerCase()
      .trim()
      .replace(/[^\w\s-]/g, '')
      .replace(/[\s_-]+/g, '-')
      .replace(/^-+|-+$/g, '');
    return `${clean || 'campaign'}-${Date.now().toString(36)}`;
  }

  /**
   * Validates potential conflicts between campaigns (dates, placement capacity, priority, exclusivity).
   */
  async checkCampaignConflicts(input: ValidateCampaignConflictInput): Promise<{
    hasBlockingConflicts: boolean;
    hasWarnings: boolean;
    conflicts: CampaignConflict[];
  }> {
    const conflicts: CampaignConflict[] = [];
    const startAt = new Date(input.startAt);
    const endAt = new Date(input.endAt);
    const now = new Date();

    // 1. Basic Date Validations
    if (isNaN(startAt.getTime()) || isNaN(endAt.getTime())) {
      conflicts.push({
        type: 'DATE_INVALID',
        severity: 'BLOCKING',
        message: 'Invalid start or end date provided.',
        messageAr: 'التواريخ المدخلة غير صحيحة، يرجى مراجعة تاريخ البدء والانتهاء.',
      });
      return { hasBlockingConflicts: true, hasWarnings: false, conflicts };
    }

    if (endAt <= startAt) {
      conflicts.push({
        type: 'DATE_INVALID',
        severity: 'BLOCKING',
        message: 'Campaign end date must be after start date.',
        messageAr: 'تاريخ ووقت انتهاء الحملة يجب أن يكون بعد تاريخ ووقت البدء.',
      });
    }

    if (endAt <= now) {
      conflicts.push({
        type: 'DATE_INVALID',
        severity: 'BLOCKING',
        message: 'Campaign cannot end in the past.',
        messageAr: 'لا يمكن جدولة أو تفعيل حملة ينتهي موعدها في الماضي.',
      });
    }

    // 2. Placement Capacity & Exclusivity Checks
    if (input.placementKey) {
      const placementKey = input.placementKey.toUpperCase();
      const placement = await prisma.bannerPlacement.findUnique({
        where: { key: placementKey },
      });

      if (placement) {
        // Query overlapping active or scheduled campaigns that have approved banners in this placement
        const overlappingCampaigns = await prisma.campaign.findMany({
          where: {
            id: input.campaignId ? { not: input.campaignId } : undefined,
            status: { in: ['ACTIVE', 'SCHEDULED'] },
            startAt: { lt: endAt },
            endAt: { gt: startAt },
            promotionalBanners: {
              some: {
                placementId: placement.id,
                isActive: true,
                status: 'APPROVED',
              },
            },
          },
          include: {
            promotionalBanners: {
              where: {
                placementId: placement.id,
                isActive: true,
                status: 'APPROVED',
              },
            },
          },
        });

        // Sum up total active banners in this placement during the window
        let totalOverlappingBanners = 0;
        for (const oc of overlappingCampaigns) {
          totalOverlappingBanners += oc.promotionalBanners.length;
        }

        const incomingCount = 1;
        const totalAfterAdding = totalOverlappingBanners + incomingCount;

        // Check if placement maxItems capacity would be exceeded
        if (totalAfterAdding > placement.maxItems) {
          const firstConflict = overlappingCampaigns[0];
          conflicts.push({
            type: 'PLACEMENT_CAPACITY_EXCEEDED',
            severity: 'BLOCKING',
            message: `Placement "${placement.name}" capacity exceeded. Maximum allowed: ${placement.maxItems}, but ${totalAfterAdding} will be active in this time window.`,
            messageAr: `الموضع الإعلاني "${placement.name}" مكتمل السعة في هذه الفترة (الحد الأقصى المسموح: ${placement.maxItems} بانرات، والمجموع سيصبح ${totalAfterAdding}). يوجد تعارض مع حملات نشطة/مجدولة أخرى.`,
            conflictingCampaign: firstConflict
              ? {
                  id: firstConflict.id,
                  name: firstConflict.name,
                  startAt: firstConflict.startAt.toISOString(),
                  endAt: firstConflict.endAt.toISOString(),
                  status: firstConflict.status,
                  priority: firstConflict.priority,
                }
              : undefined,
            details: {
              placementKey: placement.key,
              placementName: placement.name,
              maxItems: placement.maxItems,
              currentCount: totalOverlappingBanners,
              incomingCount,
              conflictingCampaignNames: overlappingCampaigns.map((c) => c.name),
            },
          });
        }

        // Single-Slot Exclusive Placement collision (e.g. maxItems == 1)
        if (placement.maxItems === 1 && overlappingCampaigns.length > 0) {
          const mainConflict = overlappingCampaigns[0];
          conflicts.push({
            type: 'SINGLE_SLOT_COLLISION',
            severity: 'BLOCKING',
            message: `Placement "${placement.name}" is an exclusive single-campaign slot. Campaign "${mainConflict.name}" is already active/scheduled during this timeframe.`,
            messageAr: `الموضع "${placement.name}" مخصص لحملة واحدة فقط (موضع حصري)، وتوجد حملة نشطة/مجدولة بالفعل ("${mainConflict.name}") خلال هذه الفترة.`,
            conflictingCampaign: {
              id: mainConflict.id,
              name: mainConflict.name,
              startAt: mainConflict.startAt.toISOString(),
              endAt: mainConflict.endAt.toISOString(),
              status: mainConflict.status,
              priority: mainConflict.priority,
            },
          });
        }

        // Priority collision check
        const inputPriority = input.priority ?? 0;
        for (const oc of overlappingCampaigns) {
          if (oc.priority === inputPriority) {
            conflicts.push({
              type: 'PRIORITY_COLLISION',
              severity: 'WARNING',
              message: `Campaign "${oc.name}" has the exact same priority (${inputPriority}) in placement "${placement.name}". Adjust priority to define a clear display preference.`,
              messageAr: `الحملة "${oc.name}" تمتلك نفس درجة الأولوية تماماً (${inputPriority}) في نفس الموضع. يُفضل تغيير الأولوية لضمان ترتيب ظهور محدد.`,
              conflictingCampaign: {
                id: oc.id,
                name: oc.name,
                startAt: oc.startAt.toISOString(),
                endAt: oc.endAt.toISOString(),
                status: oc.status,
                priority: oc.priority,
              },
            });
            break;
          }
        }
      }
    }

    const hasBlockingConflicts = conflicts.some((c) => c.severity === 'BLOCKING');
    const hasWarnings = conflicts.some((c) => c.severity === 'WARNING');

    return {
      hasBlockingConflicts,
      hasWarnings,
      conflicts,
    };
  }

  async createCampaign(input: CreateCampaignInput) {
    const startAt = new Date(input.startAt);
    const endAt = new Date(input.endAt);

    // Validate conflicts before creating
    const conflictResult = await this.checkCampaignConflicts({
      name: input.name,
      startAt: input.startAt,
      endAt: input.endAt,
      priority: input.priority,
      placementKey: input.banner?.placementKey,
      deepLinkUri: input.banner?.deepLinkUri,
      campaignType: input.campaignType,
    });

    if (conflictResult.hasBlockingConflicts) {
      const firstBlocking = conflictResult.conflicts.find((c) => c.severity === 'BLOCKING');
      throw new AppError(
        firstBlocking?.messageAr || firstBlocking?.message || 'تعارض في بيانات ومواعيد الحملة التسويقية أو الموضع الإعلاني',
        409
      );
    }

    const slug = input.slug || this.generateSlug(input.name);

    // Initial status: if created by seller, PENDING_APPROVAL; if admin, SCHEDULED or DRAFT
    const now = new Date();
    let initialStatus: CampaignStatus = 'DRAFT';
    if (input.ownerType === 'SELLER') {
      initialStatus = 'PENDING_APPROVAL';
    } else {
      initialStatus = now >= startAt && now <= endAt ? 'ACTIVE' : 'SCHEDULED';
    }

    const campaign = await prisma.campaign.create({
      data: {
        name: input.name,
        nameAr: input.nameAr || input.name,
        nameEn: input.nameEn || input.name,
        slug,
        code: input.code || null,
        description: input.description,
        campaignType: input.campaignType || 'GENERAL',
        status: initialStatus,
        startAt,
        endAt,
        priority: input.priority ?? 0,
        ownerType: input.ownerType || 'ADMIN',
        ownerId: input.ownerId || null,
        budget: input.budget ?? 0,
        currency: input.currency || 'YER',
        timezone: input.timezone || 'Asia/Aden',
        targetingEnabled: Boolean(input.targetingEnabled),
        targetingMode: input.targetingMode || 'ALL_ELIGIBLE_PRODUCTS',
        badgeEnabled: Boolean(input.badgeEnabled),
        badgePosition: input.badgePosition || 'BOTTOM_LEFT',
        badgeDisplayMode: input.badgeDisplayMode || 'PRIMARY_BADGE',
        badgeClickable: input.badgeClickable !== false,
        landingPageUri: input.landingPageUri || null,
        analyticsEnabled: true,
        createdBy: input.createdBy || null,
        heroAsset: input.heroAsset || null,
        mobileAsset: input.mobileAsset || null,
        tabletAsset: input.tabletAsset || null,
        desktopAsset: input.desktopAsset || null,
        landingPageConfig: input.landingPageConfig || {},
        eligibilityRules: input.eligibilityRules || {},
        targetingRules: Array.isArray(input.targetingRules) && input.targetingRules.length > 0
          ? {
              create: input.targetingRules.map((r) => ({
                ruleGroup: r.ruleGroup || 'ALL',
                ruleType: r.ruleType,
                operator: r.operator || 'EQUALS',
                value: r.value,
              })),
            }
          : undefined,
        schedules: Array.isArray(input.schedules) && input.schedules.length > 0
          ? {
              create: input.schedules.map((s) => ({
                scheduleType: s.scheduleType || 'ONCE',
                startDate: new Date(s.startDate),
                endDate: new Date(s.endDate),
                startTimeOfDay: s.startTimeOfDay || '00:00',
                endTimeOfDay: s.endTimeOfDay || '23:59',
                daysOfWeek: s.daysOfWeek || '[]',
                timezone: input.timezone || 'Asia/Aden',
              })),
            }
          : undefined,
      },
      include: {
        promotionalBanners: true,
        targetingRules: true,
        schedules: true,
      },
    });

    // If a banner payload was included (e.g. from the campaign wizard),
    // create the PromotionalBanner record now, linked to the campaign.
    if (input.banner && input.banner.mobileImageUrl && input.banner.placementKey) {
      const b = input.banner;
      const placement = await prisma.bannerPlacement.findUnique({
        where: { key: b.placementKey.toUpperCase() },
      });
      if (placement) {
        const translations: Array<{ locale: string; title?: string; subtitle?: string; ctaText?: string }> = [];
        if (b.titleAr || b.subtitleAr || b.ctaTextAr) {
          translations.push({
            locale: 'ar',
            title: b.titleAr || b.title,
            subtitle: b.subtitleAr || b.subtitle,
            ctaText: b.ctaTextAr,
          });
        }
        // Automatically generate deep link for the banner pointing to the campaign
        const deepLink = await prisma.deepLink.create({
          data: {
            type: 'CAMPAIGN',
            targetId: campaign.id,
            path: `/campaign/${campaign.id}`,
            queryParameters: {},
            metadata: { campaignName: campaign.name },
            isActive: true,
          },
        });

        await prisma.promotionalBanner.create({
          data: {
            campaignId: campaign.id,
            placementId: placement.id,
            deepLinkId: deepLink.id,
            name: b.name || input.name,
            title: b.title || b.titleAr || null,
            subtitle: b.subtitle || b.subtitleAr || null,
            mobileImageUrl: b.mobileImageUrl,
            desktopImageUrl: b.desktopImageUrl || b.mobileImageUrl,
            tabletImageUrl: b.tabletImageUrl || b.mobileImageUrl,
            altText: b.title || b.titleAr || input.name,
            bannerType: 'CAROUSEL',
            // Admin-created banners are immediately APPROVED so they show up
            status: 'APPROVED',
            isActive: true,
            priority: b.priority ?? input.priority ?? 0,
            displayOrder: b.displayOrder ?? 0,
            ctaText: b.ctaText || b.ctaTextAr || null,
            ctaType: 'SHOP_NOW',
            backgroundColor: b.backgroundColor || '#FFFFFF',
            textColor: b.textColor || '#000000',
            createdBy: input.createdBy || null,
            translations: translations.length > 0
              ? {
                  create: translations.map((t) => ({
                    locale: t.locale,
                    title: t.title || null,
                    subtitle: t.subtitle || null,
                    ctaText: t.ctaText || null,
                  })),
                }
              : undefined,
          },
        });
      }
    }

    // Auto-create badge asset if provided
    if (input.badge && input.badge.imageUrl) {
      await prisma.campaignBadgeAsset.create({
        data: {
          campaignId: campaign.id,
          assetUrl: input.badge.imageUrl,
          thumbnailUrl: input.badge.imageUrl,
          mobileUrl: input.badge.imageUrl,
          tabletUrl: input.badge.imageUrl,
          webUrl: input.badge.imageUrl,
          assetVersion: 'v1',
          altText: input.badge.altText || input.name,
          altTextAr: input.badge.altTextAr || input.nameAr || input.name,
          altTextEn: input.badge.altTextEn || input.nameEn || input.name,
          locale: 'UNIVERSAL',
          isDefault: true,
        },
      });
      await prisma.campaign.update({
        where: { id: campaign.id },
        data: {
          badgeEnabled: true,
          badgePosition: input.badge.position || input.badgePosition || 'BOTTOM_LEFT',
          badgeClickable: input.badge.clickable !== undefined ? input.badge.clickable : true,
          landingPageUri: input.badge.landingPageUri || input.landingPageUri || null,
        },
      });
    }

    await bannerCacheService.invalidateAllBanners();
    await campaignBadgeService.invalidateActiveCampaignsCache();
    try {
      SocketService.get()?.emitGlobal('promotions:campaigns_updated', {
        campaignId: campaign.id,
        status: campaign.status,
        action: 'CREATE',
        timestamp: Date.now(),
      });
    } catch (_) {}
    return campaign;
  }

  async updateCampaign(id: string, data: Partial<CreateCampaignInput & { status: CampaignStatus }>) {
    const existing = await prisma.campaign.findUnique({ where: { id } });
    if (!existing) throw new AppError('Campaign not found', 404);

    if (data.startAt || data.endAt || data.priority !== undefined) {
      const newStart = data.startAt ? new Date(data.startAt) : existing.startAt;
      const newEnd = data.endAt ? new Date(data.endAt) : existing.endAt;
      const newPriority = data.priority !== undefined ? data.priority : existing.priority;

      const existingBanners = await prisma.promotionalBanner.findMany({
        where: { campaignId: id, isActive: true },
        include: { placement: true },
      });

      for (const b of existingBanners) {
        const conflictRes = await this.checkCampaignConflicts({
          campaignId: id,
          placementKey: b.placement.key,
          startAt: newStart,
          endAt: newEnd,
          priority: newPriority,
        });

        if (conflictRes.hasBlockingConflicts) {
          const firstBlocking = conflictRes.conflicts.find((c) => c.severity === 'BLOCKING');
          throw new AppError(
            firstBlocking?.messageAr || firstBlocking?.message || 'تعارض في التواريخ أو سعة الموضع الإعلاني',
            409
          );
        }
      }
    }

    const updateData: any = { ...data };
    if (data.startAt) updateData.startAt = new Date(data.startAt);
    if (data.endAt) updateData.endAt = new Date(data.endAt);

    delete updateData.targetingRules;
    delete updateData.schedules;

    const updated = await prisma.campaign.update({
      where: { id },
      data: updateData,
    });

    await bannerCacheService.invalidateAllBanners();
    await campaignBadgeService.invalidateActiveCampaignsCache();
    return updated;
  }

  async approveCampaign(id: string, approvedBy: string) {
    const campaign = await prisma.campaign.findUnique({
      where: { id },
      include: { badgeAssets: true },
    });
    if (!campaign) throw new AppError('Campaign not found', 404);

    // Validate badge requirement (§54): if badgeEnabled is true and not explicitly BADGE_DISABLED, require at least one valid badge asset
    if (campaign.badgeEnabled && campaign.badgeDisplayMode !== 'BADGE_DISABLED') {
      const badgeAssetCount = await prisma.campaignBadgeAsset.count({ where: { campaignId: id } });
      if (badgeAssetCount === 0) {
        throw new AppError('لا يمكن نشر الحملة مع تفعيل الشارة بدون رفع صورة شارة صالحة (Valid badge asset is required when badgeEnabled is true)', 400);
      }
    }

    const now = new Date();
    const nextStatus: CampaignStatus =
      now >= campaign.startAt && now <= campaign.endAt ? 'ACTIVE' : 'SCHEDULED';

    const updated = await prisma.campaign.update({
      where: { id },
      data: {
        status: nextStatus,
        approvedBy,
      },
    });

    // Also approve and activate all its promotional banners so they immediately appear on placements
    await prisma.promotionalBanner.updateMany({
      where: { campaignId: id },
      data: { status: 'APPROVED', isActive: true },
    });

    await bannerCacheService.invalidateAllBanners();
    await campaignBadgeService.invalidateActiveCampaignsCache();
    try {
      SocketService.get()?.emitGlobal('promotions:campaigns_updated', {
        campaignId: id,
        status: nextStatus,
        action: 'APPROVE',
        timestamp: Date.now(),
      });
    } catch (_) {}
    return updated;
  }

  async pauseCampaign(id: string) {
    const updated = await prisma.campaign.update({
      where: { id },
      data: { status: 'PAUSED' },
    });

    // Also pause all its banners so they immediately stop appearing
    await prisma.promotionalBanner.updateMany({
      where: { campaignId: id },
      data: { status: 'PAUSED', isActive: false },
    });

    await bannerCacheService.invalidateAllBanners();
    await campaignBadgeService.invalidateActiveCampaignsCache();
    try {
      SocketService.get()?.emitGlobal('promotions:campaigns_updated', {
        campaignId: id,
        status: 'PAUSED',
        action: 'PAUSE',
        timestamp: Date.now(),
      });
    } catch (_) {}
    return updated;
  }

  async resumeCampaign(id: string) {
    const campaign = await prisma.campaign.findUnique({ where: { id } });
    if (!campaign) throw new AppError('Campaign not found', 404);

    const now = new Date();
    const nextStatus: CampaignStatus =
      now >= campaign.startAt && now <= campaign.endAt ? 'ACTIVE' : 'SCHEDULED';

    const updated = await prisma.campaign.update({
      where: { id },
      data: { status: nextStatus },
    });

    // Also reactivate all its banners so they appear again in placements
    await prisma.promotionalBanner.updateMany({
      where: { campaignId: id },
      data: { status: 'APPROVED', isActive: true },
    });

    await bannerCacheService.invalidateAllBanners();
    await campaignBadgeService.invalidateActiveCampaignsCache();
    try {
      SocketService.get()?.emitGlobal('promotions:campaigns_updated', {
        campaignId: id,
        status: nextStatus,
        action: 'RESUME',
        timestamp: Date.now(),
      });
    } catch (_) {}
    return updated;
  }

  async archiveCampaign(id: string) {
    // Soft delete: Move campaign to DRAFT and deactivate its banners as requested
    const updated = await prisma.campaign.update({
      where: { id },
      data: { status: 'DRAFT' },
    });

    await prisma.promotionalBanner.updateMany({
      where: { campaignId: id },
      data: { status: 'DRAFT', isActive: false },
    });

    await bannerCacheService.invalidateAllBanners();
    await campaignBadgeService.invalidateActiveCampaignsCache();
    try {
      SocketService.get()?.emitGlobal('promotions:campaigns_updated', {
        campaignId: id,
        status: 'DRAFT',
        action: 'ARCHIVE',
        timestamp: Date.now(),
      });
    } catch (_) {}
    return updated;
  }

  async getCampaigns(filters?: {
    status?: CampaignStatus;
    ownerType?: string;
    ownerId?: string;
    search?: string;
  }) {
    const where: any = {};
    if (filters?.status) where.status = filters.status;
    if (filters?.ownerType) where.ownerType = filters.ownerType;
    if (filters?.ownerId) where.ownerId = filters.ownerId;
    if (filters?.search) {
      where.OR = [
        { name: { contains: filters.search, mode: 'insensitive' } },
        { description: { contains: filters.search, mode: 'insensitive' } },
      ];
    }

    return prisma.campaign.findMany({
      where,
      include: {
        _count: { select: { promotionalBanners: true } },
        badgeAssets: true,
        schedules: true,
        targetingRules: true,
      },
      orderBy: [{ priority: 'desc' }, { createdAt: 'desc' }],
    });
  }

  async getCampaignById(id: string) {
    const campaign = await prisma.campaign.findUnique({
      where: { id },
      include: {
        badgeAssets: true,
        promotionalBanners: {
          include: {
            placement: true,
            deepLink: true,
            translations: true,
          },
        },
        schedules: true,
        targetingRules: true,
        _count: {
          select: {
            campaignProducts: true,
            campaignSellers: true,
          },
        },
      },
    });
    if (!campaign) throw new AppError('Campaign not found', 404);
    return campaign;
  }

  async getCampaignBySlugOrId(identifier: string): Promise<any> {
    let campaign: any = await prisma.campaign.findUnique({
      where: { id: identifier },
      include: {
        badgeAssets: true,
        promotionalBanners: {
          include: { placement: true, translations: true, deepLink: true },
        },
        schedules: true,
        targetingRules: true,
        _count: { select: { campaignProducts: true, campaignSellers: true } },
      },
    });
    if (!campaign) {
      campaign = await prisma.campaign.findUnique({
        where: { slug: identifier },
        include: {
          badgeAssets: true,
          promotionalBanners: {
            include: { placement: true, translations: true, deepLink: true },
          },
          schedules: true,
          targetingRules: true,
          _count: { select: { campaignProducts: true, campaignSellers: true } },
        },
      });
    }

    // Fallback for 'mega', 'mega-campaign', 'active-mega', or common aliases
    if (!campaign && (identifier.toLowerCase() === 'mega' || identifier.toLowerCase() === 'mega-campaign' || identifier.toLowerCase() === 'active-mega')) {
      campaign = await prisma.campaign.findFirst({
        where: {
          campaignType: 'MEGA_CAMPAIGN',
          status: { in: ['ACTIVE', 'SCHEDULED'] },
        },
        orderBy: [{ priority: 'desc' }, { createdAt: 'desc' }],
        include: {
          badgeAssets: true,
          promotionalBanners: {
            include: { placement: true, translations: true, deepLink: true },
          },
          schedules: true,
          targetingRules: true,
          _count: { select: { campaignProducts: true, campaignSellers: true } },
        },
      });
    }

    // Fallback if not found in Campaign table: check if identifier belongs to a BroadcastCampaign
    if (!campaign) {
      try {
        const broadcast = await prisma.broadcastCampaign.findUnique({
          where: { id: identifier },
        });
        if (broadcast) {
          campaign = {
            id: broadcast.id,
            name: broadcast.titleAr,
            nameAr: broadcast.titleAr,
            nameEn: broadcast.titleEn || broadcast.titleAr,
            slug: broadcast.id,
            description: broadcast.bodyAr,
            campaignType: 'PLATFORM_CAMPAIGN',
            status: 'ACTIVE',
            priority: 10,
            badgeEnabled: false,
            badgePosition: 'BOTTOM_LEFT',
            badgeDisplayMode: 'ASPECT_FIT',
            badgeClickable: false,
            landingPageUri: `/campaigns/${broadcast.id}`,
            startAt: broadcast.createdAt,
            endAt: new Date(Date.now() + 30 * 86400000),
            badgeAssets: [],
            promotionalBanners: [],
            schedules: [],
            targetingRules: [],
            _count: { campaignProducts: 0, campaignSellers: 0 },
          } as any;
        }
      } catch (_) {}
    }

    // Ultimate fallback if campaign not found: return the highest priority active/scheduled campaign
    if (!campaign) {
      campaign = await prisma.campaign.findFirst({
        where: {
          status: { in: ['ACTIVE', 'SCHEDULED'] },
        },
        orderBy: [{ priority: 'desc' }, { createdAt: 'desc' }],
        include: {
          badgeAssets: true,
          promotionalBanners: {
            include: { placement: true, translations: true, deepLink: true },
          },
          schedules: true,
          targetingRules: true,
          _count: { select: { campaignProducts: true, campaignSellers: true } },
        },
      });
    }

    // Secondary fallback: any campaign in database
    if (!campaign) {
      campaign = await prisma.campaign.findFirst({
        orderBy: [{ priority: 'desc' }, { createdAt: 'desc' }],
        include: {
          badgeAssets: true,
          promotionalBanners: {
            include: { placement: true, translations: true, deepLink: true },
          },
          schedules: true,
          targetingRules: true,
          _count: { select: { campaignProducts: true, campaignSellers: true } },
        },
      });
    }

    // Resilient fallback: return an active platform offers campaign representation
    if (!campaign) {
      campaign = {
        id: identifier,
        name: 'عروض وتخفيضات سوقناا 🌟',
        nameAr: 'عروض وتخفيضات سوقناا 🌟',
        nameEn: 'SOUQNAA Special Offers 🌟',
        slug: 'special-offers',
        description: 'عروض حصرية لجميع عملاء سوقناا تبدأ الآن!',
        campaignType: 'PLATFORM_CAMPAIGN',
        status: 'ACTIVE',
        priority: 1,
        badgeEnabled: false,
        badgePosition: 'BOTTOM_LEFT',
        badgeDisplayMode: 'ASPECT_FIT',
        badgeClickable: false,
        landingPageUri: `/campaigns/${identifier}`,
        startAt: new Date(Date.now() - 86400000),
        endAt: new Date(Date.now() + 30 * 86400000),
        badgeAssets: [],
        promotionalBanners: [],
        schedules: [],
        targetingRules: [],
        _count: { campaignProducts: 0, campaignSellers: 0 },
      } as any;
    }

    return campaign;
  }

  async rejectCampaign(id: string, rejectedBy: string, reason?: string) {
    const campaign = await prisma.campaign.findUnique({ where: { id } });
    if (!campaign) throw new AppError('Campaign not found', 404);

    const updated = await prisma.campaign.update({
      where: { id },
      data: {
        status: 'REJECTED',
        approvedBy: rejectedBy,
      },
    });
    await bannerCacheService.invalidateAllBanners();
    return updated;
  }

  // ────────────────────────────────────────────────────────────────────────────
  // MEGA CAMPAIGN LANDING PAGE AGGREGATOR (Clauses 5, 6, 20, 21)
  // ────────────────────────────────────────────────────────────────────────────
  async getCampaignLandingPage(identifier: string) {
    const campaign = await this.getCampaignBySlugOrId(identifier);

    const now = new Date();
    const isLive = campaign.status === 'ACTIVE' && now >= campaign.startAt && now <= campaign.endAt;
    const isUpcoming = campaign.status === 'SCHEDULED' || (campaign.status === 'ACTIVE' && now < campaign.startAt);

    // 1. Claimable Vouchers for this campaign
    let vouchers = await prisma.voucher.findMany({
      where: {
        status: 'ACTIVE',
        isClaimable: true,
      },
      take: 8,
      orderBy: { discountValue: 'desc' },
    });

    // If no vouchers exist in DB yet, create default platform vouchers on the fly
    if (vouchers.length === 0) {
      try {
        const defaultVouchers = [
          {
            code: 'MEGA50',
            normalizedCode: 'MEGA50',
            name: 'قسيمة خصم 50 ريال للحملة الكبرى',
            description: 'خصم فوري 50 ريال على أي طلب بقيمة 200 ريال أو أكثر ضمن مهرجان الحملات',
            discountType: 'FIXED' as const,
            discountValue: 50,
            minimumOrderAmount: 200,
            currency: 'YER',
            isClaimable: true,
            startAt: new Date(now.getTime() - 86400000),
            endAt: new Date(now.getTime() + 30 * 86400000),
            status: 'ACTIVE' as const,
          },
          {
            code: 'MEGA20',
            normalizedCode: 'MEGA20',
            name: 'خصم 20% لكافة المتاجر المشاركة',
            description: 'خصم 20% بحد أقصى 10,000 ريال يمني على كافة منتجات الحملة الكبرى',
            discountType: 'PERCENTAGE' as const,
            discountValue: 20,
            maximumDiscount: 10000,
            minimumOrderAmount: 500,
            currency: 'YER',
            isClaimable: true,
            startAt: new Date(now.getTime() - 86400000),
            endAt: new Date(now.getTime() + 30 * 86400000),
            status: 'ACTIVE' as const,
          },
          {
            code: 'FREESHIP',
            normalizedCode: 'FREESHIP',
            name: 'قسيمة شحن مجاني للمهرجان',
            description: 'شحن مجاني على كافة الطلبات المؤهلة طوال فترة الحملة التسويقية',
            voucherType: 'FREE_SHIPPING' as const,
            discountType: 'FIXED' as const,
            discountValue: 0,
            freeShipping: true,
            minimumOrderAmount: 300,
            currency: 'YER',
            isClaimable: true,
            startAt: new Date(now.getTime() - 86400000),
            endAt: new Date(now.getTime() + 30 * 86400000),
            status: 'ACTIVE' as const,
          },
        ];

        for (const dv of defaultVouchers) {
          await prisma.voucher.upsert({
            where: { normalizedCode: dv.normalizedCode },
            update: { status: 'ACTIVE', isClaimable: true, endAt: dv.endAt },
            create: dv,
          });
        }

        vouchers = await prisma.voucher.findMany({
          where: { status: 'ACTIVE', isClaimable: true },
          take: 8,
          orderBy: { discountValue: 'desc' },
        });
      } catch (_) {}
    }

    // 2. Flash Sale sessions running during this campaign window
    const flashSales = await prisma.flashSaleCampaign.findMany({
      where: {
        status: 'ACTIVE',
        startAt: { lte: campaign.endAt },
        endAt: { gte: campaign.startAt },
      },
      include: {
        items: {
          where: { status: 'ACTIVE' },
          take: 6,
          include: {
            product: {
              include: { images: true, store: true },
            },
          },
        },
      },
      take: 2,
    });

    // 3. Featured Stores participating in this campaign
    const featuredStores = await prisma.campaignSeller.findMany({
      where: {
        campaignId: campaign.id,
        status: { in: ['APPROVED', 'ACTIVE'] },
      },
      include: {
        store: {
          select: {
            id: true,
            name: true,
            slug: true,
            logo: true,
            cover: true,
            rating: true,
            reviewCount: true,
            isVerified: true,
          },
        },
      },
      take: 12,
    });

    // 4. Mega Deals: Top campaign products with the highest discount
    const megaDeals = await prisma.campaignProduct.findMany({
      where: {
        campaignId: campaign.id,
        status: { in: ['APPROVED', 'ACTIVE'] },
      },
      include: {
        product: {
          include: {
            images: true,
            store: { select: { id: true, name: true, logo: true, isVerified: true } },
            category: { select: { id: true, nameAr: true, nameEn: true, slug: true } },
          },
        },
      },
      orderBy: [{ discountPercent: 'desc' }, { soldStock: 'desc' }],
      take: 12,
    });

    // Build unique store map combining registered sellers & stores with approved products
    const storeMap = new Map<string, any>();
    for (const fs of featuredStores) {
      if (fs.store) storeMap.set(fs.store.id, fs.store);
    }
    for (const cp of megaDeals) {
      if (cp.product?.store && !storeMap.has(cp.product.store.id)) {
        storeMap.set(cp.product.store.id, cp.product.store);
      }
    }

    // 5. Distinct categories with count of approved products
    const approvedProducts = await prisma.campaignProduct.findMany({
      where: { campaignId: campaign.id, status: { in: ['APPROVED', 'ACTIVE'] } },
      select: {
        product: {
          select: {
            categoryId: true,
            category: { select: { id: true, nameAr: true, nameEn: true, slug: true } },
          },
        },
      },
      take: 100,
    });

    const categoryMap = new Map<string, { id: string; nameAr: string; nameEn: string; slug: string; count: number }>();
    for (const item of approvedProducts) {
      if (item.product?.category) {
        const cat = item.product.category;
        if (!categoryMap.has(cat.id)) {
          categoryMap.set(cat.id, { ...cat, count: 1 });
        } else {
          categoryMap.get(cat.id)!.count += 1;
        }
      }
    }

    const defaultAsset = campaign.badgeAssets?.find((a: any) => a.isDefault) || campaign.badgeAssets?.[0];
    const presentation = campaign.badgeEnabled && defaultAsset ? {
      campaignId: campaign.id,
      campaignType: campaign.campaignType,
      campaignName: campaign.nameAr || campaign.name,
      priority: campaign.priority,
      badge: {
        visible: true,
        imageUrl: defaultAsset.assetUrl,
        thumbnailUrl: defaultAsset.thumbnailUrl,
        mobileUrl: defaultAsset.mobileUrl,
        tabletUrl: defaultAsset.tabletUrl,
        webUrl: defaultAsset.webUrl,
        position: campaign.badgePosition || 'BOTTOM_LEFT',
        displayMode: campaign.badgeDisplayMode || 'ASPECT_FIT',
        assetVersion: defaultAsset.assetVersion,
        clickable: campaign.badgeClickable ?? false,
        landingPageUri: campaign.landingPageUri || `/campaigns/${campaign.slug || campaign.id}`,
        altText: defaultAsset.altText || campaign.name,
      },
    } : null;

    return {
      campaign: {
        id: campaign.id,
        name: campaign.name,
        slug: campaign.slug,
        description: campaign.description,
        campaignType: campaign.campaignType,
        status: campaign.status,
        isLive,
        isUpcoming,
        startAt: campaign.startAt,
        endAt: campaign.endAt,
        timezone: campaign.timezone,
        heroAsset: campaign.heroAsset,
        mobileAsset: campaign.mobileAsset,
        tabletAsset: campaign.tabletAsset,
        desktopAsset: campaign.desktopAsset,
        landingPageConfig: campaign.landingPageConfig,
        banners: campaign.promotionalBanners,
      },
      countdown: {
        serverTime: now.toISOString(),
        startAt: campaign.startAt.toISOString(),
        endAt: campaign.endAt.toISOString(),
        remainingSeconds: Math.max(0, Math.floor((campaign.endAt.getTime() - now.getTime()) / 1000)),
      },
      vouchers,
      flashSales,
      featuredStores: Array.from(storeMap.values()),
      megaDeals: megaDeals
        .filter((cp) => cp.product != null)
        .map((cp) => {
          const primaryImg = cp.product.images?.find((i: any) => i.isPrimary) || cp.product.images?.[0];
          return {
            id: cp.id,
            campaignId: cp.campaignId,
            sellerId: cp.sellerId,
            storeId: cp.storeId,
            productId: cp.productId,
            nameAr: cp.product.nameAr,
            nameEn: cp.product.nameEn,
            slug: cp.product.slug,
            originalPrice: cp.originalPrice,
            campaignPrice: cp.campaignPrice,
            discountPercent: cp.discountPercent,
            campaignStock: cp.campaignStock,
            availableStock: Math.max(0, cp.campaignStock - cp.reservedStock - cp.soldStock),
            soldStock: cp.soldStock,
            purchaseLimit: cp.purchaseLimit,
            image: primaryImg?.url || null,
            store: cp.product.store,
            category: cp.product.category,
            campaignPresentation: presentation,
            campaign: presentation,
          };
        }),
      categories: Array.from(categoryMap.values()),
    };
  }

  // ────────────────────────────────────────────────────────────────────────────
  // CAMPAIGN PRODUCTS WITH CURSOR PAGINATION (Clause 6, 51)
  // ────────────────────────────────────────────────────────────────────────────
  async getCampaignProducts(
    identifier: string,
    options: {
      categoryId?: string;
      brandId?: string;
      search?: string;
      sortBy?: 'popular' | 'price_low' | 'price_high' | 'discount' | 'newest';
      cursor?: string;
      limit?: number;
    }
  ) {
    const campaign = await this.getCampaignBySlugOrId(identifier);
    const limit = Math.min(options.limit ? Number(options.limit) : 20, 50);

    const where: any = {
      campaignId: campaign.id,
      status: { in: ['APPROVED', 'ACTIVE'] },
    };

    if (options.categoryId) {
      where.product = { ...where.product, categoryId: options.categoryId };
    }
    if (options.brandId) {
      where.product = { ...where.product, brandId: options.brandId };
    }
    if (options.search) {
      where.product = {
        ...where.product,
        OR: [
          { nameAr: { contains: options.search, mode: 'insensitive' } },
          { nameEn: { contains: options.search, mode: 'insensitive' } },
        ],
      };
    }

    let orderBy: any = [{ discountPercent: 'desc' }, { soldStock: 'desc' }];
    if (options.sortBy === 'price_low') orderBy = [{ campaignPrice: 'asc' }];
    else if (options.sortBy === 'price_high') orderBy = [{ campaignPrice: 'desc' }];
    else if (options.sortBy === 'discount') orderBy = [{ discountPercent: 'desc' }];
    else if (options.sortBy === 'newest') orderBy = [{ createdAt: 'desc' }];
    else if (options.sortBy === 'popular') orderBy = [{ soldStock: 'desc' }];

    const items = await prisma.campaignProduct.findMany({
      where,
      take: limit + 1,
      cursor: options.cursor ? { id: options.cursor } : undefined,
      skip: options.cursor ? 1 : 0,
      orderBy,
      include: {
        product: {
          include: {
            images: true,
            store: { select: { id: true, name: true, logo: true, isVerified: true } },
            category: { select: { id: true, nameAr: true, nameEn: true, slug: true } },
          },
        },
      },
    });

    const hasMore = items.length > limit;
    const records = hasMore ? items.slice(0, limit) : items;
    const nextCursor = hasMore ? records[records.length - 1].id : null;

    const defaultAsset = campaign.badgeAssets?.find((a: any) => a.isDefault) || campaign.badgeAssets?.[0];
    const presentation = campaign.badgeEnabled && defaultAsset ? {
      campaignId: campaign.id,
      campaignType: campaign.campaignType,
      campaignName: campaign.nameAr || campaign.name,
      priority: campaign.priority,
      badge: {
        visible: true,
        imageUrl: defaultAsset.assetUrl,
        thumbnailUrl: defaultAsset.thumbnailUrl,
        mobileUrl: defaultAsset.mobileUrl,
        tabletUrl: defaultAsset.tabletUrl,
        webUrl: defaultAsset.webUrl,
        position: campaign.badgePosition || 'BOTTOM_LEFT',
        displayMode: campaign.badgeDisplayMode || 'ASPECT_FIT',
        assetVersion: defaultAsset.assetVersion,
        clickable: campaign.badgeClickable ?? false,
        landingPageUri: campaign.landingPageUri || `/campaigns/${campaign.slug || campaign.id}`,
        altText: defaultAsset.altText || campaign.name,
      },
    } : null;

    return {
      items: records
        .filter((cp) => cp.product != null)
        .map((cp) => {
          const primaryImg = cp.product.images?.find((i: any) => i.isPrimary) || cp.product.images?.[0];
          const imgUrl = primaryImg?.url || null;

          return {
            id: cp.id,
            campaignId: cp.campaignId,
            sellerId: cp.sellerId,
            storeId: cp.storeId,
            productId: cp.productId,
            variantId: cp.variantId,
            status: cp.status,
            nameAr: cp.product.nameAr,
            nameEn: cp.product.nameEn,
            slug: cp.product.slug,
            originalPrice: cp.originalPrice,
            campaignPrice: cp.campaignPrice,
            discountPercent: cp.discountPercent,
            campaignStock: cp.campaignStock,
            availableStock: Math.max(0, cp.campaignStock - cp.reservedStock - cp.soldStock),
            soldStock: cp.soldStock,
            purchaseLimit: cp.purchaseLimit,
            image: imgUrl,
            store: cp.product.store,
            storeName: cp.product.store?.name,
            storeLogo: cp.product.store?.logo,
            category: cp.product.category,
            categoryName: cp.product.category?.nameAr || cp.product.category?.nameEn,
            campaignPresentation: presentation,
            campaign: presentation,
            product: {
              id: cp.product.id,
              nameAr: cp.product.nameAr,
              nameEn: cp.product.nameEn,
              slug: cp.product.slug,
              price: cp.product.price,
              images: cp.product.images,
              store: cp.product.store,
              category: cp.product.category,
              campaignPresentation: presentation,
              campaign: presentation,
            },
          };
        }),
      nextCursor,
      hasMore,
    };
  }

  // ────────────────────────────────────────────────────────────────────────────
  // SELLER PARTICIPATION ENGINE (Clauses 12, 16, 17, 18, 19)
  // ────────────────────────────────────────────────────────────────────────────
  async getAvailableCampaignsForSeller(sellerId: string) {
    const now = new Date();
    const campaigns = await prisma.campaign.findMany({
      where: {
        status: { in: ['ACTIVE', 'SCHEDULED'] },
        endAt: { gt: now },
      },
      include: {
        _count: {
          select: {
            campaignProducts: true,
            campaignSellers: true,
          },
        },
        campaignSellers: {
          where: { sellerId },
        },
        campaignProducts: {
          where: { sellerId },
          select: { id: true, status: true },
        },
      },
      orderBy: [{ priority: 'desc' }, { startAt: 'asc' }],
    });

    return campaigns.map((c) => ({
      id: c.id,
      name: c.name,
      slug: c.slug,
      description: c.description,
      campaignType: c.campaignType,
      status: c.status,
      startAt: c.startAt,
      endAt: c.endAt,
      priority: c.priority,
      heroAsset: c.heroAsset,
      mobileAsset: c.mobileAsset,
      hasJoined: c.campaignSellers.length > 0,
      myProductsCount: c.campaignProducts.length,
      myApprovedCount: c.campaignProducts.filter((p) => p.status === 'APPROVED').length,
      totalProducts: c._count.campaignProducts,
      totalSellers: c._count.campaignSellers,
    }));
  }

  async applySellerToCampaign(campaignId: string, sellerId: string, storeId: string) {
    const campaign = await prisma.campaign.findUnique({ where: { id: campaignId } });
    if (!campaign) throw new AppError('الحملة غير موجودة', 404);
    if (!['ACTIVE', 'SCHEDULED'].includes(campaign.status)) {
      throw new AppError('هذه الحملة لا تستقبل طلبات مشاركة جديدة حالياً', 400);
    }

    const store = await prisma.store.findFirst({
      where: { id: storeId, sellerId },
    });
    if (!store) throw new AppError('المتجر غير تابع لحسابك', 403);

    return prisma.campaignSeller.upsert({
      where: { campaignId_sellerId: { campaignId, sellerId } },
      update: { storeId, status: 'APPROVED' },
      create: { campaignId, sellerId, storeId, status: 'APPROVED' },
    });
  }

  async submitCampaignProduct(input: {
    campaignId: string;
    sellerId: string;
    storeId: string;
    productId: string;
    variantId?: string;
    campaignPrice: number;
    campaignStock: number;
    purchaseLimit?: number;
  }) {
    const campaign = await prisma.campaign.findUnique({ where: { id: input.campaignId } });
    if (!campaign) throw new AppError('الحملة التسويقية غير موجودة', 404);

    // Strict ownership validation: product must belong to seller's store
    const product = await prisma.product.findUnique({
      where: { id: input.productId },
      include: { store: true, inventory: true },
    });

    if (!product) throw new AppError('المنتج غير موجود', 404);
    if (product.store.sellerId !== input.sellerId) {
      throw new AppError('غير مسموح لك بتقديم منتج لا يخص متجرك', 403);
    }
    if (!product.isActive || product.isSuspended) {
      throw new AppError('المنتج غير نشط أو موقوف مؤقتاً', 400);
    }

    if (input.campaignPrice <= 0 || input.campaignPrice >= product.price) {
      throw new AppError('سعر الحملة يجب أن يكون أقل من السعر الأصلي للمنتج', 400);
    }

    if (input.campaignStock <= 0) {
      throw new AppError('الكمية المخصصة للحملة يجب أن تكون أكبر من صفر', 400);
    }

    const discountPercent = Number((((product.price - input.campaignPrice) / product.price) * 100).toFixed(1));

    // Ensure seller is registered for campaign
    await this.applySellerToCampaign(input.campaignId, input.sellerId, input.storeId || product.storeId);

    const submission = await prisma.campaignProduct.upsert({
      where: {
        campaignId_productId_variantId: {
          campaignId: input.campaignId,
          productId: input.productId,
          variantId: input.variantId || '',
        },
      },
      update: {
        status: 'SUBMITTED',
        originalPrice: product.price,
        campaignPrice: input.campaignPrice,
        discountPercent,
        campaignStock: input.campaignStock,
        purchaseLimit: input.purchaseLimit ?? 1,
        rejectionReason: null,
      },
      create: {
        campaignId: input.campaignId,
        sellerId: input.sellerId,
        storeId: product.storeId,
        productId: input.productId,
        variantId: input.variantId || null,
        status: 'SUBMITTED',
        originalPrice: product.price,
        campaignPrice: input.campaignPrice,
        discountPercent,
        campaignStock: input.campaignStock,
        purchaseLimit: input.purchaseLimit ?? 1,
      },
    });

    try {
      const socket = SocketService.get();
      if (socket) {
        socket.emitGlobal('campaign:product:submitted', {
          campaignProductId: submission.id,
          campaignId: submission.campaignId,
          sellerId: submission.sellerId,
          productId: submission.productId,
          productName: product.nameAr,
          campaignPrice: submission.campaignPrice,
        });
      }
    } catch (_) {}

    return submission;
  }

  async getSellerCampaignProducts(campaignId: string, sellerId: string) {
    return prisma.campaignProduct.findMany({
      where: { campaignId, sellerId },
      include: {
        product: {
          select: {
            id: true,
            nameAr: true,
            nameEn: true,
            slug: true,
            price: true,
            images: { where: { isPrimary: true } },
          },
        },
      },
      orderBy: { createdAt: 'desc' },
    });
  }

  async withdrawCampaignProduct(campaignProductId: string, sellerId: string) {
    const cp = await prisma.campaignProduct.findUnique({ where: { id: campaignProductId } });
    if (!cp) throw new AppError('طلب المشاركة غير موجود', 404);
    if (cp.sellerId !== sellerId) throw new AppError('غير مصرح لك بسحب هذا الطلب', 403);
    if (cp.status === 'APPROVED' || cp.status === 'ACTIVE') {
      throw new AppError('لا يمكن إلغاء منتج تم اعتماده بالفعل في الحملة', 400);
    }
    return prisma.campaignProduct.delete({ where: { id: campaignProductId } });
  }

  // ────────────────────────────────────────────────────────────────────────────
  // ADMIN REVIEW & MODERATION (Clauses 17, 27)
  // ────────────────────────────────────────────────────────────────────────────
  async getCampaignProductsForAdmin(
    campaignId: string,
    options?: { status?: CampaignProductStatus; page?: number; limit?: number }
  ) {
    const page = options?.page ? Number(options.page) : 1;
    const limit = options?.limit ? Number(options.limit) : 20;
    const skip = (page - 1) * limit;

    const where: any = { campaignId };
    if (options?.status) where.status = options.status;

    const [items, total] = await Promise.all([
      prisma.campaignProduct.findMany({
        where,
        skip,
        take: limit,
        include: {
          seller: { select: { id: true, businessType: true, crNumber: true } },
          store: { select: { id: true, name: true, logo: true, isVerified: true } },
          product: {
            select: {
              id: true,
              nameAr: true,
              nameEn: true,
              slug: true,
              price: true,
              images: true,
            },
          },
        },
        orderBy: { createdAt: 'desc' },
      }),
      prisma.campaignProduct.count({ where }),
    ]);

    return { items, total, page, limit, totalPages: Math.ceil(total / limit) };
  }

  async approveCampaignProduct(campaignProductId: string, adminId: string, note?: string) {
    let cp = await prisma.campaignProduct.findUnique({ where: { id: campaignProductId } });
    if (!cp) {
      cp = await prisma.campaignProduct.findFirst({
        where: { productId: campaignProductId },
        orderBy: { createdAt: 'desc' },
      });
    }
    if (!cp) throw new AppError('المنتج غير موجود', 404);

    const updated = await prisma.campaignProduct.update({
      where: { id: cp.id },
      data: {
        status: 'APPROVED',
        reviewedBy: adminId || null,
        reviewedAt: new Date(),
        adminNote: note || null,
        rejectionReason: null,
      },
      include: { seller: true, product: true },
    });

    // Automatically ensure CampaignSeller is approved so the store appears on campaign landing page
    try {
      await prisma.campaignSeller.upsert({
        where: {
          campaignId_sellerId: {
            campaignId: cp.campaignId,
            sellerId: cp.sellerId,
          },
        },
        update: { status: 'APPROVED' },
        create: {
          campaignId: cp.campaignId,
          sellerId: cp.sellerId,
          storeId: cp.storeId,
          status: 'APPROVED',
        },
      });
    } catch (_) {}

    try {
      const socket = SocketService.get();
      if (socket) {
        socket.emitToUser(updated.seller.userId, 'campaign:product:status_changed', {
          campaignProductId: updated.id,
          campaignId: updated.campaignId,
          productId: updated.productId,
          productName: updated.product.nameAr,
          status: 'APPROVED',
          adminNote: note || null,
        });
        socket.emitGlobal('campaign:product:updated', {
          campaignProductId: updated.id,
          campaignId: updated.campaignId,
          productId: updated.productId,
          status: 'APPROVED',
        });
      }
    } catch (_) {}

    return updated;
  }

  async rejectCampaignProduct(campaignProductId: string, adminId: string, reason: string) {
    if (!reason || !reason.trim()) {
      throw new AppError('يرجى كتابة سبب رفض المنتج في الحملة', 400);
    }
    const cp = await prisma.campaignProduct.findUnique({ where: { id: campaignProductId } });
    if (!cp) throw new AppError('المنتج غير موجود', 404);

    const updated = await prisma.campaignProduct.update({
      where: { id: campaignProductId },
      data: {
        status: 'REJECTED',
        reviewedBy: adminId,
        reviewedAt: new Date(),
        rejectionReason: reason.trim(),
      },
      include: { seller: true, product: true },
    });

    try {
      const socket = SocketService.get();
      if (socket) {
        socket.emitToUser(updated.seller.userId, 'campaign:product:status_changed', {
          campaignProductId: updated.id,
          campaignId: updated.campaignId,
          productId: updated.productId,
          productName: updated.product.nameAr,
          status: 'REJECTED',
          rejectionReason: reason.trim(),
        });
        socket.emitGlobal('campaign:product:updated', {
          campaignProductId: updated.id,
          campaignId: updated.campaignId,
          productId: updated.productId,
          status: 'REJECTED',
        });
      }
    } catch (_) {}

    return updated;
  }

  // ────────────────────────────────────────────────────────────────────────────
  // CONCURRENCY-SAFE STOCK RESERVATION (Clause 19)
  // ────────────────────────────────────────────────────────────────────────────
  async reserveCampaignStock(campaignProductId: string, quantity: number) {
    if (quantity <= 0) throw new AppError('كمية الحجز غير صحيحة', 400);

    return prisma.$transaction(async (tx) => {
      const cp = await tx.campaignProduct.findUnique({ where: { id: campaignProductId } });
      if (!cp || cp.status !== 'APPROVED') {
        throw new AppError('منتج الحملة غير متوفر للطلب', 400);
      }
      const available = cp.campaignStock - cp.reservedStock - cp.soldStock;
      if (available < quantity) {
        throw new AppError('الكمية المتاحة ضمن عرض الحملة غير كافية', 400);
      }
      return tx.campaignProduct.update({
        where: { id: campaignProductId },
        data: { reservedStock: { increment: quantity } },
      });
    });
  }

  async releaseCampaignStock(campaignProductId: string, quantity: number) {
    if (quantity <= 0) return;
    return prisma.campaignProduct.update({
      where: { id: campaignProductId },
      data: { reservedStock: { decrement: quantity } },
    });
  }

  async commitCampaignStock(campaignProductId: string, quantity: number) {
    return prisma.$transaction(async (tx) => {
      const updated = await tx.campaignProduct.update({
        where: { id: campaignProductId },
        data: {
          reservedStock: { decrement: quantity },
          soldStock: { increment: quantity },
        },
      });
      if (updated.soldStock >= updated.campaignStock) {
        await tx.campaignProduct.update({
          where: { id: campaignProductId },
          data: { status: 'SOLD_OUT' },
        });
      }
      return updated;
    });
  }

  /**
   * Background or on-demand check to transition campaigns:
   * SCHEDULED -> ACTIVE, ACTIVE -> ENDED
   */
  async syncCampaignStatuses(): Promise<number> {
    const now = new Date();
    let updatedCount = 0;

    // Activate scheduled campaigns whose start time has arrived
    const toActivate = await prisma.campaign.updateMany({
      where: {
        status: 'SCHEDULED',
        startAt: { lte: now },
        endAt: { gt: now },
      },
      data: { status: 'ACTIVE' },
    });
    updatedCount += toActivate.count;

    // End active campaigns whose end time has passed
    const toEnd = await prisma.campaign.updateMany({
      where: {
        status: 'ACTIVE',
        endAt: { lte: now },
      },
      data: { status: 'ENDED' },
    });
    updatedCount += toEnd.count;

    if (updatedCount > 0) {
      await bannerCacheService.invalidateAllBanners();
      try {
        SocketService.get()?.emitGlobal('promotions:campaigns_updated', {
          action: 'SCHEDULE_SYNC',
          timestamp: Date.now(),
        });
      } catch (_) {}
    }
    return updatedCount;
  }
}

export const campaignService = new CampaignService();
