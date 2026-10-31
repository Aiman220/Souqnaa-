import { prisma } from './prisma';

export const DEFAULT_MEMBERSHIP_TIERS = [
  {
    code: 'BASIC',
    nameAr: 'الأساسي',
    nameEn: 'Basic',
    descriptionAr: 'الفئة الترحيبية الأساسية لجميع عملاء سوقناا الجدد',
    descriptionEn: 'Standard starting tier for all registered Souqna customers',
    level: 1,
    priority: 10,
    isActive: true,
    icon: 'user',
    badgeAssetUrl: '/assets/badges/badge_regular.png',
    qualificationRules: JSON.stringify({
      logic: 'ALL',
      rules: [
        {
          metric: 'COMPLETED_ORDERS',
          operator: 'GTE',
          value: 0,
        },
      ],
    }),
    benefitConfiguration: JSON.stringify({
      perks: [
        'Standard marketplace shopping',
        'Standard customer support',
        'Access to public sales and promotions',
      ],
      perksAr: [
        'تسوق كامل المنتجات في السوق',
        'خدمة عملاء قياسية',
        'الاستفادة من العروض والتخفيضات العامة',
      ],
      coinsMultiplier: 1.0,
      freeShipping: false,
      prioritySupport: false,
      exclusiveCampaignAccess: false,
    }),
    validityConfiguration: JSON.stringify({
      periodType: 'LIFETIME',
      days: 0,
      gracePeriodDays: 0,
      downgradePolicy: 'KEEP_TIER',
    }),
  },
  {
    code: 'SILVER',
    nameAr: 'عضو فضي',
    nameEn: 'Silver',
    descriptionAr: 'عضوية فضية للمتسوقين المنتظمين بـ 7 طلبات أو 60,000 ريال سنوي',
    descriptionEn: 'Silver tier for regular shoppers with 7 orders or 60,000 YER spend',
    level: 2,
    priority: 20,
    isActive: true,
    icon: 'star',
    badgeAssetUrl: '/assets/badges/badge_premium.png',
    qualificationRules: JSON.stringify({
      logic: 'ANY',
      rules: [
        {
          metric: 'COMPLETED_ORDERS',
          operator: 'GTE',
          value: 7,
        },
        {
          metric: 'PERIOD_SPEND',
          operator: 'GTE',
          value: 60000,
        },
      ],
    }),
    benefitConfiguration: JSON.stringify({
      perks: [
        '10% bonus Souqna Coins on all purchases',
        'Discounted shipping on orders over 15,000 YER',
        'Early access to Flash Sales by 1 hour',
        'Exclusive monthly Silver voucher bundle',
      ],
      perksAr: [
        'مضاعف عملات سوقناا 1.1x على جميع المشتريات',
        'خصم رسوم الشحن عند الشراء بأكثر من 15,000 ريال',
        'دخول مبكر لعروض التخفيضات الكبرى بساعة',
        'حزمة كوبونات شهرية حصرية للأعضاء الفضيين',
      ],
      coinsMultiplier: 1.1,
      freeShipping: false,
      prioritySupport: false,
      exclusiveCampaignAccess: true,
    }),
    validityConfiguration: JSON.stringify({
      periodType: 'ROLLING_DAYS',
      days: 365,
      gracePeriodDays: 30,
      downgradePolicy: 'DOWNGRADE',
    }),
  },
  {
    code: 'GOLD',
    nameAr: 'عضو VIP ذهبي',
    nameEn: 'Gold',
    descriptionAr: 'فئة كبار العملاء مع مزايا شحن مجاني ودعم مميز وأولوية قصوى',
    descriptionEn: 'VIP Gold tier with free shipping eligibility, priority concierge support, and high multipliers',
    level: 3,
    priority: 30,
    isActive: true,
    icon: 'crown',
    badgeAssetUrl: '/assets/badges/badge_vip.png',
    qualificationRules: JSON.stringify({
      logic: 'ANY',
      rules: [
        {
          metric: 'COMPLETED_ORDERS',
          operator: 'GTE',
          value: 15,
        },
        {
          metric: 'PERIOD_SPEND',
          operator: 'GTE',
          value: 120000,
        },
      ],
    }),
    benefitConfiguration: JSON.stringify({
      perks: [
        'Free standard shipping on orders over 10,000 YER',
        '20% bonus Souqna Coins multiplier (1.2x)',
        'VIP concierge dedicated customer support',
        'VIP Week exclusive campaigns and closed discounts',
        'Higher return window grace (7 days)',
      ],
      perksAr: [
        'شحن قياسي مجاني للطلبات فوق 10,000 ريال',
        'مضاعف عملات سوقناا 1.2x (زيادة 20% عملات)',
        'خدمة دعم عملاء كبار الشخصيات VIP المباشرة',
        'دخول حصري لحملات وأسبوع VIP بتخفيضات خاصة',
        'تمديد مهلة إرجاع المنتجات حتى 7 أيام إضافية',
      ],
      coinsMultiplier: 1.2,
      freeShipping: true,
      minOrderForFreeShipping: 10000,
      prioritySupport: true,
      exclusiveCampaignAccess: true,
    }),
    validityConfiguration: JSON.stringify({
      periodType: 'ROLLING_DAYS',
      days: 365,
      gracePeriodDays: 45,
      downgradePolicy: 'GRACE_PERIOD',
    }),
  },
  {
    code: 'VIP_PLUS',
    nameAr: 'عضو VIP+ البلاتيني',
    nameEn: 'VIP+ Platinum',
    descriptionAr: 'النخبة البلاتينية: شحن مجاني مطلق، مضاعف 1.35x، ودعوات تسوق حصرية',
    descriptionEn: 'Platinum Elite tier: unconditional free shipping, 1.35x coins, and luxury concierge',
    level: 4,
    priority: 40,
    isActive: true,
    icon: 'diamond',
    badgeAssetUrl: '/assets/badges/badge_vip_plus.png',
    qualificationRules: JSON.stringify({
      logic: 'ANY',
      rules: [
        {
          metric: 'COMPLETED_ORDERS',
          operator: 'GTE',
          value: 30,
        },
        {
          metric: 'PERIOD_SPEND',
          operator: 'GTE',
          value: 250000,
        },
      ],
    }),
    benefitConfiguration: JSON.stringify({
      perks: [
        'Unconditional Free Shipping on all orders',
        '35% bonus Souqna Coins multiplier (1.35x)',
        'VIP+ Private Concierge manager 24/7',
        'Birthday luxury gift voucher bundle',
        'Free instant returns with zero return shipping fee',
      ],
      perksAr: [
        'شحن مجاني كامل وغير مشروط لجميع الطلبات',
        'مضاعف عملات سوقناا 1.35x الأقصى في المنصة',
        'مدير حساب خاص لخدمة VIP+ على مدار الساعة',
        'قسيمة هدية ومفاجأة سنوية في يوم الميلاد',
        'إرجاع فوري مجاني دون أي تكاليف شحن مرتجع',
      ],
      coinsMultiplier: 1.35,
      freeShipping: true,
      minOrderForFreeShipping: 0,
      prioritySupport: true,
      exclusiveCampaignAccess: true,
    }),
    validityConfiguration: JSON.stringify({
      periodType: 'ROLLING_DAYS',
      days: 365,
      gracePeriodDays: 60,
      downgradePolicy: 'GRACE_PERIOD',
    }),
  },
];

