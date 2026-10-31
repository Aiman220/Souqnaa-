import { prisma } from '../src/database/prisma';
import { MembershipEligibilityService } from '../src/modules/membership/membership-eligibility.service';
import { MembershipMetricsService } from '../src/modules/membership/membership-metrics.service';
import { MembershipCacheService } from '../src/modules/membership/membership-cache.service';
import { seedMembershipTiers } from '../src/database/seed_membership_tiers';
import { MembershipAuditChangeType } from '@prisma/client';

export async function runDatabaseRepair() {
  console.log('====================================================');
  console.log('🔧 SOUQNAA MEMBERSHIP & NOTIFICATION DATABASE REPAIR');
  console.log('====================================================\n');

  // STEP 1: Normalize Tiers in Database
  console.log('--- Step 1: Normalizing Database Membership Tiers ---');
  await seedMembershipTiers();

  const activeTiers = await MembershipEligibilityService.getActiveTiersDescending();
  console.log(`Active tiers confirmed (${activeTiers.length}):`);
  for (const t of activeTiers) {
    console.log(`  Level ${t.level}: ${t.code} (${t.nameEn} / ${t.nameAr})`);
  }

  // STEP 2: Reconcile and Repair Customer Memberships
  console.log('\n--- Step 2: Auditing and Repairing Customer Memberships ---');
  const allMemberships = await prisma.customerMembership.findMany({
    include: {
      tier: true,
      overrides: { where: { isActive: true }, include: { overrideTier: true } },
      user: {
        select: {
          id: true,
          email: true,
          firstName: true,
          lastName: true,
          role: true,
        },
      },
    },
  });

  console.log(`Scanning ${allMemberships.length} customer membership records...`);
  let repairedCount = 0;
  let cleanCount = 0;

  for (const membership of allMemberships) {
    const userId = membership.userId;
    const oldTier = membership.tier;

    // Check if active manual override exists - preserve if present
    const activeOverride = membership.overrides?.[0];
    if (activeOverride && (!activeOverride.endAt || new Date() < activeOverride.endAt)) {
      console.log(`  ℹ️ User ${membership.user?.email || userId} has active admin override to ${activeOverride.overrideTier.code}. Preserved.`);
      cleanCount++;
      continue;
    }

    // Compute fresh authoritative metrics from real verified orders & refunds
    const freshMetrics = await MembershipMetricsService.computeAuthoritativeMetrics(userId);

    // Evaluate authoritative tier based on verified metrics
    const evalResult = await MembershipEligibilityService.evaluateCustomerTier(userId, {
      forceAuthoritativeRecalculation: true,
      actorId: 'SYSTEM_REPAIR_MIGRATION',
      correlationId: `db_repair_${Date.now()}`,
    });

    const targetTierId = evalResult.targetTierId;
    if (oldTier.id !== targetTierId) {
      console.log(`  🔨 REPAIRED: User ${membership.user?.email || userId}`);
      console.log(`     Old Tier: ${oldTier.code} (L${oldTier.level}) -> New Tier: ${evalResult.targetTierCode}`);
      console.log(`     Verified Orders: ${freshMetrics.completedOrders}, Verified Annual Spend: ${freshMetrics.periodSpend} YER`);

      // Log repair action
      await prisma.membershipAuditLog.create({
        data: {
          userId,
          actorId: 'SYSTEM_REPAIR_MIGRATION',
          actorRole: 'SYSTEM',
          changeType: evalResult.isDowngraded ? MembershipAuditChangeType.DOWNGRADE : MembershipAuditChangeType.RULE_EVALUATION,
          previousTierId: oldTier.id,
          newTierId: targetTierId,
          reason: `Automated repair: Reconciled incorrect tier with verified historical orders (${freshMetrics.completedOrders} orders, ${freshMetrics.periodSpend} YER)`,
          metricsSnapshot: JSON.stringify(freshMetrics),
          correlationId: 'reconciliation_phase6',
        },
      });

      repairedCount++;
    } else {
      cleanCount++;
    }
  }

  console.log(`\nMembership reconciliation complete:`);
  console.log(`  ✅ Clean / Verified: ${cleanCount}`);
  console.log(`  🔨 Repaired Inconsistent: ${repairedCount}`);

  // STEP 3: Remove Duplicate VIP Notifications
  console.log('\n--- Step 3: Cleaning Duplicate VIP Promotion Notifications ---');

  // Find users with multiple notifications for VIP upgrade
  const duplicateGroups: any[] = await prisma.$queryRaw`
    SELECT "userId", "titleEn", COUNT(*) as count
    FROM "public"."Notification"
    WHERE ("titleEn" LIKE '%VIP%' OR "titleEn" LIKE '%member%')
    GROUP BY "userId", "titleEn"
    HAVING COUNT(*) > 1
  `;

  let totalDuplicatesRemoved = 0;

  for (const group of duplicateGroups) {
    const userId = group.userId;
    const titleEn = group.titleEn;

    // Fetch all records for this user and title ordered by createdAt ASC
    const notifs = await prisma.notification.findMany({
      where: {
        userId,
        titleEn,
      },
      orderBy: { createdAt: 'asc' },
      select: { id: true, createdAt: true, idempotencyKey: true },
    });

    if (notifs.length > 1) {
      // Keep first (earliest) notification, delete subsequent duplicates
      const keepId = notifs[0].id;
      const removeIds = notifs.slice(1).map((n) => n.id);

      // Delete delivery records for duplicate notifications first
      await prisma.notificationDelivery.deleteMany({
        where: { notificationId: { in: removeIds } },
      });

      // Delete duplicate notifications
      const delResult = await prisma.notification.deleteMany({
        where: { id: { in: removeIds } },
      });

      console.log(`  🧹 User ${userId}: kept canonical notification ${keepId}, removed ${delResult.count} duplicate records.`);
      totalDuplicatesRemoved += delResult.count;
    }
  }

  console.log(`Duplicate notifications cleanup complete. Total duplicates removed: ${totalDuplicatesRemoved}`);

  // STEP 4: Invalidate Redis Caches
  console.log('\n--- Step 4: Invalidating All Membership Caches ---');
  await MembershipCacheService.invalidateTiers();
  for (const m of allMemberships) {
    await MembershipCacheService.invalidateCustomer(m.userId);
  }
  console.log('All Redis membership caches invalidated.');

  console.log('\n====================================================');
  console.log('✅ DATABASE REPAIR MIGRATION COMPLETED SUCCESSFULLY');
  console.log('====================================================\n');
}

if (require.main === module) {
  runDatabaseRepair()
    .catch((err) => {
      console.error('[Database Repair] Fatal Error:', err);
      process.exit(1);
    })
    .finally(async () => {
      await prisma.$disconnect();
    });
}

