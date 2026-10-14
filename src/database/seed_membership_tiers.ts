import { prisma } from './prisma';

export const DEFAULT_MEMBERSHIP_TIERS = [
  {
    code: 'REGULAR',
    nameAr: 'العميل العادي',
    nameEn: 'Regular Customer',
    descriptionAr: 'الفئة الترحيبية الأساسية لجميع عملاء سوقناا الجدد',
    descriptionEn: 'Standard starting tier for all registered Souqna customers',
    level: 0,
    priority: 0,
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
    code: 'MEMBER',
    nameAr: 'عضو برونزي',
    nameEn: 'Member',
    descriptionAr: 'عضوية نشطة بعد إتمام أول 3 طلبات أو تسوق بقيمة 25,000 ريال',
    descriptionEn: 'Active member tier unlocked after 3 completed orders or 25,000 YER spend',
    level: 1,
    priority: 10,
    isActive: true,
    icon: 'award',
    badgeAssetUrl: '/assets/badges/badge_member.png',
    qualificationRules: JSON.stringify({
      logic: 'ANY',
      rules: [
        {
          metric: 'COMPLETED_ORDERS',
          operator: 'GTE',
          value: 3,
        },
        {
          metric: 'PERIOD_SPEND',
          operator: 'GTE',
          value: 25000,
        },
      ],
    }),
    benefitConfiguration: JSON.stringify({
      perks: [
        '5% bonus Souqna Coins on delivered orders',
        'Member-only vouchers monthly',
        'Faster dispute and ticket processing',
      ],
      perksAr: [
        'مضاعف عملات سوقناا 1.05x عند تسليم الطلبات',
        'كوبونات وعروض حصرية شهرياً',
        'أولوية معالجة تذاكر الدعم والنزاعات',
      ],
      coinsMultiplier: 1.05,
      freeShipping: false,
      prioritySupport: false,
      exclusiveCampaignAccess: false,
    }),
    validityConfiguration: JSON.stringify({
      periodType: 'ROLLING_DAYS',
      days: 365,
      gracePeriodDays: 30,
      downgradePolicy: 'DOWNGRADE',
    }),
  },
  {
    code: 'PREMIUM',
    nameAr: 'عضو فضي',
    nameEn: 'Premium Member',
    descriptionAr: 'عضوية متقدمة للمتسوقين المنتظمين بـ 7 طلبات أو 60,000 ريال سنوي',
    descriptionEn: 'Advanced tier for regular shoppers with 7 orders or 60,000 YER spend',
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
        'Exclusive monthly Premium voucher bundle',
      ],
      perksAr: [
        'مضاعف عملات سوقناا 1.1x على جميع المشتريات',
        'خصم رسوم الشحن عند الشراء بأكثر من 15,000 ريال',
        'دخول مبكر لعروض التخفيضات الكبرى بساعة',
        'حزمة كوبونات شهرية حصرية للأعضاء المميزين',
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
    code: 'VIP',
    nameAr: 'عضو VIP ذهبي',
    nameEn: 'VIP',
    descriptionAr: 'فئة كبار العملاء مع مزايا شحن مجاني ودعم مميز وأولوية قصوى',
    descriptionEn: 'VIP tier with free shipping eligibility, priority concierge support, and high multipliers',
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
    nameEn: 'VIP+',
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
  console.log('[Seed] Successfully seeded 5 Membership Tiers (REGULAR, MEMBER, PREMIUM, VIP, VIP_PLUS)');
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
