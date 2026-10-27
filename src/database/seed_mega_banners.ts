import { prisma } from './prisma';
import { bannerCacheService } from '../modules/promotions/services/banner-cache.service';

export async function seedMegaBanners() {
  console.log('🚀 Seeding/Synchronizing Mega Campaign Banners across all placements...');

  const now = new Date();
  const startAt = new Date(now.getTime() - 2 * 86400000);
  const endAt = new Date(now.getTime() + 30 * 86400000);

  // 1. Find or create the primary Mega Campaign
  let megaCampaign = await prisma.campaign.findFirst({
    where: {
      OR: [
        { slug: 'souqnaa-mega-campaign-2026' },
        { slug: 'mega-11-11-sale' },
        { campaignType: 'MEGA_CAMPAIGN' },
      ],
    },
    orderBy: { priority: 'desc' },
  });

  if (!megaCampaign) {
    megaCampaign = await prisma.campaign.create({
      data: {
        name: 'مهرجان سوقناا السنوي للتسوق الأكبر 2026 | Mega Campaign',
        slug: 'souqnaa-mega-campaign-2026',
        description: 'أكبر مهرجان تسوق سنوي مع خصومات تصل إلى 70% وقسائم خصم حصرية وعروض خاطفة لكافة المتاجر.',
        campaignType: 'MEGA_CAMPAIGN',
        status: 'ACTIVE',
        startAt,
        endAt,
        priority: 100,
        currency: 'YER',
        heroAsset: 'https://images.unsplash.com/photo-1607082348824-0a96f2a4b9da?w=1200&q=80',
        mobileAsset: 'https://images.unsplash.com/photo-1607082348824-0a96f2a4b9da?w=600&q=80',
        tabletAsset: 'https://images.unsplash.com/photo-1607082348824-0a96f2a4b9da?w=900&q=80',
        desktopAsset: 'https://images.unsplash.com/photo-1607082348824-0a96f2a4b9da?w=1600&q=80',
      },
    });
  } else {
    // Ensure active status and future end date
    megaCampaign = await prisma.campaign.update({
      where: { id: megaCampaign.id },
      data: {
        status: 'ACTIVE',
        startAt: megaCampaign.startAt > now ? startAt : megaCampaign.startAt,
        endAt: megaCampaign.endAt < now ? endAt : megaCampaign.endAt,
      },
    });
  }

  // Also ensure any other paused mega campaign is resumed
  await prisma.campaign.updateMany({
    where: {
      slug: { in: ['white-friday-mega-sale', 'mega-11-11-sale'] },
    },
    data: { status: 'ACTIVE', endAt },
  });

  // 2. Placements definitions map
  const placementKeys = [
    { key: 'HOME_HERO', name: 'Home Hero Carousel', pageType: 'HOME' as const, slotType: 'CAROUSEL' as const, maxItems: 8 },
    { key: 'HOME_SECONDARY', name: 'Home Secondary Promotional Banner', pageType: 'HOME' as const, slotType: 'BANNER' as const, maxItems: 4 },
    { key: 'HOME_VOUCHER', name: 'Home Voucher Strip', pageType: 'HOME' as const, slotType: 'STRIP' as const, maxItems: 4 },
    { key: 'HOME_FLASH_SALE', name: 'Flash Sale Highlight Banner', pageType: 'HOME' as const, slotType: 'BANNER' as const, maxItems: 4 },
    { key: 'CATEGORY_TOP', name: 'Category Top Banner', pageType: 'CATEGORY' as const, slotType: 'BANNER' as const, maxItems: 4 },
    { key: 'SEARCH_TOP', name: 'Search Results Sponsored Banner', pageType: 'SEARCH' as const, slotType: 'BANNER' as const, maxItems: 4 },
    { key: 'PRODUCT_TOP', name: 'Product Details Promotional Banner', pageType: 'PRODUCT' as const, slotType: 'BANNER' as const, maxItems: 4 },
    { key: 'STORE_TOP', name: 'Store Header Promotional Banner', pageType: 'STORE' as const, slotType: 'BANNER' as const, maxItems: 4 },
    { key: 'CHECKOUT_PROMOTION', name: 'Checkout Voucher Callout', pageType: 'CHECKOUT' as const, slotType: 'STRIP' as const, maxItems: 2 },
  ];

  const placementMap = new Map<string, string>();
  for (const p of placementKeys) {
    const record = await prisma.bannerPlacement.upsert({
      where: { key: p.key },
      update: { isActive: true, maxItems: p.maxItems },
      create: {
        key: p.key,
        name: p.name,
        pageType: p.pageType,
        slotType: p.slotType,
        maxItems: p.maxItems,
        isActive: true,
      },
    });
    placementMap.set(p.key, record.id);
  }

  // 3. Mega Banner definitions for each placement
  const megaBanners = [
    {
      id: 'banner-mega-souqnaa-hero',
      placementKey: 'HOME_HERO',
      name: 'بانر مهرجان سوقناا السنوي الأكبر - هيرو',
      titleAr: 'مهرجان سوقناا السنوي الأكبر 2026',
      titleEn: 'Souqnaa Annual Mega Shopping Festival 2026',
      subtitleAr: 'خصومات كبرى تصل إلى 70% على آلاف المنتجات لكافة المتاجر',
      subtitleEn: 'Massive discounts up to 70% across thousands of products',
      mobileImageUrl: 'https://images.unsplash.com/photo-1607082348824-0a96f2a4b9da?w=800&q=80',
      desktopImageUrl: 'https://images.unsplash.com/photo-1607082348824-0a96f2a4b9da?w=1600&q=80',
      tabletImageUrl: 'https://images.unsplash.com/photo-1607082348824-0a96f2a4b9da?w=1000&q=80',
      ctaTextAr: 'استكشف العروض',
      priority: 100,
    },
    {
      id: 'banner-mega-white-friday-sec',
      placementKey: 'HOME_SECONDARY',
      name: 'تخفيضات الميجا الكبرى ⚡',
      titleAr: 'عروض الميجا الحصرية الخاطفة',
      titleEn: 'Exclusive Mega Campaign Deals',
      subtitleAr: 'وفر حتى 50% على أفضل الماركات والمنتجات المختارة',
      subtitleEn: 'Save up to 50% on top curated brands and products',
      mobileImageUrl: 'https://images.unsplash.com/photo-1607083206869-4c7672e72a8a?w=800&q=80',
      desktopImageUrl: 'https://images.unsplash.com/photo-1607083206869-4c7672e72a8a?w=1600&q=80',
      tabletImageUrl: 'https://images.unsplash.com/photo-1607083206869-4c7672e72a8a?w=1000&q=80',
      ctaTextAr: 'تسوق الآن',
      priority: 95,
    },
    {
      id: 'banner-mega-voucher-strip',
      placementKey: 'HOME_VOUCHER',
      name: 'شريط قسائم خصم المهرجان',
      titleAr: 'قسائم خصم فورية بقيمة 50 ريال و20% للمهرجان',
      titleEn: 'Instant Mega Vouchers 50 YER & 20% Off',
      subtitleAr: 'احصل على قسيمتك فوراً واستخدمها عند إتمام الطلب',
      subtitleEn: 'Claim your voucher now and apply it at checkout',
      mobileImageUrl: 'https://images.unsplash.com/photo-1556742049-0a67c5574f73?w=800&q=80',
      desktopImageUrl: 'https://images.unsplash.com/photo-1556742049-0a67c5574f73?w=1600&q=80',
      tabletImageUrl: 'https://images.unsplash.com/photo-1556742049-0a67c5574f73?w=1000&q=80',
      ctaTextAr: 'استلم القسيمة',
      priority: 90,
    },
    {
      id: 'banner-mega-flash-sale',
      placementKey: 'HOME_FLASH_SALE',
      name: 'بانر العروض الخاطفة للحملة الكبرى',
      titleAr: 'عروض خاطفة ميجا ⚡ لفترة محدودة جداً',
      titleEn: 'Mega Flash Deals ⚡ Limited Time Only',
      subtitleAr: 'أسعار تبدأ من 50 ريال فقط - سارع بالشراء قبل نفاد الكمية',
      subtitleEn: 'Prices starting from 50 YER - Grab yours before stock runs out',
      mobileImageUrl: 'https://images.unsplash.com/photo-1526178613552-2b45c6c302f0?w=800&q=80',
      desktopImageUrl: 'https://images.unsplash.com/photo-1526178613552-2b45c6c302f0?w=1600&q=80',
      tabletImageUrl: 'https://images.unsplash.com/photo-1526178613552-2b45c6c302f0?w=1000&q=80',
      ctaTextAr: 'اغتنم العرض',
      priority: 90,
    },
    {
      id: 'banner-mega-category-top',
      placementKey: 'CATEGORY_TOP',
      name: 'بانر أعلى الأقسام - مهرجان الميجا',
      titleAr: 'تخفيضات الأقسام الكبرى | عروض المهرجان',
      titleEn: 'Category Mega Fest | All Departments Deals',
      subtitleAr: 'خصومات تصل إلى 60% في كافة الأقسام والتصنيفات',
      subtitleEn: 'Up to 60% off across all product categories',
      mobileImageUrl: 'https://images.unsplash.com/photo-1472851294608-062f824d29cc?w=800&q=80',
      desktopImageUrl: 'https://images.unsplash.com/photo-1472851294608-062f824d29cc?w=1600&q=80',
      tabletImageUrl: 'https://images.unsplash.com/photo-1472851294608-062f824d29cc?w=1000&q=80',
      ctaTextAr: 'تصفح العروض',
      priority: 85,
    },
    {
      id: 'banner-mega-search-top',
      placementKey: 'SEARCH_TOP',
      name: 'بانر البحث المميز - مهرجان الميجا',
      titleAr: 'مهرجان التسوق الأكبر - عروض البحث الحصرية',
      titleEn: 'Mega Festival - Top Sponsored Search Deals',
      subtitleAr: 'لا تفوت أقوى الصفقات والخصومات على آلاف المنتجات',
      subtitleEn: 'Don’t miss top deals and discounts on thousands of items',
      mobileImageUrl: 'https://images.unsplash.com/photo-1441986300917-64674bd600d8?w=800&q=80',
      desktopImageUrl: 'https://images.unsplash.com/photo-1441986300917-64674bd600d8?w=1600&q=80',
      tabletImageUrl: 'https://images.unsplash.com/photo-1441986300917-64674bd600d8?w=1000&q=80',
      ctaTextAr: 'اكتشف العروض',
      priority: 85,
    },
    {
      id: 'banner-mega-product-top',
      placementKey: 'PRODUCT_TOP',
      name: 'بانر تفاصيل المنتج - مهرجان الميجا',
      titleAr: 'منتج مؤهل ضمن عروض الميجا الكبرى 🌟',
      titleEn: 'Eligible Item in Mega Campaign Deals 🌟',
      subtitleAr: 'احصل على خصم إضافي وشحن مجاني عند الطلب الآن',
      subtitleEn: 'Get extra discounts and free shipping on your order now',
      mobileImageUrl: 'https://images.unsplash.com/photo-1505740420928-5e560c06d30e?w=800&q=80',
      desktopImageUrl: 'https://images.unsplash.com/photo-1505740420928-5e560c06d30e?w=1600&q=80',
      tabletImageUrl: 'https://images.unsplash.com/photo-1505740420928-5e560c06d30e?w=1000&q=80',
      ctaTextAr: 'عروض المهرجان',
      priority: 80,
    },
    {
      id: 'banner-mega-store-top',
      placementKey: 'STORE_TOP',
      name: 'بانر واجهة المتاجر - مهرجان الميجا',
      titleAr: 'متجر مشارك في مهرجان سوقناا السنوي الأكبر',
      titleEn: 'Participating Store in Souqnaa Mega Shopping Festival',
      subtitleAr: 'تسوق من المتاجر الرسمية المعتمدة واستمتع بأقوى العروض',
      subtitleEn: 'Shop from certified official stores with the biggest savings',
      mobileImageUrl: 'https://images.unsplash.com/photo-1513151233558-d860c5398176?w=800&q=80',
      desktopImageUrl: 'https://images.unsplash.com/photo-1513151233558-d860c5398176?w=1600&q=80',
      tabletImageUrl: 'https://images.unsplash.com/photo-1513151233558-d860c5398176?w=1000&q=80',
      ctaTextAr: 'زيارة المهرجان',
      priority: 80,
    },
    {
      id: 'banner-mega-checkout-promo',
      placementKey: 'CHECKOUT_PROMOTION',
      name: 'بانر إتمام الشراء والدفع - مهرجان الميجا',
      titleAr: 'وفّر أكثر عند الدفع مع قسائم الحملة الكبرى',
      titleEn: 'Save More at Checkout with Mega Vouchers',
      subtitleAr: 'استخدم قسائم التوفير والخصم الحصرية لتوفير فوري',
      subtitleEn: 'Use exclusive vouchers for instant discount',
      mobileImageUrl: 'https://images.unsplash.com/photo-1559526324-4b87b5e36e44?w=800&q=80',
      desktopImageUrl: 'https://images.unsplash.com/photo-1559526324-4b87b5e36e44?w=1600&q=80',
      tabletImageUrl: 'https://images.unsplash.com/photo-1559526324-4b87b5e36e44?w=1000&q=80',
      ctaTextAr: 'عرض القسائم',
      priority: 80,
    },
  ];

  for (const b of megaBanners) {
    const placementId = placementMap.get(b.placementKey);
    if (!placementId) continue;

    // Create or find deep link
    const deepLinkPath = `/campaign/${megaCampaign.id}`;
    let deepLink = await prisma.deepLink.findFirst({
      where: { path: deepLinkPath },
    });
    if (!deepLink) {
      deepLink = await prisma.deepLink.create({
        data: {
          path: deepLinkPath,
          type: 'CAMPAIGN',
          targetId: megaCampaign.id,
        },
      });
    }

    await prisma.promotionalBanner.upsert({
      where: { id: b.id },
      update: {
        campaignId: megaCampaign.id,
        placementId,
        name: b.name,
        title: b.titleAr,
        subtitle: b.subtitleAr,
        mobileImageUrl: b.mobileImageUrl,
        desktopImageUrl: b.desktopImageUrl,
        tabletImageUrl: b.tabletImageUrl,
        altText: b.titleAr,
        status: 'APPROVED',
        isActive: true,
        priority: b.priority,
        startAt,
        endAt,
        ctaText: b.ctaTextAr,
        ctaType: 'SHOP_NOW',
        deepLinkId: deepLink.id,
      },
      create: {
        id: b.id,
        campaignId: megaCampaign.id,
        placementId,
        name: b.name,
        title: b.titleAr,
        subtitle: b.subtitleAr,
        mobileImageUrl: b.mobileImageUrl,
        desktopImageUrl: b.desktopImageUrl,
        tabletImageUrl: b.tabletImageUrl,
        altText: b.titleAr,
        status: 'APPROVED',
        isActive: true,
        priority: b.priority,
        startAt,
        endAt,
        ctaText: b.ctaTextAr,
        ctaType: 'SHOP_NOW',
        deepLinkId: deepLink.id,
        translations: {
          create: [
            { locale: 'ar', title: b.titleAr, subtitle: b.subtitleAr, ctaText: b.ctaTextAr },
            { locale: 'en', title: b.titleEn, subtitle: b.subtitleEn, ctaText: 'Shop Now' },
          ],
        },
      },
    });
  }

  // Clear all banner caches in Redis
  await bannerCacheService.invalidateAllBanners();
  console.log('✅ All 9 Mega Promotional Banners successfully seeded and activated across all placements!');
}

if (require.main === module) {
  seedMegaBanners()
    .then(() => process.exit(0))
    .catch((err) => {
      console.error('Error seeding mega banners:', err);
      process.exit(1);
    });
}
