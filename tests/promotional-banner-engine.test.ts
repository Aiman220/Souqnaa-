import { campaignService } from '../src/modules/promotions/services/campaign.service';
import { bannerService } from '../src/modules/promotions/services/banner.service';
import { targetingService } from '../src/modules/promotions/services/targeting.service';
import { scheduleService } from '../src/modules/promotions/services/schedule.service';
import { deepLinkService } from '../src/modules/promotions/services/deep-link.service';
import { bannerRecommendationService } from '../src/modules/promotions/services/banner-recommendation.service';
import { bannerAnalyticsService } from '../src/modules/promotions/services/banner-analytics.service';
import { prisma } from '../src/database/prisma';

async function runTests() {
  console.log('🧪 Starting Promotional Banner & Campaign Engine Unit & Integration Tests...\n');
  let passed = 0;
  let failed = 0;

  function assert(condition: boolean, testName: string) {
    if (condition) {
      console.log(`  ✓ PASS: ${testName}`);
      passed++;
    } else {
      console.error(`  ✗ FAIL: ${testName}`);
      failed++;
    }
  }

  try {
    // ── 1. Deep Link Security & Validation Tests ─────────────────────────────
    console.log('--- 1. Deep Link Security & Validation ---');
    const safeProductLink = deepLinkService.validateUrl('souqnaa://product/prod-123');
    assert(safeProductLink.isValid, 'Allow valid souqnaa://product deep link');

    const safeCategoryLink = deepLinkService.validateUrl('souqnaa://category/cat-456?title=Electronics');
    assert(safeCategoryLink.isValid, 'Allow valid souqnaa://category deep link with query');

    const jsInjection = deepLinkService.validateUrl('javascript:alert("hacked")');
    assert(!jsInjection.isValid, 'Block malicious javascript: URI');

    const adminInternalLink = deepLinkService.validateUrl('/api/v1/admin/users');
    assert(!adminInternalLink.isValid, 'Block unauthorized internal admin API URL');

    const canonicalVoucher = deepLinkService.buildCanonicalUri('VOUCHER', 'v-789');
    assert(canonicalVoucher === 'souqnaa://voucher/v-789', 'Build canonical voucher URI');

    const resolved = await deepLinkService.resolveDeepLink('souqnaa://flash-sale/flash-1');
    assert(resolved.type === 'FLASH_SALE' && resolved.targetId === 'flash-1', 'Resolve flash sale URI');

    // ── 2. Authoritative Scheduling Tests ────────────────────────────────────
    console.log('\n--- 2. Authoritative Scheduling ---');
    const pastStart = new Date(Date.now() - 100000);
    const futureEnd = new Date(Date.now() + 100000);
    const farFutureStart = new Date(Date.now() + 500000);
    const farFutureEnd = new Date(Date.now() + 800000);
    const pastEnd = new Date(Date.now() - 50000);

    const activeEval = scheduleService.evaluateSchedule(pastStart, futureEnd, 'ACTIVE');
    assert(activeEval.isActive && activeEval.computedStatus === 'ACTIVE', 'Active campaign evaluates to ACTIVE');

    const scheduledEval = scheduleService.evaluateSchedule(farFutureStart, farFutureEnd, 'SCHEDULED');
    assert(!scheduledEval.isActive && scheduledEval.computedStatus === 'SCHEDULED', 'Future campaign evaluates to SCHEDULED');

    const expiredEval = scheduleService.evaluateSchedule(pastStart, pastEnd, 'ACTIVE');
    assert(!expiredEval.isActive && expiredEval.computedStatus === 'ENDED', 'Expired campaign evaluates to ENDED');

    const pausedEval = scheduleService.evaluateSchedule(pastStart, futureEnd, 'PAUSED');
    assert(!pausedEval.isActive && pausedEval.computedStatus === 'PAUSED', 'Paused campaign remains inactive');

    const timeOfDayWithin = scheduleService.isWithinTimeOfDay(new Date(), '00:00', '23:59', 'Asia/Aden');
    assert(timeOfDayWithin, 'Current time is within 00:00 - 23:59');

    // ── 3. Targeting Engine Tests ────────────────────────────────────────────
    console.log('\n--- 3. Targeting Rules & Audience Segmentation ---');
    const guestContext = { isGuest: true, orderCount: 0, platform: 'MOBILE', language: 'ar' };
    const registeredContext = {
      isGuest: false,
      userId: 'u-1',
      orderCount: 1,
      platform: 'DESKTOP',
      language: 'en',
      country: 'YE',
      city: "Sana'a",
      cartValue: 15000,
    };

    const guestSegments = targetingService.resolveDefaultSegments(guestContext);
    assert(guestSegments.includes('GUESTS') && guestSegments.includes('ALL_USERS'), 'Resolve guest segments');

    const registeredSegments = targetingService.resolveDefaultSegments(registeredContext);
    assert(
      registeredSegments.includes('REGISTERED_USERS') && registeredSegments.includes('RETURNING_CUSTOMERS'),
      'Resolve registered customer segments'
    );

    const ruleLangAr: any = {
      id: 'r-1',
      ruleGroup: 'ALL',
      ruleType: 'LANGUAGE',
      operator: 'EQUALS',
      value: 'ar',
    };
    assert(targetingService.evaluateSingleRule(ruleLangAr, guestContext), 'Language ar matches guest context');
    assert(!targetingService.evaluateSingleRule(ruleLangAr, registeredContext), 'Language ar rejects English context');

    const rulePlatformDesktop: any = {
      id: 'r-2',
      ruleGroup: 'ALL',
      ruleType: 'PLATFORM',
      operator: 'EQUALS',
      value: 'DESKTOP',
    };
    assert(targetingService.evaluateSingleRule(rulePlatformDesktop, registeredContext), 'Platform DESKTOP matches registered context');

    const ruleCartVal: any = {
      id: 'r-3',
      ruleGroup: 'ALL',
      ruleType: 'CART_VALUE',
      operator: 'GREATER_THAN',
      value: '10000',
    };
    assert(targetingService.evaluateSingleRule(ruleCartVal, registeredContext), 'Cart value > 10000 matches 15000');

    // Test rule grouping (ALL / ANY)
    const combinedRules = [ruleLangAr, rulePlatformDesktop];
    assert(!targetingService.isEligible(combinedRules, guestContext), 'ALL rule group fails when one rule fails');

    // ── 4. Campaign & Banner DB Lifecycle Integration ────────────────────────
    console.log('\n--- 4. Campaign & Banner Lifecycle Integration ---');
    const campaign = await campaignService.createCampaign({
      name: 'Test Marketing Campaign 2026',
      startAt: new Date(Date.now() - 3600000), // 1 hour ago
      endAt: new Date(Date.now() + 86400000), // tomorrow
      campaignType: 'SEASONAL',
      priority: 10,
      targetingEnabled: false,
    });
    assert(campaign.id != null && campaign.status === 'ACTIVE', 'Create campaign with ACTIVE status');

    const banner = await bannerService.createBanner({
      campaignId: campaign.id,
      name: 'Hero Test Banner',
      title: 'خصومات الموسم الكبير',
      subtitle: 'وفر حتى 50%',
      mobileImageUrl: 'https://cdn.souqnaa.online/banners/test-mobile.webp',
      desktopImageUrl: 'https://cdn.souqnaa.online/banners/test-desktop.webp',
      placementKey: 'HOME_HERO',
      priority: 5,
      deepLinkUri: 'souqnaa://flash-sale/season-sale',
      ctaText: 'تسوق الآن',
      translations: [
        {
          locale: 'en',
          title: 'Mega Season Sale',
          subtitle: 'Save up to 50%',
          ctaText: 'Shop Now',
        },
      ],
    });
    assert(banner.id != null && banner.status === 'APPROVED', 'Create banner with responsive images and translation');

    // ── 5. Recommendation Service & Ranking ──────────────────────────────────
    console.log('\n--- 5. Banner Recommendation & Deterministic Ranking ---');
    const homeBanners = await bannerRecommendationService.getEligibleBannersForPlacement(
      'HOME_HERO',
      { isGuest: true, language: 'ar', platform: 'MOBILE' },
      { bypassCache: true }
    );
    assert(homeBanners.banners.length >= 1, 'Eligible banner returned for HOME_HERO');
    const matchedBanner = homeBanners.banners.find((b) => b.id === banner.id);
    assert(matchedBanner != null, 'Target test banner is found in recommendations');
    assert(matchedBanner?.title === 'خصومات الموسم الكبير', 'Arabic title resolved for ar locale');
    assert(matchedBanner?.imageUrl === 'https://cdn.souqnaa.online/banners/test-mobile.webp', 'Mobile image selected on mobile');

    // Test English locale resolution
    const enBanners = await bannerRecommendationService.getEligibleBannersForPlacement(
      'HOME_HERO',
      { isGuest: true, language: 'en', platform: 'DESKTOP' },
      { bypassCache: true }
    );
    const enMatched = enBanners.banners.find((b) => b.id === banner.id);
    assert(enMatched?.title === 'Mega Season Sale', 'English translation resolved for en locale');
    assert(enMatched?.imageUrl === 'https://cdn.souqnaa.online/banners/test-desktop.webp', 'Desktop image selected on desktop');

    // ── 6. Analytics & Attribution Tests ─────────────────────────────────────
    console.log('\n--- 6. Analytics, Impression Deduplication & Attribution ---');
    const sessionId = 'test-session-xyz';
    const firstImp = await bannerAnalyticsService.trackEvent({
      bannerId: banner.id,
      eventType: 'IMPRESSION',
      sessionId,
      platform: 'MOBILE',
      locale: 'ar',
    });
    assert(firstImp === true, 'First impression is recorded');

    // Second rapid impression with same session should be deduplicated
    const secondImp = await bannerAnalyticsService.trackEvent({
      bannerId: banner.id,
      eventType: 'IMPRESSION',
      sessionId,
      platform: 'MOBILE',
      locale: 'ar',
    });
    assert(secondImp === false, 'Duplicate impression within cooldown is deduplicated');

    // Click tracking
    await bannerAnalyticsService.trackEvent({
      bannerId: banner.id,
      eventType: 'CLICK',
      sessionId,
      platform: 'MOBILE',
    });

    // Conversion tracking
    await bannerAnalyticsService.trackConversion({
      bannerId: banner.id,
      orderId: 'ORD-TEST-999',
      sessionId,
      revenue: 4500,
      currency: 'YER',
    });

    const adminStats = await bannerAnalyticsService.getAdminAnalytics(campaign.id);
    assert(adminStats.totalImpressions >= 1, 'Aggregate impression count recorded');
    assert(adminStats.totalClicks >= 1, 'Aggregate click count recorded');
    assert(adminStats.totalConversions >= 1, 'Aggregate conversion count recorded');
    assert(adminStats.totalRevenue >= 4500, 'Attributed revenue matches order value');

    // ── 7. Seller Isolation Security Tests ───────────────────────────────────
    console.log('\n--- 7. Seller Isolation Security ---');
    try {
      await bannerService.deleteBanner(banner.id, { sellerId: 'seller-unauthorized' });
      assert(false, 'Should block unauthorized seller deletion');
    } catch (err: any) {
      assert(err.statusCode === 403, 'Unauthorized seller deletion correctly blocked with 403 Forbidden');
    }

    // Clean up test data
    await prisma.promotionalBanner.delete({ where: { id: banner.id } });
    await prisma.campaign.delete({ where: { id: campaign.id } });
    console.log('\n🧹 Test campaign and banner cleaned up.');

  } catch (error) {
    console.error('Fatal test error:', error);
    failed++;
  }

  console.log(`\n========================================`);
  console.log(`Tests finished: ${passed} PASSED, ${failed} FAILED`);
  console.log(`========================================`);

  if (failed > 0) {
    process.exit(1);
  } else {
    process.exit(0);
  }
}

runTests();
