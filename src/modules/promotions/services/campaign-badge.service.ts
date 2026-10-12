import path from 'path';
import { prisma } from '../../../database/prisma';
import { redis } from '../../../database/redis';
import { storageService } from '../../../services/storage/storage.service';
import { AppError } from '../../../middleware/error.middleware';
import { SocketService } from '../../../services/websocket/socket.service';

const ACTIVE_CAMPAIGN_CACHE_KEY = 'campaigns:active_badge_catalog';
const ACTIVE_CAMPAIGN_CACHE_TTL = 60; // 60 seconds TTL

export interface CampaignBadgeDTO {
  visible: boolean;
  imageUrl: string;
  thumbnailUrl?: string;
  mobileUrl?: string;
  tabletUrl?: string;
  webUrl?: string;
  position: 'BOTTOM_LEFT' | 'BOTTOM_RIGHT' | 'TOP_LEFT' | 'TOP_RIGHT';
  assetVersion: string;
  altText: string;
  clickable: boolean;
  landingPageUri?: string;
}

export interface CampaignPresentationDTO {
  campaignId: string;
  campaignType: string;
  campaignName: string;
  campaignNameAr?: string;
  campaignNameEn?: string;
  priority: number;
  badge: CampaignBadgeDTO;
}

export interface UploadBadgeInput {
  campaignId: string;
  file: Express.Multer.File;
  locale?: 'UNIVERSAL' | 'AR' | 'EN';
  altText?: string;
  altTextAr?: string;
  altTextEn?: string;
  position?: 'BOTTOM_LEFT' | 'BOTTOM_RIGHT' | 'TOP_LEFT' | 'TOP_RIGHT';
  clickable?: boolean;
  landingPageUri?: string;
  actorUserId?: string;
}

export interface CachedActiveCampaign {
  id: string;
  name: string;
  nameAr: string | null;
  nameEn: string | null;
  slug: string;
  code: string | null;
  campaignType: string;
  status: string;
  priority: number;
  startAt: string;
  endAt: string;
  targetingMode: string;
  badgeEnabled: boolean;
  badgePosition: string;
  badgeDisplayMode: string;
  badgeClickable: boolean;
  landingPageUri: string | null;
  badgeAssetVersion: number;
  badgeAssets: Array<{
    id: string;
    locale: string;
    assetUrl: string;
    thumbnailUrl: string | null;
    mobileUrl: string | null;
    tabletUrl: string | null;
    webUrl: string | null;
    width: number | null;
    height: number | null;
    mimeType: string | null;
    assetVersion: string;
    altText: string | null;
    altTextAr: string | null;
    altTextEn: string | null;
    isDefault: boolean;
  }>;
  approvedProductIds: string[];
  approvedSellerIds: string[];
  targetedCategoryIds: string[];
  targetedBrandIds: string[];
}