export async function seedMembershipTiers() {
  console.log('[Seed] Seeding Membership Tiers...');

  // Map legacy codes if present in DB
  const legacyRegular = await prisma.membershipTier.findUnique({ where: { code: 'REGULAR' } });
  if (legacyRegular) {
    await prisma.membershipTier.update({
      where: { code: 'REGULAR' },
      data: {
        code: 'BASIC',
        nameAr: 'الأساسي',
        nameEn: 'Basic',
        level: 1,
        priority: 10,
        qualificationRules: JSON.stringify({
          logic: 'ALL',
          rules: [{ metric: 'COMPLETED_ORDERS', operator: 'GTE', value: 0 }],
        }),
      },
    });
  }

  const legacyPremium = await prisma.membershipTier.findUnique({ where: { code: 'PREMIUM' } });
  if (legacyPremium) {
    await prisma.membershipTier.update({
      where: { code: 'PREMIUM' },
      data: {
        code: 'SILVER',
        nameAr: 'عضو فضي',
        nameEn: 'Silver',
        level: 2,
        priority: 20,
      },
    });
  }

  const legacyVip = await prisma.membershipTier.findUnique({ where: { code: 'VIP' } });
  if (legacyVip) {
    await prisma.membershipTier.update({
      where: { code: 'VIP' },
      data: {
        code: 'GOLD',
        nameAr: 'عضو VIP ذهبي',
        nameEn: 'Gold',
        level: 3,
        priority: 30,
      },
    });
  }

  // Deactivate legacy Bronze MEMBER if present
  const legacyMember = await prisma.membershipTier.findUnique({ where: { code: 'MEMBER' } });
  if (legacyMember) {
    await prisma.membershipTier.update({
      where: { code: 'MEMBER' },
      data: { isActive: false },
    });
  }

  for (const tierData of DEFAULT_MEMBERSHIP_TIERS) {
    await prisma.membershipTier.upsert({
      where: { code: tierData.code },
      update: {
        nameAr: tierData.nameAr,
        nameEn: tierData.nameEn,
        descriptionAr: tierData.descriptionAr,
        descriptionEn: tierData.descriptionEn,
        level: tierData.level,
        priority: tierData.priority,
        isActive: tierData.isActive,
        icon: tierData.icon,
        badgeAssetUrl: tierData.badgeAssetUrl,
        qualificationRules: tierData.qualificationRules,
        benefitConfiguration: tierData.benefitConfiguration,
        validityConfiguration: tierData.validityConfiguration,
      },
      create: tierData,
    });
  }
  console.log('[Seed] Successfully seeded 4 Membership Tiers (BASIC, SILVER, GOLD, VIP_PLUS)');
}

if (require.main === module) {
  seedMembershipTiers()
    .catch((err) => {
      console.error('[Seed] Error seeding membership tiers:', err);
      process.exit(1);
    })
    .finally(async () => {
      await prisma.$disconnect();
    });
}
