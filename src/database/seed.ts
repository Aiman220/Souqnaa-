import {
  PrismaClient,
  UserRoleType,
  SellerStatus,
  AddressType,
  ReviewStatus,
  ReviewMediaType,
  ReviewMediaProcessingStatus,
  ReviewMediaModerationStatus,
  ReviewSellerResponseStatus,
  OrderStatus,
  SellerOrderStatus,
} from '@prisma/client';
import * as bcrypt from 'bcryptjs';
import { recomputeRatingSummary } from '../modules/reviews/reviews.service';
import { seedMegaBanners } from './seed_mega_banners';
import { seedSupportData } from './seed_support';
import { seedNotificationData } from './seed_notifications';

const prisma = new PrismaClient();

async function main() {
  console.log('🌱 Seeding database for سوقناا...');

  // 1. Roles
  const adminRole = await prisma.role.upsert({
    where: { name: 'ADMIN' },
    update: {},
    create: { name: 'ADMIN', description: 'System Administrator' },
  });

  const sellerRole = await prisma.role.upsert({
    where: { name: 'SELLER' },
    update: {},
    create: { name: 'SELLER', description: 'Store Vendor' },
  });

  const customerRole = await prisma.role.upsert({
    where: { name: 'CUSTOMER' },
    update: {},
    create: { name: 'CUSTOMER', description: 'Marketplace Buyer' },
  });

  // 2. System RBAC Roles & Permissions
  const { AdminRbacService } = await import('../modules/admin/admin-rbac.service');
  await AdminRbacService.ensureSystemRolesAndPermissions();
  console.log('🔒 System RBAC matrix verified. Note: Run "npm run bootstrap:admin" for first administrator credentials.');

  // 3. Demo Seller User
  const sellerPassword = await bcrypt.hash('Seller@123456', 10);
  const sellerUser = await prisma.user.upsert({
    where: { email: 'seller@souqnaa.online' },
    update: {
      passwordHash: sellerPassword,
      role: UserRoleType.SELLER,
      isActive: true,
      isVerified: true,
    },
    create: {
      email: 'seller@souqnaa.online',
      phone: '+966500000002',
      passwordHash: sellerPassword,
      firstName: 'أحمد',
      lastName: 'التاجر',
      role: UserRoleType.SELLER,
      isVerified: true,
      isActive: true,
    },
  });

  const sellerProfile = await (prisma.seller as any).upsert({
    where: { userId: sellerUser.id },
    update: {
      taxNumber: '300099887700003',
      idNumber: '1098765432',
      idFrontUrl: 'https://images.unsplash.com/photo-1589829545856-d10d557cf95f?w=600&q=80',
      idBackUrl: 'https://images.unsplash.com/photo-1589829545856-d10d557cf95f?w=600&q=80',
      idSelfieUrl: 'https://images.unsplash.com/photo-1507003211169-0a1dd7228f2d?w=600&q=80',
      businessDocUrl: 'https://images.unsplash.com/photo-1554224155-8d04cb21cd6c?w=600&q=80',
      isOnboarded: true,
    },
    create: {
      userId: sellerUser.id,
      businessType: 'INDIVIDUAL',
      crNumber: 'CR-1010998877',
      taxNumber: '300099887700003',
      idNumber: '1098765432',
      idFrontUrl: 'https://images.unsplash.com/photo-1589829545856-d10d557cf95f?w=600&q=80',
      idBackUrl: 'https://images.unsplash.com/photo-1589829545856-d10d557cf95f?w=600&q=80',
      idSelfieUrl: 'https://images.unsplash.com/photo-1507003211169-0a1dd7228f2d?w=600&q=80',
      businessDocUrl: 'https://images.unsplash.com/photo-1554224155-8d04cb21cd6c?w=600&q=80',
      status: SellerStatus.ACTIVE,
      verifiedAt: new Date(),
      isOnboarded: true,
    },
  });

  await prisma.sellerBalance.upsert({
    where: { sellerId: sellerProfile.id },
    update: {
      currency: 'YER',
    },
    create: {
      sellerId: sellerProfile.id,
      availableBalance: 2450.0,
      pendingBalance: 320.0,
      withdrawnBalance: 5000.0,
      currency: 'YER',
    },
  });

  const demoStore = await prisma.store.upsert({
    where: { slug: 'souqnaa-tech-store' },
    update: {
      rating: 0,
      reviewCount: 0,
    },
    create: {
      sellerId: sellerProfile.id,
      name: 'متجر سوقناا للتقنية',
      slug: 'souqnaa-tech-store',
      description: 'أفضل الإلكترونيات والملحقات الذكية مع ضمان معتمد وشحن سريع',
      rating: 0,
      reviewCount: 0,
      isVerified: true,
      isActive: true,
    },
  });

  // 4. Countries & Cities
  const saudiArabia = await prisma.country.upsert({
    where: { code: 'SA' },
    update: {},
    create: {
      code: 'SA',
      nameAr: 'المملكة العربية السعودية',
      nameEn: 'Saudi Arabia',
      currency: 'SAR',
      phoneCode: '+966',
    },
  });

  const riyadh = await prisma.city.upsert({
    where: { id: 'city-riyadh' },
    update: {},
    create: {
      id: 'city-riyadh',
      countryId: saudiArabia.id,
      nameAr: 'الرياض',
      nameEn: 'Riyadh',
      latitude: 24.7136,
      longitude: 46.6753,
    },
  });

  const jeddah = await prisma.city.upsert({
    where: { id: 'city-jeddah' },
    update: {},
    create: {
      id: 'city-jeddah',
      countryId: saudiArabia.id,
      nameAr: 'جدة',
      nameEn: 'Jeddah',
      latitude: 21.5433,
      longitude: 39.1728,
    },
  });

  const olaya = await prisma.district.upsert({
    where: { id: 'district-olaya' },
    update: {},
    create: {
      id: 'district-olaya',
      cityId: riyadh.id,
      nameAr: 'العليا',
      nameEn: 'Al Olaya',
    },
  });

  // 5. Delivery Methods & Zones
  const standardDelivery = await prisma.deliveryMethod.upsert({
    where: { code: 'standard' },
    update: {},
    create: {
      code: 'standard',
      nameAr: 'الشحن القياسي',
      nameEn: 'Standard Delivery',
      basePrice: 15.0,
      estimatedHoursMin: 24,
      estimatedHoursMax: 48,
    },
  });

  const expressDelivery = await prisma.deliveryMethod.upsert({
    where: { code: 'express' },
    update: {},
    create: {
      code: 'express',
      nameAr: 'الشحن السريع (خلال ساعات)',
      nameEn: 'Express Delivery',
      basePrice: 30.0,
      estimatedHoursMin: 2,
      estimatedHoursMax: 6,
    },
  });

  const riyadhZone = await prisma.deliveryZone.upsert({
    where: { id: 'zone-riyadh' },
    update: {},
    create: {
      id: 'zone-riyadh',
      name: 'منطقة الرياض الكبرى',
      cityId: riyadh.id,
      zoneType: 'CITY',
    },
  });

  await prisma.deliveryRule.create({
    data: {
      deliveryMethodId: standardDelivery.id,
      deliveryZoneId: riyadhZone.id,
      fee: 15.0,
      freeDeliveryThreshold: 200.0,
    },
  });

  // 6. Categories
  const categoriesData = [
    { nameAr: 'إلكترونيات', nameEn: 'Electronics', slug: 'electronics' },
    { nameAr: 'ملابس وأزياء', nameEn: 'Fashion', slug: 'fashion' },
    { nameAr: 'المنزل والمطبخ', nameEn: 'Home & Kitchen', slug: 'home-kitchen' },
    { nameAr: 'عطور وجمال', nameEn: 'Beauty & Perfumes', slug: 'beauty' },
    { nameAr: 'رياضة ولياقة', nameEn: 'Sports', slug: 'sports' },
    { nameAr: 'أغذية وسوبرماركت', nameEn: 'Groceries', slug: 'groceries' },
  ];

  for (const cat of categoriesData) {
    const createdCat = await prisma.category.upsert({
      where: { slug: cat.slug },
      update: {},
      create: {
        nameAr: cat.nameAr,
        nameEn: cat.nameEn,
        slug: cat.slug,
      },
    });

    // Add demo products for electronics
    if (cat.slug === 'electronics') {
      const demoProduct = await prisma.product.upsert({
        where: { slug: 'wireless-noise-cancelling-headphones' },
        update: {
          rating: 0,
          reviewCount: 0,
          soldCount: 0,
          isFeatured: false,
        },
        create: {
          storeId: demoStore.id,
          categoryId: createdCat.id,
          nameAr: 'سماعات رأس لاسلكية عازلة للضوضاء برو',
          nameEn: 'Wireless Noise Cancelling Headphones Pro',
          slug: 'wireless-noise-cancelling-headphones',
          descriptionAr: 'سماعات صوتية عالية النقاء تدعم الشحن السريع وتقنية البلوتوث 5.3 وبطارية تدوم 40 ساعة',
          descriptionEn: 'High fidelity audio headphones with fast charging, BT 5.3, and 40-hour battery life',
          price: 199.99,
          compareAtPrice: 299.99,
          sku: 'TECH-HEADPHONE-01',
          isFeatured: false,
          rating: 0,
          reviewCount: 0,
          soldCount: 0,
          images: {
            create: [
              { url: 'https://picsum.photos/seed/headphones1/800/800', isPrimary: true, sortOrder: 0 },
              { url: 'https://picsum.photos/seed/headphones2/800/800', isPrimary: false, sortOrder: 1 },
            ],
          },
        },
      });

      await prisma.inventory.upsert({
        where: { productId: demoProduct.id },
        update: {},
        create: { productId: demoProduct.id, quantity: 50 },
      });
    }
  }

  // 7. Coupons
  await prisma.coupon.upsert({
    where: { code: 'WELCOME10' },
    update: {},
    create: {
      code: 'WELCOME10',
      discountType: 'PERCENTAGE',
      discountValue: 10,
      minOrderValue: 100.0,
      validFrom: new Date(),
      validUntil: new Date(Date.now() + 365 * 24 * 3600 * 1000),
    },
  });

  // 8. Banners
  await prisma.banner.createMany({
    data: [
      {
        titleAr: 'تخفيضات الموسم الكبرى',
        titleEn: 'Grand Season Sale',
        imageUrl: 'https://picsum.photos/seed/banner1/800/300',
        sortOrder: 0,
      },
      {
        titleAr: 'شحن مجاني على الطلبات فوق 200 ريال',
        titleEn: 'Free Delivery on Orders Over 200 SAR',
        imageUrl: 'https://picsum.photos/seed/banner2/800/300',
        sortOrder: 1,
      },
    ],
    skipDuplicates: true,
  });

  // 9. Distance-Based Delivery Zone Pricing (§11 — 8 zones in YER)
  const deliveryZonePricingData = [
    { name: 'Zone 1', nameAr: 'منطقة 1 (0-2 كم)', minDistanceKm: 0, maxDistanceKm: 2, baseFee: 400, extraFeePerKm: 0, priority: 1 },
    { name: 'Zone 2', nameAr: 'منطقة 2 (2-4 كم)', minDistanceKm: 2, maxDistanceKm: 4, baseFee: 500, extraFeePerKm: 0, priority: 2 },
    { name: 'Zone 3', nameAr: 'منطقة 3 (4-6 كم)', minDistanceKm: 4, maxDistanceKm: 6, baseFee: 700, extraFeePerKm: 0, priority: 3 },
    { name: 'Zone 4', nameAr: 'منطقة 4 (6-8 كم)', minDistanceKm: 6, maxDistanceKm: 8, baseFee: 800, extraFeePerKm: 0, priority: 4 },
    { name: 'Zone 5', nameAr: 'منطقة 5 (8-10 كم)', minDistanceKm: 8, maxDistanceKm: 10, baseFee: 1000, extraFeePerKm: 0, priority: 5 },
    { name: 'Zone 6', nameAr: 'منطقة 6 (10-15 كم)', minDistanceKm: 10, maxDistanceKm: 15, baseFee: 1300, extraFeePerKm: 0, priority: 6 },
    { name: 'Zone 7', nameAr: 'منطقة 7 (15-20 كم)', minDistanceKm: 15, maxDistanceKm: 20, baseFee: 1700, extraFeePerKm: 0, priority: 7 },
    { name: 'Zone 8', nameAr: 'منطقة 8 (أكثر من 20 كم)', minDistanceKm: 20, maxDistanceKm: null, baseFee: 2000, extraFeePerKm: 100, priority: 8 },
  ];

  for (const zone of deliveryZonePricingData) {
    // Use name as a stable lookup (upsert by name is not available — use findFirst)
    const existing = await prisma.deliveryZonePricing.findFirst({ where: { name: zone.name } });
    if (!existing) {
      await prisma.deliveryZonePricing.create({
        data: {
          name: zone.name,
          nameAr: zone.nameAr,
          minDistanceKm: zone.minDistanceKm,
          maxDistanceKm: zone.maxDistanceKm,
          baseFee: zone.baseFee,
          extraFeePerKm: zone.extraFeePerKm,
          currency: 'YER',
          isActive: true,
          priority: zone.priority,
        },
      });
    }
  }

  // 10. Delivery Settings
  const existingSettings = await prisma.deliverySettings.findFirst();
  if (!existingSettings) {
    await prisma.deliverySettings.create({
      data: {
        multiVendorPolicy: 'PER_SELLER',
        expressEnabled: true,
        expressFeeFixed: 500,
        maxDeliveryRadiusKm: 50,
        freeDeliveryThreshold: null,
        currency: 'YER',
      },
    });
  }

  // 11. Delivery Time Slots & Scheduling Rules
  const sampleSlots = [
    { nameAr: 'الفترة الصباحية الأولى', nameEn: 'Morning Slot 1', startTime: '10:00', endTime: '12:00', slotFee: 0, maxOrdersPerDay: 50, priority: 1 },
    { nameAr: 'فترة الظهيرة', nameEn: 'Noon Slot', startTime: '12:00', endTime: '14:00', slotFee: 0, maxOrdersPerDay: 50, priority: 2 },
    { nameAr: 'فترة بعد الظهر', nameEn: 'Afternoon Slot', startTime: '14:00', endTime: '16:00', slotFee: 0, maxOrdersPerDay: 50, priority: 3 },
    { nameAr: 'الفترة المسائية الأولى', nameEn: 'Evening Slot 1', startTime: '16:00', endTime: '18:00', slotFee: 0, maxOrdersPerDay: 50, priority: 4 },
    { nameAr: 'الفترة المسائية المميزة (ذروة)', nameEn: 'Prime Evening Slot', startTime: '18:00', endTime: '20:00', slotFee: 200, maxOrdersPerDay: 50, priority: 5 },
  ];

  for (const s of sampleSlots) {
    const existing = await prisma.deliveryTimeSlot.findFirst({
      where: { startTime: s.startTime, endTime: s.endTime },
    });
    if (!existing) {
      await prisma.deliveryTimeSlot.create({
        data: {
          nameAr: s.nameAr,
          nameEn: s.nameEn,
          startTime: s.startTime,
          endTime: s.endTime,
          slotFee: s.slotFee,
          maxOrdersPerDay: s.maxOrdersPerDay,
          isActive: true,
          priority: s.priority,
          rules: {
            create: [
              // Catch-all rule for all days with 1 hour min advance
              { dayOfWeek: null, minAdvanceHours: 1, isActive: true },
            ],
          },
        },
      });
    }
  }

  // Update DeliverySettings to ensure scheduling is enabled
  if (existingSettings) {
    await prisma.deliverySettings.updateMany({
      data: {
        schedulingEnabled: true,
        schedulingAdvanceDays: 7,
      },
    });
  }

  // 12. Demo Customers, Delivered Orders & Authentic Reviews
  console.log('⭐ Seeding reviews and ratings...');
  const customerPassword = await bcrypt.hash('Customer@123456', 10);
  const demoCustomers = [
    { email: 'customer@souqnaa.online', firstName: 'سارة', lastName: 'أحمد', phone: '+966500000010' },
    { email: 'buyer.mohammed@souqnaa.online', firstName: 'محمد', lastName: 'الغامدي', phone: '+966500000011' },
    { email: 'buyer.abdullah@souqnaa.online', firstName: 'عبدالله', lastName: 'العتيبي', phone: '+966500000012' },
    { email: 'buyer.noura@souqnaa.online', firstName: 'نورة', lastName: 'السعيد', phone: '+966500000013' },
  ];

  const createdCustomers: any[] = [];
  for (const c of demoCustomers) {
    const cust = await prisma.user.upsert({
      where: { email: c.email },
      update: { passwordHash: customerPassword, isVerified: true, isActive: true },
      create: {
        email: c.email,
        phone: c.phone,
        passwordHash: customerPassword,
        firstName: c.firstName,
        lastName: c.lastName,
        role: UserRoleType.CUSTOMER,
        isVerified: true,
        isActive: true,
      },
    });
    await prisma.userRole.upsert({
      where: { userId_roleId: { userId: cust.id, roleId: customerRole.id } },
      update: {},
      create: { userId: cust.id, roleId: customerRole.id },
    });
    createdCustomers.push(cust);
  }

  // 13. Unified Promotional System & Mega Campaigns
  console.log('🌟 Seeding Promotional Placements, Packages & Mega Campaigns...');
  const { placementService } = await import('../modules/promotions/services/placement.service');
  await placementService.seedDefaultPlacements();

  // Seller Promotion Packages
  const packages = [
    {
      name: 'Homepage Sponsored Products',
      nameAr: 'ترويج المنتجات المُموَّلة (الرئيسية)',
      description: 'Feature single products in high-visibility sponsored rail on customer home page',
      descriptionAr: 'ظهور المنتجات في شريط المنتجات المُموَّلة الأكثر ظهوراً بالصفحة الرئيسية لمدة 7 أيام',
      placementKey: 'SPONSORED_PRODUCTS',
      promotionType: 'PRODUCT' as const,
      price: 8000,
      currency: 'YER',
      durationDays: 7,
      impressionLimit: 10000,
      clickLimit: 500,
      displayOrder: 1,
    },
    {
      name: 'Curated Collection Lookbook Showcase',
      nameAr: 'ترويج تشكيلة المنتجات المميزة',
      description: 'Promote an eye-catching lookbook collection card showcasing multiple top products',
      descriptionAr: 'عرض بطاقة تشكيلة أنيقة تحتوي على صور متعددة للمنتجات في الصفحة الرئيسية',
      placementKey: 'SPONSORED_PRODUCTS',
      promotionType: 'COLLECTION' as const,
      price: 15000,
      currency: 'YER',
      durationDays: 7,
      impressionLimit: 20000,
      clickLimit: 1000,
      displayOrder: 2,
    },
    {
      name: 'Basic Search Promotion',
      nameAr: 'ترويج البحث الأساسي',
      description: 'Promote products in search results for 3 days',
      descriptionAr: 'ظهور المنتجات في نتائج البحث للعملاء المهتمين لمدة 3 أيام',
      placementKey: 'SEARCH_PROMOTION',
      promotionType: 'PRODUCT' as const,
      price: 5000,
      currency: 'YER',
      durationDays: 3,
      impressionLimit: 5000,
      clickLimit: 250,
      displayOrder: 3,
    },
    {
      name: 'Standard Category Featured',
      nameAr: 'ترويج القسم والتصنيفات',
      description: 'Promote products in top category rails for 7 days',
      descriptionAr: 'إبراز المنتجات أعلى الأقسام والتصنيفات لمدة 7 أيام',
      placementKey: 'CATEGORY_TOP',
      promotionType: 'PRODUCT' as const,
      price: 12000,
      currency: 'YER',
      durationDays: 7,
      impressionLimit: 15000,
      clickLimit: 800,
      displayOrder: 4,
    },
    {
      name: 'Premium Storefront Discovery',
      nameAr: 'ترويج واكتشاف المتاجر',
      description: 'Promote your store in Featured Stores rail on homepage for 14 days',
      descriptionAr: 'إبراز متجرك في قسم اكتشاف المتاجر المميزة في الصفحة الرئيسية لمدة 14 يوماً',
      placementKey: 'STORE_DISCOVERY',
      promotionType: 'STORE' as const,
      price: 25000,
      currency: 'YER',
      durationDays: 14,
      impressionLimit: 35000,
      clickLimit: 2000,
      displayOrder: 5,
    },
    {
      name: 'Mega Campaign Sponsored Placement',
      nameAr: 'المشاركة المميزة في حملة الميجا',
      description: 'Featured placement inside the official Mega Campaign landing page for the full campaign duration',
      descriptionAr: 'ظهور مميز داخل صفحة هبوط الحملة الكبرى طوال فترة المهرجان',
      placementKey: 'CAMPAIGN_PRODUCTS',
      promotionType: 'CAMPAIGN' as const,
      price: 40000,
      currency: 'YER',
      durationDays: 14,
      impressionLimit: 50000,
      clickLimit: 3500,
      displayOrder: 6,
    },
  ];

  for (const pkg of packages) {
    const existing = await prisma.sellerPromotionPackage.findFirst({
      where: { name: pkg.name },
    });
    if (!existing) {
      await prisma.sellerPromotionPackage.create({ data: pkg });
    } else {
      await prisma.sellerPromotionPackage.update({
        where: { id: existing.id },
        data: pkg,
      });
    }
  }

  // Flagship 11.11 Mega Campaign
  const now = new Date();
  const megaEnd = new Date(now.getTime() + 14 * 86400000);
  const megaCampaign = await prisma.campaign.upsert({
    where: { slug: 'mega-11-11-sale' },
    update: {
      status: 'ACTIVE',
      endAt: megaEnd,
    },
    create: {
      name: 'مهرجان 11.11 التسويقي الكبير | 11.11 Mega Sale',
      slug: 'mega-11-11-sale',
      description: 'أكبر مهرجان تسوق سنوي على منصة سوقناا مع خصومات تصل إلى 70% وقسائم مجانية وعروض خاطفة.',
      campaignType: 'MEGA_CAMPAIGN',
      status: 'ACTIVE',
      startAt: new Date(now.getTime() - 86400000),
      endAt: megaEnd,
      priority: 100,
      ownerType: 'ADMIN',
      currency: 'YER',
      heroAsset: 'https://images.unsplash.com/photo-1607082348824-0a96f2a4b9da?w=1200&q=80',
      mobileAsset: 'https://images.unsplash.com/photo-1607082348824-0a96f2a4b9da?w=600&q=80',
      tabletAsset: 'https://images.unsplash.com/photo-1607082348824-0a96f2a4b9da?w=900&q=80',
      desktopAsset: 'https://images.unsplash.com/photo-1607082348824-0a96f2a4b9da?w=1600&q=80',
      landingPageConfig: {
        theme: {
          primaryColor: '#D97706',
          badgeText: '🌟 11.11 MEGA SALE',
        },
      },
    },
  });

  // Link products into Mega Campaign if available
  const sampleProducts = await prisma.product.findMany({
    take: 6,
    include: { store: true },
  });
  for (const prod of sampleProducts) {
    const origPrice = prod.price;
    const campPrice = Number((origPrice * 0.75).toFixed(0));
    const discount = 25.0;

    const existingCp = await prisma.campaignProduct.findFirst({
      where: { campaignId: megaCampaign.id, productId: prod.id },
    });
    if (existingCp) {
      await prisma.campaignProduct.update({
        where: { id: existingCp.id },
        data: { status: 'APPROVED' },
      });
    } else {
      await prisma.campaignProduct.create({
        data: {
          campaignId: megaCampaign.id,
          sellerId: prod.store.sellerId,
          storeId: prod.storeId,
          productId: prod.id,
          variantId: null,
          status: 'APPROVED',
          originalPrice: origPrice,
          campaignPrice: campPrice,
          discountPercent: discount,
          campaignStock: 50,
          reservedStock: 0,
          soldStock: 12,
          purchaseLimit: 2,
        },
      });
    }

    await prisma.campaignSeller.upsert({
      where: {
        campaignId_sellerId: {
          campaignId: megaCampaign.id,
          sellerId: prod.store.sellerId,
        },
      },
      update: { status: 'APPROVED' },
      create: {
        campaignId: megaCampaign.id,
        sellerId: prod.store.sellerId,
        storeId: prod.storeId,
        status: 'APPROVED',
      },
    });
  }

  // 14. Seed Sample Seller Promotions (Admin Queue & Active Campaigns)
  console.log('🌟 Seeding Sample Seller Promotions...');
  const pkgCategory = await prisma.sellerPromotionPackage.findFirst({ where: { placementKey: 'CATEGORY_TOP' } });
  const pkgSearch = await prisma.sellerPromotionPackage.findFirst({ where: { placementKey: 'SEARCH_PROMOTION' } });
  const pkgStore = await prisma.sellerPromotionPackage.findFirst({ where: { placementKey: 'STORE_DISCOVERY' } });

  if (sampleProducts.length > 0 && pkgCategory && pkgSearch && pkgStore) {
    const p1 = sampleProducts[0];
    const p2 = sampleProducts.length > 1 ? sampleProducts[1] : p1;
    const p3 = sampleProducts.length > 2 ? sampleProducts[2] : p1;

    // Promotion 1: ADMIN_REVIEW (Waiting in approval queue)
    const existingPromo1 = await prisma.sellerPromotion.findFirst({
      where: { sellerId: p1.store.sellerId, placementKey: 'CATEGORY_TOP', status: 'ADMIN_REVIEW' },
    });
    if (!existingPromo1) {
      const promo1 = await prisma.sellerPromotion.create({
        data: {
          sellerId: p1.store.sellerId,
          packageId: pkgCategory.id,
          promotionType: 'PRODUCT',
          status: 'ADMIN_REVIEW',
          placementKey: pkgCategory.placementKey,
          totalBudget: pkgCategory.price,
          spentAmount: 0,
          remainingBudget: pkgCategory.price,
          currency: pkgCategory.currency,
          submittedAt: new Date(now.getTime() - 2 * 3600000),
          paidAt: new Date(now.getTime() - 2 * 3600000),
          items: {
            create: [
              { productId: p1.id, storeId: p1.storeId, sortOrder: 0 },
              { productId: p2.id, storeId: p2.storeId, sortOrder: 1 },
            ],
          },
          payments: {
            create: {
              sellerId: p1.store.sellerId,
              amount: pkgCategory.price,
              currency: pkgCategory.currency,
              paymentType: 'CHARGE',
              status: 'COMPLETED',
              idempotencyKey: `seed-pay-promo-1-${Date.now()}`,
            },
          },
        },
      });
    }

    // Promotion 2: ADMIN_REVIEW (Second waiting in queue)
    const existingPromo2 = await prisma.sellerPromotion.findFirst({
      where: { sellerId: p2.store.sellerId, placementKey: 'SEARCH_PROMOTION', status: 'ADMIN_REVIEW' },
    });
    if (!existingPromo2) {
      await prisma.sellerPromotion.create({
        data: {
          sellerId: p2.store.sellerId,
          packageId: pkgSearch.id,
          promotionType: 'PRODUCT',
          status: 'ADMIN_REVIEW',
          placementKey: pkgSearch.placementKey,
          totalBudget: pkgSearch.price,
          spentAmount: 0,
          remainingBudget: pkgSearch.price,
          currency: pkgSearch.currency,
          submittedAt: new Date(now.getTime() - 5 * 3600000),
          paidAt: new Date(now.getTime() - 5 * 3600000),
          items: {
            create: [
              { productId: p2.id, storeId: p2.storeId, sortOrder: 0 },
            ],
          },
          payments: {
            create: {
              sellerId: p2.store.sellerId,
              amount: pkgSearch.price,
              currency: pkgSearch.currency,
              paymentType: 'CHARGE',
              status: 'COMPLETED',
              idempotencyKey: `seed-pay-promo-2-${Date.now()}`,
            },
          },
        },
      });
    }

    // Promotion 3: ACTIVE (Live store promotion)
    const existingPromo3 = await prisma.sellerPromotion.findFirst({
      where: { sellerId: p1.store.sellerId, placementKey: 'STORE_DISCOVERY', status: 'ACTIVE' },
    });
    if (!existingPromo3) {
      await prisma.sellerPromotion.create({
        data: {
          sellerId: p1.store.sellerId,
          packageId: pkgStore.id,
          promotionType: 'STORE',
          status: 'ACTIVE',
          placementKey: pkgStore.placementKey,
          totalBudget: pkgStore.price,
          spentAmount: 8500,
          remainingBudget: pkgStore.price - 8500,
          currency: pkgStore.currency,
          startAt: new Date(now.getTime() - 3 * 86400000),
          endAt: new Date(now.getTime() + 11 * 86400000),
          submittedAt: new Date(now.getTime() - 4 * 86400000),
          paidAt: new Date(now.getTime() - 4 * 86400000),
          approvedAt: new Date(now.getTime() - 3 * 86400000),
          impressionCount: 4850,
          clickCount: 230,
          conversionCount: 18,
          revenue: 58000,
          items: {
            create: [
              { storeId: p1.storeId, sortOrder: 0 },
            ],
          },
          payments: {
            create: {
              sellerId: p1.store.sellerId,
              amount: pkgStore.price,
              currency: pkgStore.currency,
              paymentType: 'CHARGE',
              status: 'COMPLETED',
              idempotencyKey: `seed-pay-promo-3-${Date.now()}`,
            },
          },
        },
      });
    }

    // Promotion 4: ACTIVE (Live category promotion)
    const existingPromo4 = await prisma.sellerPromotion.findFirst({
      where: { sellerId: p3.store.sellerId, placementKey: 'CATEGORY_TOP', status: 'ACTIVE' },
    });
    if (!existingPromo4) {
      await prisma.sellerPromotion.create({
        data: {
          sellerId: p3.store.sellerId,
          packageId: pkgCategory.id,
          promotionType: 'PRODUCT',
          status: 'ACTIVE',
          placementKey: pkgCategory.placementKey,
          totalBudget: pkgCategory.price,
          spentAmount: 4200,
          remainingBudget: pkgCategory.price - 4200,
          currency: pkgCategory.currency,
          startAt: new Date(now.getTime() - 1 * 86400000),
          endAt: new Date(now.getTime() + 6 * 86400000),
          submittedAt: new Date(now.getTime() - 2 * 86400000),
          paidAt: new Date(now.getTime() - 2 * 86400000),
          approvedAt: new Date(now.getTime() - 1 * 86400000),
          impressionCount: 1940,
          clickCount: 95,
          conversionCount: 8,
          revenue: 26000,
          items: {
            create: [
              { productId: p3.id, storeId: p3.storeId, sortOrder: 0 },
            ],
          },
          payments: {
            create: {
              sellerId: p3.store.sellerId,
              amount: pkgCategory.price,
              currency: pkgCategory.currency,
              paymentType: 'CHARGE',
              status: 'COMPLETED',
              idempotencyKey: `seed-pay-promo-4-${Date.now()}`,
            },
          },
        },
      });
    }
  }

  // 15. Seed Vouchers for Mega Campaign & Platform
  console.log('🎟️ Seeding Vouchers for Mega Campaign & Platform...');
  const vouchersList = [
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
      description: 'خصم 20% بحد أقصى 10,000 ريال يمني على كافة منتجات حملة 11.11',
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
    {
      code: 'SUPER10',
      normalizedCode: 'SUPER10',
      name: 'خصم إضافي 10% للمتسوقين',
      description: 'وفّر 10% إضافية عند الدفع الإلكتروني أو الشراء الفوري',
      discountType: 'PERCENTAGE' as const,
      discountValue: 10,
      minimumOrderAmount: 100,
      currency: 'YER',
      isClaimable: true,
      startAt: new Date(now.getTime() - 86400000),
      endAt: new Date(now.getTime() + 30 * 86400000),
      status: 'ACTIVE' as const,
    },
  ];

  for (const v of vouchersList) {
    await prisma.voucher.upsert({
      where: { normalizedCode: v.normalizedCode },
      update: {
        status: 'ACTIVE',
        isClaimable: true,
        startAt: v.startAt,
        endAt: v.endAt,
      },
      create: v,
    });
  }

  // 16. Seed & Activate Mega Campaign Promotional Banners across all Placements
  await seedMegaBanners();

  // 17. Seed Support Center Configuration (Departments, SLAs, Categories, Quick Replies, Agents, FAQs)
  await seedSupportData();

  // 18. Seed Souqnaa Centralized Notification Platform (Templates, Preferences & Initial Notifs)
  await seedNotificationData();

  // 19. Seed Production-Grade Centralized Tax Engine Configuration & Rules
  await seedTaxData();

  console.log('✅ Database seeded successfully.');
}