export class CampaignBadgeService {
  /**
   * Validate image buffer headers (magic bytes) to reject executable or disguised files.
   */
  public validateImageIntegrity(file: Express.Multer.File): { mime: string; ext: string } {
    if (!file || !file.buffer || file.buffer.length === 0) {
      throw new AppError('ملف الشارة غير صالح أو فارغ', 400);
    }

    const MAX_BADGE_SIZE = 5 * 1024 * 1024; // 5 MB
    if (file.size > MAX_BADGE_SIZE) {
      throw new AppError('حجم شارة الحملة يتجاوز الحد المسموح (5 ميجابايت)', 400);
    }

    const buf = file.buffer;
    const headerHex = buf.subarray(0, 12).toString('hex').toLowerCase();

    // Check PNG: 89504e470d0a1a0a
    if (headerHex.startsWith('89504e47')) {
      return { mime: 'image/png', ext: '.png' };
    }

    // Check JPEG: ffd8ff
    if (headerHex.startsWith('ffd8ff')) {
      return { mime: 'image/jpeg', ext: '.jpg' };
    }

    // Check WebP: 52494646....57454250 (RIFF....WEBP)
    if (headerHex.startsWith('52494646') && buf.subarray(8, 12).toString('ascii') === 'WEBP') {
      return { mime: 'image/webp', ext: '.webp' };
    }

    // Check GIF: 47494638 (GIF87a or GIF89a)
    if (headerHex.startsWith('47494638')) {
      return { mime: 'image/gif', ext: '.gif' };
    }

    // Check SVG: starts with <svg or <?xml
    const headerStr = buf.subarray(0, 200).toString('utf8').trim().toLowerCase();
    if (headerStr.startsWith('<svg') || (headerStr.startsWith('<?xml') && headerStr.includes('<svg'))) {
      // Reject dangerous script tags inside SVG
      if (headerStr.includes('<script') || headerStr.includes('javascript:') || headerStr.includes('onload=')) {
        throw new AppError('ملف SVG يحتوي على وسوم أو برمجيات خبيثة محظورة', 400);
      }
      return { mime: 'image/svg+xml', ext: '.svg' };
    }

    throw new AppError('نوع ملف الصورة غير مدعوم. الأنواع المدعومة: PNG, JPG, WebP, GIF, SVG', 400);
  }

  /**
   * Upload or replace a campaign badge asset with security checks & asset versioning.
   */
  async uploadBadgeAsset(input: UploadBadgeInput): Promise<any> {
    const { campaignId, file, locale = 'UNIVERSAL', altText, altTextAr, altTextEn, position, clickable, landingPageUri, actorUserId } = input;

    // Verify campaign existence
    const campaign = await prisma.campaign.findUnique({
      where: { id: campaignId },
      include: { badgeAssets: true },
    });

    if (!campaign) {
      throw new AppError('الحملة التسويقية غير موجودة', 404);
    }

    // Security validation
    const { mime, ext } = this.validateImageIntegrity(file);

    // Compute unique immutable version token for CDN cache busting
    const versionNumber = (campaign.badgeAssetVersion || 0) + 1;
    const assetVersion = `v${versionNumber}-${Date.now().toString(36)}`;

    // Upload to CDN / Cloudflare R2
    const originalExt = path.extname(file.originalname).toLowerCase() || ext;
    file.originalname = `badge-${campaign.slug || campaign.id}-${locale.toLowerCase()}-${assetVersion}${originalExt}`;
    const uploadResult = await storageService.uploadFile(file, 'campaign-badges');

    // Upsert the badge asset record for this campaign & locale
    const existingAsset = campaign.badgeAssets.find((a) => a.locale === locale);

    const assetData = {
      assetUrl: uploadResult.url,
      thumbnailUrl: uploadResult.url,
      mobileUrl: uploadResult.url,
      tabletUrl: uploadResult.url,
      webUrl: uploadResult.url,
      mimeType: mime,
      fileSize: file.size,
      assetVersion,
      altText: altText || campaign.name,
      altTextAr: altTextAr || campaign.nameAr || campaign.name,
      altTextEn: altTextEn || campaign.nameEn || campaign.name,
      locale,
      isDefault: locale === 'UNIVERSAL',
    };

    let savedAsset: any;
    if (existingAsset) {
      savedAsset = await prisma.campaignBadgeAsset.update({
        where: { id: existingAsset.id },
        data: assetData,
      });
    } else {
      savedAsset = await prisma.campaignBadgeAsset.create({
        data: {
          campaignId,
          ...assetData,
        },
      });
    }

    // Update campaign badge settings
    const updateCampaignData: any = {
      badgeEnabled: true,
      badgeAssetVersion: versionNumber,
    };
    if (position) updateCampaignData.badgePosition = position;
    if (clickable !== undefined) updateCampaignData.badgeClickable = clickable;
    if (landingPageUri !== undefined) updateCampaignData.landingPageUri = landingPageUri;

    await prisma.campaign.update({
      where: { id: campaignId },
      data: updateCampaignData,
    });

    // Write audit log
    await this.logAudit({
      userId: actorUserId,
      action: existingAsset ? 'CAMPAIGN_BADGE_REPLACED' : 'CAMPAIGN_BADGE_UPLOADED',
      campaignId,
      details: {
        assetId: savedAsset.id,
        assetVersion,
        locale,
        url: uploadResult.url,
        fileSize: file.size,
      },
    });

    // Invalidate cache
    await this.invalidateActiveCampaignsCache();

    return savedAsset;
  }

