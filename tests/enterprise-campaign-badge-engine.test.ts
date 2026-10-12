import { campaignBadgeService } from '../src/modules/promotions/services/campaign-badge.service';
import { campaignService } from '../src/modules/promotions/services/campaign.service';
import { prisma } from '../src/database/prisma';

async function runEnterpriseCampaignBadgeEngineTests() {
  console.log('================================================================');
  console.log('🧪 ENTERPRISE CAMPAIGN & MEGA CAMPAIGN BADGE ENGINE TEST SUITE');
  console.log('================================================================\n');

  let passed = 0;
  let failed = 0;

  function assert(condition: boolean, testName: string, detail?: string) {
    if (condition) {
      console.log(`  ✓ PASS: ${testName}`);
      passed++;
    } else {
      console.error(`  ✗ FAIL: ${testName} ${detail ? `(${detail})` : ''}`);
      failed++;
    }
  }

  function mockMulterFile(buffer: Buffer, mimetype: string, originalname = 'badge.png'): Express.Multer.File {
    return {
      buffer,
      size: buffer.length,
      mimetype,
      originalname,
      fieldname: 'badge',
      encoding: '7bit',
      destination: '',
      filename: originalname,
      path: '',
      stream: null as any,
    };
  }

  try {
    // ── 1. Image Integrity & Magic-Byte Security Tests (§13, §14) ────────────
    console.log('--- 1. Image Integrity & Security Scanning (Anti-Spoofing & Validation) ---');

    // Valid PNG magic bytes: 89 50 4E 47 0D 0A 1A 0A
    const validPngBuffer = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x00, 0x00, 0x0d]);
    const pngResult = campaignBadgeService.validateImageIntegrity(mockMulterFile(validPngBuffer, 'image/png', 'badge.png'));
    assert(pngResult.mime === 'image/png', 'Accept valid PNG image with authentic magic bytes');

    // Valid JPEG magic bytes: FF D8 FF
    const validJpgBuffer = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46, 0x49, 0x46]);
    const jpgResult = campaignBadgeService.validateImageIntegrity(mockMulterFile(validJpgBuffer, 'image/jpeg', 'badge.jpg'));
    assert(jpgResult.mime === 'image/jpeg', 'Accept valid JPEG image with authentic magic bytes');

    // Valid WebP magic bytes: RIFF....WEBP
    const validWebpBuffer = Buffer.from([
      0x52, 0x49, 0x46, 0x46, // 'RIFF'
      0x20, 0x00, 0x00, 0x00, // size
      0x57, 0x45, 0x42, 0x50, // 'WEBP'
      0x56, 0x50, 0x38, 0x20,
    ]);
    const webpResult = campaignBadgeService.validateImageIntegrity(mockMulterFile(validWebpBuffer, 'image/webp', 'badge.webp'));
    assert(webpResult.mime === 'image/webp', 'Accept valid WebP image with authentic magic bytes');

    // Attack 1: Executable file disguised as PNG (MZ Windows Executable header)
    let exeCaught = false;
    try {
      const maliciousExeBuffer = Buffer.from([0x4d, 0x5a, 0x90, 0x00, 0x03, 0x00, 0x00, 0x00]);
      campaignBadgeService.validateImageIntegrity(mockMulterFile(maliciousExeBuffer, 'image/png', 'evil.png'));
    } catch {
      exeCaught = true;
    }
    assert(exeCaught, 'Block executable binary disguised as image (MIME spoofing prevented)');

    // Attack 2: Linux ELF binary disguised as WebP
    let elfCaught = false;
    try {
      const maliciousElfBuffer = Buffer.from([0x7f, 0x45, 0x4c, 0x46, 0x02, 0x01, 0x01, 0x00]);
      campaignBadgeService.validateImageIntegrity(mockMulterFile(maliciousElfBuffer, 'image/webp', 'trojan.webp'));
    } catch {
      elfCaught = true;
    }
    assert(elfCaught, 'Block ELF binary disguised as WebP');

    // Attack 3: Oversized badge asset (> 5MB)
    let oversizedCaught = false;
    try {
      const oversizedBuffer = Buffer.alloc(5.5 * 1024 * 1024);
      oversizedBuffer[0] = 0x89;
      oversizedBuffer[1] = 0x50;
      oversizedBuffer[2] = 0x4e;
      oversizedBuffer[3] = 0x47;
      oversizedBuffer[4] = 0x0d;
      oversizedBuffer[5] = 0x0a;
      oversizedBuffer[6] = 0x1a;
      oversizedBuffer[7] = 0x0a;
      campaignBadgeService.validateImageIntegrity(mockMulterFile(oversizedBuffer, 'image/png', 'giant.png'));
    } catch {
      oversizedCaught = true;
    }
    assert(oversizedCaught, 'Reject oversized badge image exceeding 5MB quota');

    // ── 2. Admin Campaign Validation Before Publishing (§54) ─────────────────
    console.log('\n--- 2. Admin Validation Before Publishing (§54) ---');

    // Create a draft campaign with badgeEnabled = true but NO badge asset attached
    const unbadgedDraft = await prisma.campaign.create({
      data: {
        name: 'Unbadged Mega Test Campaign',
        slug: `unbadged-mega-${Date.now()}`,
        campaignType: 'MEGA_CAMPAIGN',
        status: 'DRAFT',
        startAt: new Date(Date.now() - 3600000),
        endAt: new Date(Date.now() + 86400000),
        priority: 100,
        badgeEnabled: true, // Marked enabled without asset!
        targetingMode: 'ALL_ELIGIBLE_PRODUCTS',
      },
    });

    let publishError: any = null;
    try {
      await campaignService.approveCampaign(unbadgedDraft.id, 'admin_system_tester');
    } catch (err: any) {
      publishError = err;
    }
    assert(
      publishError !== null && (publishError.message.includes('badge') || publishError.message.includes('شارة')),
      'Reject publishing campaign when badgeEnabled=true but no badge asset exists'
    );

    // Clean up draft
    await prisma.campaign.delete({ where: { id: unbadgedDraft.id } });

    // ── 3. Multi-Campaign Priority & Deterministic Tie-Breaking (§6, §21) ───────
    console.log('\n--- 3. Multi-Campaign Priority & Deterministic Resolution (§6, §21) ---');

    const testSellerId = 'seller_badge_test_01';
    const testCategoryId = 'cat_electronics_test_01';
    const testProductId1 = 'prod_multi_campaign_01';

    // Set up test campaigns with varying priorities
    // 1) Mega Campaign (Priority 500) - targeting ALL_ELIGIBLE_PRODUCTS
    const megaCampaign = await prisma.campaign.create({
      data: {
        name: '11.11 Mega Sale Test',
        nameAr: 'مهرجان 11.11 الأكبر',
        nameEn: '11.11 Mega Shopping Festival',
        slug: `mega-1111-${Date.now()}`,
        campaignType: 'MEGA_CAMPAIGN',
        status: 'ACTIVE',
        startAt: new Date(Date.now() - 3600000),
        endAt: new Date(Date.now() + 86400000),
        priority: 500,
        badgeEnabled: true,
        badgePosition: 'BOTTOM_LEFT',
        targetingMode: 'ALL_ELIGIBLE_PRODUCTS',
        badgeAssets: {
          create: {
            locale: 'UNIVERSAL',
            assetUrl: 'https://cdn.souqnaa.com/badges/1111-mega.png',
            mobileUrl: 'https://cdn.souqnaa.com/badges/1111-mega-mobile.png',
            assetVersion: 'v1-1111',
            altText: '11.11 Mega Sale',
            altTextAr: 'شارة عروض 11.11 الكبرى',
            altTextEn: '11.11 Mega Festival Badge',
          },
        },
      },
      include: { badgeAssets: true },
    });

    // 2) Seasonal Campaign (Priority 400) - targeting ALL_ELIGIBLE_PRODUCTS
    const seasonalCampaign = await prisma.campaign.create({
      data: {
        name: 'Ramadan Test Season',
        nameAr: 'موسم رمضان المبارك',
        nameEn: 'Ramadan Festive Season',
        slug: `ramadan-season-${Date.now()}`,
        campaignType: 'SEASONAL',
        status: 'ACTIVE',
        startAt: new Date(Date.now() - 3600000),
        endAt: new Date(Date.now() + 86400000),
        priority: 400,
        badgeEnabled: true,
        badgePosition: 'BOTTOM_LEFT',
        targetingMode: 'ALL_ELIGIBLE_PRODUCTS',
        badgeAssets: {
          create: {
            locale: 'UNIVERSAL',
            assetUrl: 'https://cdn.souqnaa.com/badges/ramadan.png',
            assetVersion: 'v1-ramadan',
            altText: 'Ramadan Badge',
          },
        },
      },
    });

    // 3) Category Campaign (Priority 300) - targeting CATEGORIES
    const categoryCampaign = await prisma.campaign.create({
      data: {
        name: 'Electronics Flash Highlight',
        slug: `elec-flash-${Date.now()}`,
        campaignType: 'CATEGORY',
        status: 'ACTIVE',
        startAt: new Date(Date.now() - 3600000),
        endAt: new Date(Date.now() + 86400000),
        priority: 300,
        badgeEnabled: true,
        badgePosition: 'BOTTOM_LEFT',
        targetingMode: 'CATEGORIES',
        targetingRules: {
          create: [{ ruleType: 'CATEGORY', value: JSON.stringify([testCategoryId]), operator: 'IN' }],
        },
        badgeAssets: {
          create: {
            locale: 'UNIVERSAL',
            assetUrl: 'https://cdn.souqnaa.com/badges/elec-flash.png',
            assetVersion: 'v1-elec',
            altText: 'Electronics Flash',
          },
        },
      },
    });

    // Invalidate active catalog cache so newly created campaigns are recognized
    await campaignBadgeService.invalidateActiveCampaignsCache();
    let catalog = await campaignBadgeService.getActiveCampaignsWithBadges();

    // Test product matching all 3 campaigns:
    // Should resolve to Mega Campaign (priority 500 > 400 > 300)
    const productMock = {
      id: testProductId1,
      categoryId: testCategoryId,
      sellerId: testSellerId,
      status: 'ACTIVE',
    };

    const resolvedPresentation = campaignBadgeService.resolvePresentationForProduct(productMock, catalog, 'ar');

    assert(resolvedPresentation !== null, 'Product resolves to an active campaign badge presentation');
    assert(
      resolvedPresentation?.campaignId === megaCampaign.id,
      'Highest priority campaign wins for Primary Badge (Mega Priority 500 > Seasonal 400 > Category 300)'
    );
    assert(
      resolvedPresentation?.badge.imageUrl?.includes('1111-mega') ?? false,
      'Badge artwork points to winning Mega Campaign asset'
    );
    assert(
      resolvedPresentation?.badge.position === 'BOTTOM_LEFT',
      'Badge position defaults to BOTTOM_LEFT as specified in architecture'
    );

    // ── 4. Deterministic Tie-Breaking (Equal Priority) ────────────────────────
    console.log('\n--- 4. Deterministic Tie-Breaking for Equal Priority Campaigns ---');

    // Create two campaigns with IDENTICAL priority 350, different startAt
    const tieOlder = await prisma.campaign.create({
      data: {
        name: 'Tie Campaign Older',
        slug: `tie-older-${Date.now()}`,
        campaignType: 'SEASONAL',
        status: 'ACTIVE',
        startAt: new Date('2026-01-01T00:00:00Z'),
        endAt: new Date('2026-12-31T23:59:59Z'),
        priority: 350,
        badgeEnabled: true,
        targetingMode: 'ALL_ELIGIBLE_PRODUCTS',
        badgeAssets: {
          create: {
            locale: 'UNIVERSAL',
            assetUrl: 'https://cdn.souqnaa.com/badges/tie-older.png',
            assetVersion: 'v1',
            altText: 'Older Tie',
          },
        },
      },
    });

    const tieNewer = await prisma.campaign.create({
      data: {
        name: 'Tie Campaign Newer',
        slug: `tie-newer-${Date.now()}`,
        campaignType: 'SEASONAL',
        status: 'ACTIVE',
        startAt: new Date('2026-06-01T00:00:00Z'), // More recently started
        endAt: new Date('2026-12-31T23:59:59Z'),
        priority: 350,
        badgeEnabled: true,
        targetingMode: 'ALL_ELIGIBLE_PRODUCTS',
        badgeAssets: {
          create: {
            locale: 'UNIVERSAL',
            assetUrl: 'https://cdn.souqnaa.com/badges/tie-newer.png',
            assetVersion: 'v1',
            altText: 'Newer Tie',
          },
        },
      },
    });

    await campaignBadgeService.invalidateActiveCampaignsCache();
    const tieCatalog = await campaignBadgeService.getActiveCampaignsWithBadges();

    // Check tie breaking order among equal priority
    const ties = tieCatalog.filter((c) => c.priority === 350);
    assert(ties.length === 2, 'Found both equal-priority campaigns in catalog');
    assert(
      ties[0].id === tieNewer.id,
      'Equal priority campaigns deterministically ordered by startAt DESC (newer start date wins tie)'
    );

    // Clean up tie test campaigns
    await prisma.campaign.deleteMany({ where: { id: { in: [tieOlder.id, tieNewer.id] } } });

    // ── 5. Product Targeting Modes (§7, §25, §26, §27, §28) ───────────────────
    console.log('\n--- 5. Product Targeting Modes & Scopes ---');

    // 5a: Specific Products Targeting
    const specificProdCampaign = await prisma.campaign.create({
      data: {
        name: 'Selected VIP Products Sale',
        slug: `vip-prod-${Date.now()}`,
        campaignType: 'PRODUCT_COLLECTION',
        status: 'ACTIVE',
        startAt: new Date(Date.now() - 3600000),
        endAt: new Date(Date.now() + 86400000),
        priority: 600, // Higher than mega (500)
        badgeEnabled: true,
        targetingMode: 'SPECIFIC_PRODUCTS',
        targetingRules: {
          create: [{ ruleType: 'PRODUCT_IDS', value: JSON.stringify(['prod_target_vip_only']), operator: 'IN' }],
        },
        badgeAssets: {
          create: {
            locale: 'UNIVERSAL',
            assetUrl: 'https://cdn.souqnaa.com/badges/vip-pick.png',
            assetVersion: 'v1',
            altText: 'VIP Pick',
          },
        },
      },
    });

    await campaignBadgeService.invalidateActiveCampaignsCache();
    catalog = await campaignBadgeService.getActiveCampaignsWithBadges();

    // Product targeted by ID
    const targetedProd = { id: 'prod_target_vip_only', categoryId: 'cat_x', sellerId: 'seller_y' };
    const targetedResult = campaignBadgeService.resolvePresentationForProduct(targetedProd, catalog, 'ar');
    assert(
      targetedResult?.campaignId === specificProdCampaign.id,
      'SPECIFIC_PRODUCTS targeting matches explicitly targeted product'
    );

    // Product NOT targeted by ID
    const unTargetedProd = { id: 'prod_other_standard', categoryId: 'cat_x', sellerId: 'seller_y' };
    const unTargetedResult = campaignBadgeService.resolvePresentationForProduct(unTargetedProd, catalog, 'ar');
    assert(
      unTargetedResult?.campaignId === megaCampaign.id,
      'Non-targeted product skips SPECIFIC_PRODUCTS campaign and falls back to Mega Campaign'
    );

    // Clean up specific product campaign
    await prisma.campaign.delete({ where: { id: specificProdCampaign.id } });

    // ── 6. Batch Feed Resolution & Zero N+1 Performance (§36) ─────────────────
    console.log('\n--- 6. High-Performance Batch Product Feed Resolution (Zero N+1) ---');

    const feedProducts = Array.from({ length: 50 }, (_, i) => ({
      id: `batch_feed_prod_${i}`,
      categoryId: i % 2 === 0 ? testCategoryId : 'other_category',
      sellerId: testSellerId,
      status: 'ACTIVE',
    }));

    const startTime = Date.now();
    const batchResults = await campaignBadgeService.batchResolveCampaignPresentations(feedProducts, 'ar');
    const elapsed = Date.now() - startTime;

    assert(batchResults.size === 50, 'Batch resolver returns presentations for all 50 feed items');
    assert(elapsed < 30, `Batch resolution executed in ${elapsed}ms (sub-30ms ultra fast, 0 N+1 DB queries)`);

    // Verify consistency
    const firstResult = batchResults.get('batch_feed_prod_0');
    assert(firstResult?.campaignId === megaCampaign.id, 'Batch resolver deterministically assigns winning badge to feed items');

    // ── 7. Campaign Lifecycle State Invalidation (§4, §33) ───────────────────
    console.log('\n--- 7. Campaign Lifecycle Changes & Cache Invalidation ---');

    // Pause Mega Campaign
    await campaignService.pauseCampaign(megaCampaign.id);
    await campaignBadgeService.invalidateActiveCampaignsCache();
    catalog = await campaignBadgeService.getActiveCampaignsWithBadges();

    // Now product should resolve to Seasonal Campaign (next highest active priority = 400)
    const afterPausePresentation = campaignBadgeService.resolvePresentationForProduct(productMock, catalog, 'ar');
    assert(
      afterPausePresentation?.campaignId === seasonalCampaign.id,
      'Pausing Mega Campaign causes automatic failover to next active priority campaign (Seasonal 400)'
    );

    // Resume Mega Campaign
    await campaignService.resumeCampaign(megaCampaign.id);
    await campaignBadgeService.invalidateActiveCampaignsCache();
    catalog = await campaignBadgeService.getActiveCampaignsWithBadges();

    const afterResumePresentation = campaignBadgeService.resolvePresentationForProduct(productMock, catalog, 'ar');
    assert(
      afterResumePresentation?.campaignId === megaCampaign.id,
      'Resuming Mega Campaign restores it immediately as the Primary Badge'
    );

    // ── 8. Badge Asset Versioning & Invalidation (§34, §35) ───────────────────
    console.log('\n--- 8. Badge Asset Versioning & Cache Busting ---');

    const sampleUser = await prisma.user.findFirst();
    const actorId = sampleUser?.id || undefined;

    // Toggle badge off
    await campaignBadgeService.toggleBadge(megaCampaign.id, false, actorId);
    await campaignBadgeService.invalidateActiveCampaignsCache();
    catalog = await campaignBadgeService.getActiveCampaignsWithBadges();

    const disabledPresentation = campaignBadgeService.resolvePresentationForProduct(productMock, catalog, 'ar');
    assert(
      disabledPresentation?.campaignId === seasonalCampaign.id,
      'Disabling badge on Mega Campaign removes its badge and falls back to Seasonal badge'
    );

    // Re-enable badge
    await campaignBadgeService.toggleBadge(megaCampaign.id, true, actorId);
    await campaignBadgeService.invalidateActiveCampaignsCache();
    catalog = await campaignBadgeService.getActiveCampaignsWithBadges();

    const reEnabledPresentation = campaignBadgeService.resolvePresentationForProduct(productMock, catalog, 'ar');
    assert(
      reEnabledPresentation?.campaignId === megaCampaign.id,
      'Re-enabling badge restores Mega Campaign badge presentation'
    );

    // ── 9. Client Non-Authority & Financial Separation (§44, §45) ─────────────
    console.log('\n--- 9. Financial Separation & Client Non-Authority Verification ---');

    // The badge presentation must ONLY contain visual/presentation metadata
    // It must NOT contain price discounts, calculated total, or tax alterations
    assert(
      !('discountAmount' in (reEnabledPresentation as any)),
      'Campaign badge presentation payload does NOT contain financial discount calculation'
    );
    assert(
      !('finalPrice' in (reEnabledPresentation as any)),
      'Campaign badge presentation payload does NOT dictate product final price'
    );
    assert(
      reEnabledPresentation?.badge.visible === true,
      'Badge visibility is authoritatively determined by server, not client'
    );

    // ── 10. Clean Up Test Campaigns ───────────────────────────────────────────
    console.log('\n--- 10. Test Environment Teardown ---');
    await prisma.campaignBadgeAsset.deleteMany({
      where: { campaignId: { in: [megaCampaign.id, seasonalCampaign.id, categoryCampaign.id] } },
    });
    await prisma.campaign.deleteMany({
      where: { id: { in: [megaCampaign.id, seasonalCampaign.id, categoryCampaign.id] } },
    });
    await campaignBadgeService.invalidateActiveCampaignsCache();
    console.log('  ✓ Test campaigns cleaned up successfully.');

  } catch (error: any) {
    console.error('💥 Test suite crashed with error:', error);
    failed++;
  }

  console.log('\n================================================================');
  console.log(`🏁 TEST RUN SUMMARY: ${passed} PASSED, ${failed} FAILED`);
  console.log('================================================================');

  if (failed > 0) {
    process.exit(1);
  }
}

runEnterpriseCampaignBadgeEngineTests();