async function seedTaxData() {
  const globalConfig = await prisma.taxConfiguration.upsert({
    where: { id: 'global' },
    update: {
      taxEnabled: true,
      defaultRate: 0.05,
    },
    create: {
      id: 'global',
      taxEnabled: true,
      taxInclusivePrices: false,
      taxOnShippingEnabled: false,
      taxOnPlatformFeesEnabled: false,
      taxOnPaymentFeesEnabled: false,
      discountTreatment: 'AFTER_DISCOUNT',
      roundingStrategy: 'HALF_UP',
      roundingLevel: 'LINE_ITEM',
      defaultRate: 0.05,
      currency: 'YER',
      version: 1,
    },
  });

  const existingVat = await prisma.taxRule.findFirst({
    where: { code: 'VAT_STANDARD_DEFAULT' },
  });
  let standardRuleId = existingVat?.id;
  if (!existingVat) {
    const created = await prisma.taxRule.create({
      data: {
        name: 'ضريبة القيمة المضافة الافتراضية (سوقناا)',
        code: 'VAT_STANDARD_DEFAULT',
        description: 'الضريبة العامة الموحدة للسلع والمنتجات على منصة سوقناا',
        rate: 0.05,
        calculationMethod: 'PERCENTAGE',
        priceIncludesTax: false,
        appliesToProducts: true,
        appliesToShipping: false,
        appliesToPlatformFees: false,
        appliesToPaymentFees: false,
        appliesToDiscounts: true,
        active: true,
        priority: 100,
        targetType: 'DEFAULT',
        version: 1,
      },
    });
    standardRuleId = created.id;
  }

  const existingElectronics = await prisma.taxRule.findFirst({
    where: { code: 'VAT_ELECTRONICS_STANDARD' },
  });
  if (!existingElectronics) {
    await prisma.taxRule.create({
      data: {
        name: 'ضريبة الإلكترونيات والأجهزة الذكية',
        code: 'VAT_ELECTRONICS_STANDARD',
        description: 'ضريبة خاصة على الإلكترونيات والأجهزة الكهربائية الاستهلاكية',
        rate: 0.05,
        calculationMethod: 'PERCENTAGE',
        priceIncludesTax: false,
        appliesToProducts: true,
        appliesToShipping: false,
        appliesToPlatformFees: false,
        appliesToPaymentFees: false,
        appliesToDiscounts: true,
        active: true,
        priority: 200,
        targetType: 'CATEGORY',
        version: 1,
      },
    });
  }

  const existingEssentials = await prisma.taxRule.findFirst({
    where: { code: 'VAT_ESSENTIALS_ZERO' },
  });
  if (!existingEssentials) {
    await prisma.taxRule.create({
      data: {
        name: 'السلع الأساسية المعفاة (صفرية الضريبة)',
        code: 'VAT_ESSENTIALS_ZERO',
        description: 'السلع التموينية والغذائية الأساسية المعفاة بموجب اللائحة التنفيذية',
        rate: 0.00,
        calculationMethod: 'PERCENTAGE',
        priceIncludesTax: false,
        appliesToProducts: true,
        appliesToShipping: false,
        appliesToPlatformFees: false,
        appliesToPaymentFees: false,
        appliesToDiscounts: true,
        active: true,
        priority: 300,
        targetType: 'CATEGORY',
        version: 1,
      },
    });
  }

  const existingExemption = await prisma.taxExemption.findFirst({
    where: { reason: 'إعفاء السلع التموينية والغذائية الاستراتيجية الوطنية' },
  });

  if (!existingExemption) {
    await prisma.taxExemption.create({
      data: {
        entityType: 'CATEGORY',
        entityId: 'cat-groceries-staples',
        reason: 'إعفاء السلع التموينية والغذائية الاستراتيجية الوطنية',
        active: true,
      },
    });
  }

  const existingAudit = await prisma.taxAuditLog.findFirst({
    where: { ruleId: standardRuleId },
  });
  if (!existingAudit && standardRuleId) {
    await prisma.taxAuditLog.create({
      data: {
        action: 'CREATE',
        ruleId: standardRuleId,
        adminId: null,
        reason: 'تهيئة القواعد الضريبية الأولية لمنصة سوقناا',
        newValue: JSON.stringify({ config: globalConfig }),
      },
    });
  }

  // Seed demo transactions with immutable tax snapshots
  const seller = await prisma.seller.findFirst();
  const customer = (await prisma.user.findFirst({ where: { role: 'CUSTOMER' } })) || (await prisma.user.findFirst());
  const sampleProduct = await prisma.product.findFirst();

  if (seller && customer && standardRuleId && sampleProduct) {
    // 1. Completed Order 1
    const orderNum1 = 'SQ-2026-0930-000101';
    let ord1 = await prisma.order.findUnique({ where: { orderNumber: orderNum1 } });
    if (!ord1) {
      ord1 = await prisma.order.create({
        data: {
          orderNumber: orderNum1,
          displayOrderNumber: 'SQ-000101',
          userId: customer.id,
          status: 'DELIVERED',
          subtotal: 500.0,
          deliveryFee: 15.0,
          taxAmount: 25.0,
          total: 540.0,
          currency: 'YER',
        },
      });

      const so1 = await prisma.sellerOrder.create({
        data: {
          orderId: ord1.id,
          sellerId: seller.id,
          sellerOrderNumber: `${orderNum1}-S01`,
          status: 'DELIVERED',
          subtotal: 500.0,
          deliveryFee: 15.0,
          taxAmount: 25.0,
          commissionAmount: 50.0,
          sellerPayout: 450.0,
        },
      });

      const it1 = await prisma.orderItem.create({
        data: {
          sellerOrderId: so1.id,
          productId: sampleProduct.id,
          productNameAr: 'سماعات رأس لاسلكية احترافية عازلة للضوضاء',
          productNameEn: 'Wireless Noise Cancelling Headphones',
          unitPrice: 250.0,
          quantity: 2,
          totalPrice: 500.0,
          taxAmount: 25.0,
        },
      });

      await prisma.orderTaxSnapshot.create({
        data: {
          orderId: ord1.id,
          sellerOrderId: so1.id,
          orderItemId: it1.id,
          sellerId: seller.id,
          taxRuleId: standardRuleId,
          taxRuleVersion: 1,
          taxName: 'ضريبة القيمة المضافة الافتراضية (سوقناا)',
          taxRate: 0.05,
          taxableAmount: 500.0,
          taxAmount: 25.0,
          calculationMethod: 'PERCENTAGE',
          priceIncludesTax: false,
          currency: 'YER',
        },
      });
    }

    // 2. Completed Order 2
    const orderNum2 = 'SQ-2026-0930-000102';
    let ord2 = await prisma.order.findUnique({ where: { orderNumber: orderNum2 } });
    if (!ord2) {
      ord2 = await prisma.order.create({
        data: {
          orderNumber: orderNum2,
          displayOrderNumber: 'SQ-000102',
          userId: customer.id,
          status: 'DELIVERED',
          subtotal: 1200.0,
          deliveryFee: 15.0,
          taxAmount: 60.0,
          total: 1275.0,
          currency: 'YER',
        },
      });

      const so2 = await prisma.sellerOrder.create({
        data: {
          orderId: ord2.id,
          sellerId: seller.id,
          sellerOrderNumber: `${orderNum2}-S01`,
          status: 'DELIVERED',
          subtotal: 1200.0,
          deliveryFee: 15.0,
          taxAmount: 60.0,
          commissionAmount: 120.0,
          sellerPayout: 1080.0,
        },
      });

      const it2 = await prisma.orderItem.create({
        data: {
          sellerOrderId: so2.id,
          productId: sampleProduct.id,
          productNameAr: 'ساعة ذكية رياضية فائقة الدقة',
          productNameEn: 'Pro Smart Sport Watch',
          unitPrice: 1200.0,
          quantity: 1,
          totalPrice: 1200.0,
          taxAmount: 60.0,
        },
      });

      await prisma.orderTaxSnapshot.create({
        data: {
          orderId: ord2.id,
          sellerOrderId: so2.id,
          orderItemId: it2.id,
          sellerId: seller.id,
          taxRuleId: standardRuleId,
          taxRuleVersion: 1,
          taxName: 'ضريبة القيمة المضافة الافتراضية (سوقناا)',
          taxRate: 0.05,
          taxableAmount: 1200.0,
          taxAmount: 60.0,
          calculationMethod: 'PERCENTAGE',
          priceIncludesTax: false,
          currency: 'YER',
        },
      });
    }

    // 3. Partially Refunded Order 3
    const orderNum3 = 'SQ-2026-0930-000103';
    let ord3 = await prisma.order.findUnique({ where: { orderNumber: orderNum3 } });
    if (!ord3) {
      ord3 = await prisma.order.create({
        data: {
          orderNumber: orderNum3,
          displayOrderNumber: 'SQ-000103',
          userId: customer.id,
          status: 'REFUNDED',
          subtotal: 300.0,
          deliveryFee: 15.0,
          taxAmount: 15.0,
          total: 330.0,
          currency: 'YER',
        },
      });

      const so3 = await prisma.sellerOrder.create({
        data: {
          orderId: ord3.id,
          sellerId: seller.id,
          sellerOrderNumber: `${orderNum3}-S01`,
          status: 'REFUNDED',
          subtotal: 300.0,
          deliveryFee: 15.0,
          taxAmount: 15.0,
          commissionAmount: 30.0,
          sellerPayout: 0.0,
        },
      });

      const it3 = await prisma.orderItem.create({
        data: {
          sellerOrderId: so3.id,
          productId: sampleProduct.id,
          productNameAr: 'شاحن جداري سريع بقدرة 65 واط',
          productNameEn: 'Fast Wall Charger 65W',
          unitPrice: 300.0,
          quantity: 1,
          totalPrice: 300.0,
          taxAmount: 15.0,
        },
      });

      await prisma.orderTaxSnapshot.create({
        data: {
          orderId: ord3.id,
          sellerOrderId: so3.id,
          orderItemId: it3.id,
          sellerId: seller.id,
          taxRuleId: standardRuleId,
          taxRuleVersion: 1,
          taxName: 'ضريبة القيمة المضافة الافتراضية (سوقناا)',
          taxRate: 0.05,
          taxableAmount: 300.0,
          taxAmount: 15.0,
          calculationMethod: 'PERCENTAGE',
          priceIncludesTax: false,
          currency: 'YER',
        },
      });

      const refundReq = await prisma.refundRequest.create({
        data: {
          refundNumber: 'REF-2026-0930-000101',
          orderId: ord3.id,
          sellerOrderId: so3.id,
          customerId: customer.id,
          sellerId: seller.id,
          requestedAmount: 330.0,
          approvedAmount: 330.0,
          reasonText: 'خلل في المنتج وتم قبول الإرجاع بالكامل',
          status: 'REFUNDED',
        },
      });

      await prisma.refundTaxRecord.create({
        data: {
          refundId: refundReq.id,
          orderId: ord3.id,
          sellerOrderId: so3.id,
          orderItemId: it3.id,
          originalTax: 15.0,
          refundedTax: 15.0,
          remainingTax: 0.0,
          calculationReference: 'ITEM_PRORATED',
        },
      });
    }
  }
}

main()
  .catch((e) => {
    console.error('Seeding error:', e);
    process.exit(1);
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