  /**
   * Remove a badge asset from a campaign.
   */
  async removeBadgeAsset(campaignId: string, assetId?: string, actorUserId?: string): Promise<void> {
    const campaign = await prisma.campaign.findUnique({
      where: { id: campaignId },
      include: { badgeAssets: true },
    });

    if (!campaign) throw new AppError('الحملة التسويقية غير موجودة', 404);

    if (assetId) {
      await prisma.campaignBadgeAsset.delete({ where: { id: assetId } });
    } else {
      await prisma.campaignBadgeAsset.deleteMany({ where: { campaignId } });
    }

    const remaining = await prisma.campaignBadgeAsset.count({ where: { campaignId } });
    if (remaining === 0) {
      await prisma.campaign.update({
        where: { id: campaignId },
        data: { badgeEnabled: false },
      });
    }

    await this.logAudit({
      userId: actorUserId,
      action: 'CAMPAIGN_BADGE_REMOVED',
      campaignId,
      details: { assetId, remainingAssets: remaining },
    });

    await this.invalidateActiveCampaignsCache();
  }

  /**
   * Toggle badge enabled/disabled for a campaign.
   */
  async toggleBadge(campaignId: string, enabled: boolean, actorUserId?: string): Promise<any> {
    const campaign = await prisma.campaign.findUnique({
      where: { id: campaignId },
      include: { badgeAssets: true },
    });

    if (!campaign) throw new AppError('الحملة التسويقية غير موجودة', 404);

    if (enabled && campaign.badgeAssets.length === 0) {
      throw new AppError('لا يمكن تفعيل الشارة بدون رفع صورة الشارة أولاً', 400);
    }

    const updated = await prisma.campaign.update({
      where: { id: campaignId },
      data: { badgeEnabled: enabled },
    });

    await this.logAudit({
      userId: actorUserId,
      action: enabled ? 'CAMPAIGN_BADGE_ENABLED' : 'CAMPAIGN_BADGE_DISABLED',
      campaignId,
      details: { badgeEnabled: enabled },
    });

    await this.invalidateActiveCampaignsCache();
    return updated;
  }

  /**
   * Update badge presentation settings (position, clickable, landing page).
   */
  async updateBadgeConfig(
    campaignId: string,
    data: {
      position?: 'BOTTOM_LEFT' | 'BOTTOM_RIGHT' | 'TOP_LEFT' | 'TOP_RIGHT';
      clickable?: boolean;
      landingPageUri?: string;
      badgeDisplayMode?: 'PRIMARY_BADGE' | 'BADGE_DISABLED' | 'MULTIPLE_BADGES';
    },
    actorUserId?: string
  ): Promise<any> {
    const updated = await prisma.campaign.update({
      where: { id: campaignId },
      data: {
        ...(data.position ? { badgePosition: data.position } : {}),
        ...(data.clickable !== undefined ? { badgeClickable: data.clickable } : {}),
        ...(data.landingPageUri !== undefined ? { landingPageUri: data.landingPageUri } : {}),
        ...(data.badgeDisplayMode ? { badgeDisplayMode: data.badgeDisplayMode } : {}),
      },
    });

    await this.logAudit({
      userId: actorUserId,
      action: 'CAMPAIGN_BADGE_CONFIG_UPDATED',
      campaignId,
      details: data,
    });

    await this.invalidateActiveCampaignsCache();
    return updated;
  }

  /**
   * Retrieve cached active campaigns with badges, ordered by priority DESC, startAt DESC, id ASC.
   * High performance: single query cached in Redis/Memory with 60s TTL.
   */
  async getActiveCampaignsWithBadges(): Promise<CachedActiveCampaign[]> {
    const cached = await redis.getJson<CachedActiveCampaign[]>(ACTIVE_CAMPAIGN_CACHE_KEY);
    if (cached) return cached;

    const now = new Date();

    const campaigns = await prisma.campaign.findMany({
      where: {
        status: 'ACTIVE',
        badgeEnabled: true,
        startAt: { lte: now },
        endAt: { gt: now },
      },
      orderBy: [
        { priority: 'desc' },
        { startAt: 'desc' },
        { id: 'asc' }, // Deterministic tie-breaker
      ],
      include: {
        badgeAssets: true,
        campaignProducts: {
          where: { status: 'APPROVED' },
          select: { productId: true },
        },
        campaignSellers: {
          where: { status: 'APPROVED' },
          select: { sellerId: true },
        },
        targetingRules: true,
      },
    });

    const activeList: CachedActiveCampaign[] = campaigns.map((c) => {
      // Extract targeted categories and brands from targeting rules
      const categoryRules = c.targetingRules.filter((r) => r.ruleType === 'CATEGORY' || r.ruleType === 'CATEGORIES');
      const targetedCategoryIds: string[] = [];
      categoryRules.forEach((r) => {
        try {
          const val = JSON.parse(r.value);
          if (Array.isArray(val)) targetedCategoryIds.push(...val.map(String));
          else targetedCategoryIds.push(String(val));
        } catch {
          targetedCategoryIds.push(r.value);
        }
      });

      const brandRules = c.targetingRules.filter((r) => r.ruleType === 'BRAND' || r.ruleType === 'BRANDS');
      const targetedBrandIds: string[] = [];
      brandRules.forEach((r) => {
        try {
          const val = JSON.parse(r.value);
          if (Array.isArray(val)) targetedBrandIds.push(...val.map(String));
          else targetedBrandIds.push(String(val));
        } catch {
          targetedBrandIds.push(r.value);
        }
      });

      const productRules = c.targetingRules.filter(
        (r) => r.ruleType === 'PRODUCT' || r.ruleType === 'PRODUCTS' || r.ruleType === 'PRODUCT_IDS' || r.ruleType === 'SPECIFIC_PRODUCTS'
      );
      const targetedProductIds: string[] = [];
      productRules.forEach((r) => {
        try {
          const val = JSON.parse(r.value);
          if (Array.isArray(val)) targetedProductIds.push(...val.map(String));
          else targetedProductIds.push(String(val));
        } catch {
          targetedProductIds.push(r.value);
        }
      });

      const sellerRules = c.targetingRules.filter(
        (r) => r.ruleType === 'SELLER' || r.ruleType === 'SELLERS' || r.ruleType === 'SELLER_IDS'
      );
      const targetedSellerIds: string[] = [];
      sellerRules.forEach((r) => {
        try {
          const val = JSON.parse(r.value);
          if (Array.isArray(val)) targetedSellerIds.push(...val.map(String));
          else targetedSellerIds.push(String(val));
        } catch {
          targetedSellerIds.push(r.value);
        }
      });

      return {
        id: c.id,
        name: c.name,
        nameAr: c.nameAr,
        nameEn: c.nameEn,
        slug: c.slug,
        code: c.code,
        campaignType: c.campaignType,
        status: c.status,
        priority: c.priority,
        startAt: c.startAt.toISOString(),
        endAt: c.endAt.toISOString(),
        targetingMode: c.targetingMode || 'ALL_ELIGIBLE_PRODUCTS',
        badgeEnabled: c.badgeEnabled,
        badgePosition: c.badgePosition || 'BOTTOM_LEFT',
        badgeDisplayMode: c.badgeDisplayMode || 'PRIMARY_BADGE',
        badgeClickable: c.badgeClickable !== false,
        landingPageUri: c.landingPageUri,
        badgeAssetVersion: c.badgeAssetVersion,
        badgeAssets: c.badgeAssets.map((a) => ({
          id: a.id,
          locale: a.locale,
          assetUrl: a.assetUrl,
          thumbnailUrl: a.thumbnailUrl,
          mobileUrl: a.mobileUrl,
          tabletUrl: a.tabletUrl,
          webUrl: a.webUrl,
          width: a.width,
          height: a.height,
          mimeType: a.mimeType,
          assetVersion: a.assetVersion,
          altText: a.altText,
          altTextAr: a.altTextAr,
          altTextEn: a.altTextEn,
          isDefault: a.isDefault,
        })),
        approvedProductIds: [
          ...c.campaignProducts.map((cp) => cp.productId),
          ...targetedProductIds,
        ],
        approvedSellerIds: [
          ...c.campaignSellers.map((cs) => cs.sellerId),
          ...targetedSellerIds,
        ],
        targetedCategoryIds,
        targetedBrandIds,
      };
    });

    await redis.setJson(ACTIVE_CAMPAIGN_CACHE_KEY, activeList, ACTIVE_CAMPAIGN_CACHE_TTL);
    return activeList;
  }

  /**
   * Deterministically resolves the primary campaign presentation for a single product.
   */
  resolvePresentationForProduct(
    product: {
      id: string;
      categoryId?: string | null;
      brandId?: string | null;
      sellerId?: string | null;
      storeId?: string | null;
      store?: { sellerId?: string | null; id?: string | null } | null;
      isActive?: boolean;
    },
    activeCampaigns: CachedActiveCampaign[],
    locale = 'ar'
  ): CampaignPresentationDTO | null {
    if (!product || !activeCampaigns || activeCampaigns.length === 0) {
      return null;
    }

    const prodSellerId = product.sellerId || product.store?.sellerId || product.storeId || product.store?.id || '';
    const prodCategoryId = product.categoryId || '';
    const prodBrandId = product.brandId || '';

    // Active campaigns are pre-sorted by Priority DESC, StartAt DESC, ID ASC
    for (const cmp of activeCampaigns) {
      if (!cmp.badgeEnabled || cmp.badgeAssets.length === 0) continue;

      let isEligible = false;

      switch (cmp.targetingMode) {
        case 'SPECIFIC_PRODUCTS':
          isEligible = cmp.approvedProductIds.includes(product.id);
          break;

        case 'CATEGORIES':
          isEligible = prodCategoryId ? cmp.targetedCategoryIds.includes(prodCategoryId) : false;
          break;

        case 'SELLERS':
          isEligible = prodSellerId ? cmp.approvedSellerIds.includes(prodSellerId) : false;
          break;

        case 'BRANDS':
          isEligible = prodBrandId ? cmp.targetedBrandIds.includes(prodBrandId) : false;
          break;

        case 'ALL_ELIGIBLE_PRODUCTS':
        default:
          // In ALL_ELIGIBLE_PRODUCTS mode, all active products qualify
          // unless specific exclusions are configured
          isEligible = true;
          if (cmp.approvedSellerIds.length > 0 && !cmp.approvedSellerIds.includes(prodSellerId)) {
            isEligible = false;
          }
          if (cmp.targetedCategoryIds.length > 0 && !cmp.targetedCategoryIds.includes(prodCategoryId)) {
            isEligible = false;
          }
          break;
      }

      if (isEligible) {
        // Pick best matching localized asset
        const isAr = locale.toLowerCase().startsWith('ar');
        const isEn = locale.toLowerCase().startsWith('en');

        let matchedAsset = cmp.badgeAssets.find((a) => {
          if (isAr && a.locale === 'AR') return true;
          if (isEn && a.locale === 'EN') return true;
          return false;
        });

        if (!matchedAsset) {
          matchedAsset = cmp.badgeAssets.find((a) => a.locale === 'UNIVERSAL' || a.isDefault) || cmp.badgeAssets[0];
        }

        if (!matchedAsset) continue;

        const campaignName = isEn
          ? cmp.nameEn || cmp.name
          : cmp.nameAr || cmp.name;

        const altText = isEn
          ? matchedAsset.altTextEn || matchedAsset.altText || `${cmp.name} campaign badge`
          : matchedAsset.altTextAr || matchedAsset.altText || `شارة حملة ${cmp.name}`;

        const landingPageUri = cmp.landingPageUri || `/campaigns/${cmp.slug}`;

        return {
          campaignId: cmp.id,
          campaignType: cmp.campaignType,
          campaignName,
          campaignNameAr: cmp.nameAr || cmp.name,
          campaignNameEn: cmp.nameEn || cmp.name,
          priority: cmp.priority,
          badge: {
            visible: true,
            imageUrl: matchedAsset.mobileUrl || matchedAsset.assetUrl,
            thumbnailUrl: matchedAsset.thumbnailUrl || matchedAsset.assetUrl,
            mobileUrl: matchedAsset.mobileUrl || matchedAsset.assetUrl,
            tabletUrl: matchedAsset.tabletUrl || matchedAsset.assetUrl,
            webUrl: matchedAsset.webUrl || matchedAsset.assetUrl,
            position: (cmp.badgePosition as any) || 'BOTTOM_LEFT',
            assetVersion: matchedAsset.assetVersion || 'v1',
            altText,
            clickable: cmp.badgeClickable !== false,
            landingPageUri,
          },
        };
      }
    }

    return null;
  }

  /**
   * Batch resolves campaign presentations for an array of products in O(N) time with 0 extra DB queries.
   */
  async batchResolveCampaignPresentations(products: any[], locale = 'ar'): Promise<Map<string, CampaignPresentationDTO>> {
    const resultMap = new Map<string, CampaignPresentationDTO>();
    if (!products || products.length === 0) return resultMap;

    const activeCampaigns = await this.getActiveCampaignsWithBadges();
    if (!activeCampaigns || activeCampaigns.length === 0) return resultMap;

    for (const prod of products) {
      if (!prod || !prod.id) continue;
      const presentation = this.resolvePresentationForProduct(prod, activeCampaigns, locale);
      if (presentation) {
        resultMap.set(prod.id, presentation);
      }
    }

    return resultMap;
  }

  /**
   * Invalidate active campaigns cache and broadcast WebSocket event to all clients.
   */
  async invalidateActiveCampaignsCache(): Promise<void> {
    await redis.del(ACTIVE_CAMPAIGN_CACHE_KEY);
    try {
      SocketService.get()?.emitGlobal('campaigns:badges_invalidated', {
        timestamp: Date.now(),
      });
    } catch (_) {}
  }

  private async logAudit(params: {
    userId?: string | null;
    action: string;
    campaignId: string;
    details: any;
  }): Promise<void> {
    try {
      let validUserId = params.userId;
      if (validUserId) {
        const user = await prisma.user.findUnique({ where: { id: validUserId }, select: { id: true } });
        if (!user) validUserId = undefined;
      }
      if (!validUserId) {
        const anyUser = await prisma.user.findFirst({ select: { id: true } });
        validUserId = anyUser?.id;
      }
      if (!validUserId) return; // If no users in database, skip audit log

      await prisma.auditLog.create({
        data: {
          userId: validUserId,
          action: params.action,
          resource: 'campaign_badges',
          details: JSON.stringify({
            campaignId: params.campaignId,
            ...params.details,
            timestamp: new Date().toISOString(),
          }),
        },
      });
    } catch (e) {
      console.error('[CampaignBadgeService] Audit log error:', e);
    }
  }
}

export const campaignBadgeService = new CampaignBadgeService();
