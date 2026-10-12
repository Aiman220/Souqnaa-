import { prisma } from '../../database/prisma';
import { redis } from '../../database/redis';
import { AppError } from '../../middleware/error.middleware';
import { SocketService } from '../../services/websocket/socket.service';
import { notificationDispatcher } from '../notifications/services/notification-dispatcher';
import { NotificationEventFactory } from '../notifications/events/domain-events';
import { SellerPerformanceConfigService } from './seller-performance.config';
import { SellerPerformanceCalculator } from './seller-performance-calculator.service';
import {
  AdminPerformanceFilter,
  CalculatedPerformanceResult,
  PerformanceGrade,
  PerformanceDataStatus,
  PublicSellerPerformance,
  RawPerformanceMetrics,
} from './seller-performance.types';

export class SellerPerformanceService {
  private static readonly CACHE_TTL_SECONDS = 300; // 5 minutes cache in Redis

  /**
   * Main calculation engine: aggregates authoritative DB records and updates snapshots.
   */
  public static async calculateSellerPerformance(
    sellerId: string,
    options: { triggerReason?: string; forceRecalculate?: boolean } = {}
  ): Promise<any> {
    const { triggerReason = 'SCHEDULED' } = options;

    const seller = await prisma.seller.findUnique({
      where: { id: sellerId },
      include: {
        user: { select: { id: true, firstName: true, lastName: true, email: true } },
        stores: { select: { id: true, name: true, slug: true, rating: true, reviewCount: true } },
        performance: true,
      },
    });

    if (!seller) {
      throw new AppError('المتجر / البائع غير موجود', 404);
    }

    const config = await SellerPerformanceConfigService.getConfig();
    const windowStart = new Date(Date.now() - config.windowDays * 24 * 60 * 60 * 1000);

    // ──────────────────────────────────────────────────────────────────────────
    // 1. REVIEWS & CUSTOMER SATISFACTION (Verified Purchases only)
    // ──────────────────────────────────────────────────────────────────────────
    const reviewsInWindow = await prisma.productReview.findMany({
      where: {
        sellerId,
        status: 'PUBLISHED',
        verifiedPurchase: true,
        deletedAt: null,
        createdAt: { gte: windowStart },
      },
      select: { rating: true, verifiedPurchase: true },
    });

    let eligibleReviewsCount = reviewsInWindow.length;
    let ratingSum = reviewsInWindow.reduce((acc, r) => acc + r.rating, 0);

    // If reviews in window < minReviews, supplement with historical baseline to protect seller
    if (eligibleReviewsCount < config.minReviews) {
      const allTimeReviews = await prisma.productReview.findMany({
        where: {
          sellerId,
          status: 'PUBLISHED',
          verifiedPurchase: true,
          deletedAt: null,
        },
        select: { rating: true },
        take: 50,
      });
      if (allTimeReviews.length > 0) {
        ratingSum = allTimeReviews.reduce((acc, r) => acc + r.rating, 0);
        eligibleReviewsCount = allTimeReviews.length;
      }
    }

    const ratingAverage = eligibleReviewsCount > 0 ? ratingSum / eligibleReviewsCount : 5.0;

    // ──────────────────────────────────────────────────────────────────────────
    // 2. DISPUTES (Confirmed Seller-Fault Disputes)
    // ──────────────────────────────────────────────────────────────────────────
    const confirmedDisputes = await prisma.dispute.count({
      where: {
        sellerId,
        status: 'RESOLVED',
        decision: { in: ['FULL_REFUND', 'PARTIAL_REFUND'] },
        createdAt: { gte: windowStart },
      },
    });

    // ──────────────────────────────────────────────────────────────────────────
    // 3. ORDERS (Fulfillment, Completion, Attribution)
    // ──────────────────────────────────────────────────────────────────────────
    const sellerOrders = await prisma.sellerOrder.findMany({
      where: {
        sellerId,
        createdAt: { gte: windowStart },
      },
      select: {
        id: true,
        status: true,
        createdAt: true,
        deliveredAt: true,
        statusHistory: {
          select: {
            toStatus: true,
            createdAt: true,
            changedByRole: true,
          },
          orderBy: { createdAt: 'asc' },
        },
      },
    });

    let deliveredOrdersCount = 0;
    let sellerCancelledOrdersCount = 0;
    let customerCancelledOrdersCount = 0;
    let onTimeOrdersCount = 0;

    const slaMs = config.fulfillmentSlaHours * 60 * 60 * 1000;

    for (const so of sellerOrders) {
      const statusStr = String(so.status);

      if (statusStr === 'DELIVERED') {
        deliveredOrdersCount++;

        // Check if fulfillment was on time (server timestamps)
        // Find timestamp when order reached READY_TO_SHIP, SHIPPED, or DELIVERED
        let fulfilledAt = so.deliveredAt ?? so.createdAt;
        for (const h of so.statusHistory) {
          if (['READY_TO_SHIP', 'SHIPPED', 'DELIVERED'].includes(h.toStatus)) {
            fulfilledAt = h.createdAt;
            break;
          }
        }

        const fulfillmentDuration = fulfilledAt.getTime() - so.createdAt.getTime();
        if (fulfillmentDuration <= slaMs) {
          onTimeOrdersCount++;
        }
      } else if (statusStr === 'CANCELLED_BY_SELLER' || statusStr === 'REJECTED_BY_SELLER') {
        sellerCancelledOrdersCount++;
      } else if (statusStr === 'CANCELLED_BY_CUSTOMER') {
        // Excluded from seller fault
        customerCancelledOrdersCount++;
      } else if (statusStr === 'CANCELLED_BY_ADMIN') {
        // Inspect changedByRole in history
        const lastHist = so.statusHistory[so.statusHistory.length - 1];
        if (lastHist?.changedByRole === 'SELLER') {
          sellerCancelledOrdersCount++;
        }
      }
    }

    // ──────────────────────────────────────────────────────────────────────────
    // 4. CHAT & MESSAGING (Median Response Time & Response Rate)
    // ──────────────────────────────────────────────────────────────────────────
    const sellerUserId = seller.userId;

    // Find conversations involving this seller
    const memberConversations = await prisma.conversationMember.findMany({
      where: { userId: sellerUserId },
      select: { conversationId: true },
    });
    const convIds = memberConversations.map((m) => m.conversationId);

    const conversations = await prisma.conversation.findMany({
      where: {
        id: { in: convIds },
        type: 'DIRECT_CUSTOMER_SELLER',
        createdAt: { gte: windowStart },
      },
      select: {
        id: true,
        createdAt: true,
        messages: {
          where: {
            deletedAt: null,
            isInternal: false,
            type: { not: 'system' },
          },
          select: {
            senderId: true,
            createdAt: true,
          },
          orderBy: { createdAt: 'asc' },
        },
      },
      take: 200,
    });

    let totalConversationsCount = 0;
    let answeredConversationsCount = 0;
    const responseTimesMinutes: number[] = [];

    for (const conv of conversations) {
      // Find first customer message
      const firstCustomerMsg = conv.messages.find((m) => m.senderId !== sellerUserId);
      if (!firstCustomerMsg) continue; // Only seller-initiated or empty conversation

      totalConversationsCount++;

      // Find first seller response after customer message
      const firstSellerReply = conv.messages.find(
        (m) => m.senderId === sellerUserId && m.createdAt > firstCustomerMsg.createdAt
      );

      if (firstSellerReply) {
        answeredConversationsCount++;
        const diffMinutes = Math.max(
          1,
          (firstSellerReply.createdAt.getTime() - firstCustomerMsg.createdAt.getTime()) / (60 * 1000)
        );
        responseTimesMinutes.push(diffMinutes);
      }
    }

    // Calculate median response time
    let medianResponseMinutes = 15; // default reasonable fallback
    let averageResponseMinutes = 15;

    if (responseTimesMinutes.length > 0) {
      responseTimesMinutes.sort((a, b) => a - b);
      const mid = Math.floor(responseTimesMinutes.length / 2);
      medianResponseMinutes =
        responseTimesMinutes.length % 2 !== 0
          ? responseTimesMinutes[mid]
          : (responseTimesMinutes[mid - 1] + responseTimesMinutes[mid]) / 2;

      const sumMinutes = responseTimesMinutes.reduce((a, b) => a + b, 0);
      averageResponseMinutes = sumMinutes / responseTimesMinutes.length;
    }

    // ──────────────────────────────────────────────────────────────────────────
    // 5. COMPOSE RAW METRICS & RUN PURE ENGINE
    // ──────────────────────────────────────────────────────────────────────────
    const sellerIssuesCount = sellerCancelledOrdersCount + confirmedDisputes;
    const eligibleOrdersCount = deliveredOrdersCount + sellerCancelledOrdersCount;

    const rawMetrics: RawPerformanceMetrics = {
      eligibleOrdersCount,
      deliveredOrdersCount,
      sellerCancelledOrdersCount,
      customerCancelledOrdersCount,
      onTimeOrdersCount,
      eligibleReviewsCount,
      ratingAverage,
      totalConversationsCount,
      answeredConversationsCount,
      medianResponseMinutes,
      averageResponseMinutes,
      confirmedDisputesCount: confirmedDisputes,
      sellerIssuesCount,
    };

    const calculated: CalculatedPerformanceResult = SellerPerformanceCalculator.calculate(rawMetrics, config);

    // ──────────────────────────────────────────────────────────────────────────
    // 6. PERSIST TO DATABASE (Live Record & Historical Snapshot)
    // ──────────────────────────────────────────────────────────────────────────
    const previousPerformance = seller.performance;

    const [updatedPerformance, snapshot] = await prisma.$transaction(async (tx) => {
      const perf = await tx.sellerPerformance.upsert({
        where: { sellerId },
        update: {
          score: calculated.finalScore,
          grade: calculated.grade,
          dataStatus: calculated.dataStatus,
          customerSatisfactionScore: calculated.components.customerSatisfactionScore,
          responseTimeScore: calculated.components.responseTimeScore,
          orderCompletionScore: calculated.components.orderCompletionScore,
          onTimeFulfillmentScore: calculated.components.onTimeFulfillmentScore,
          issueRateScore: calculated.components.issueRateScore,
          ratingAverage: calculated.rates.ratingAverage,
          responseRate: calculated.rates.responseRate,
          medianResponseMinutes: calculated.rates.medianResponseMinutes,
          orderCompletionRate: calculated.rates.orderCompletionRate,
          onTimeFulfillmentRate: calculated.rates.onTimeFulfillmentRate,
          sellerCancellationRate: calculated.rates.sellerCancellationRate,
          issueRate: calculated.rates.issueRate,
          eligibleOrderCount: calculated.counts.eligibleOrderCount,
          eligibleReviewCount: calculated.counts.eligibleReviewCount,
          totalConversationsCount: calculated.counts.totalConversationsCount,
          answeredConversationsCount: calculated.counts.answeredConversationsCount,
          calculationWindowDays: calculated.calculationWindowDays,
          calculationWindow: calculated.calculationWindow,
          algorithmVersion: calculated.algorithmVersion,
          configVersion: calculated.configVersion,
          calculatedAt: new Date(),
        },
        create: {
          sellerId,
          score: calculated.finalScore,
          grade: calculated.grade,
          dataStatus: calculated.dataStatus,
          customerSatisfactionScore: calculated.components.customerSatisfactionScore,
          responseTimeScore: calculated.components.responseTimeScore,
          orderCompletionScore: calculated.components.orderCompletionScore,
          onTimeFulfillmentScore: calculated.components.onTimeFulfillmentScore,
          issueRateScore: calculated.components.issueRateScore,
          ratingAverage: calculated.rates.ratingAverage,
          responseRate: calculated.rates.responseRate,
          medianResponseMinutes: calculated.rates.medianResponseMinutes,
          orderCompletionRate: calculated.rates.orderCompletionRate,
          onTimeFulfillmentRate: calculated.rates.onTimeFulfillmentRate,
          sellerCancellationRate: calculated.rates.sellerCancellationRate,
          issueRate: calculated.rates.issueRate,
          eligibleOrderCount: calculated.counts.eligibleOrderCount,
          eligibleReviewCount: calculated.counts.eligibleReviewCount,
          totalConversationsCount: calculated.counts.totalConversationsCount,
          answeredConversationsCount: calculated.counts.answeredConversationsCount,
          calculationWindowDays: calculated.calculationWindowDays,
          calculationWindow: calculated.calculationWindow,
          algorithmVersion: calculated.algorithmVersion,
          configVersion: calculated.configVersion,
        },
      });

      const snap = await tx.sellerPerformanceSnapshot.create({
        data: {
          sellerId,
          sellerPerformanceId: perf.id,
          score: calculated.finalScore,
          grade: calculated.grade,
          dataStatus: calculated.dataStatus,
          customerSatisfactionScore: calculated.components.customerSatisfactionScore,
          responseTimeScore: calculated.components.responseTimeScore,
          orderCompletionScore: calculated.components.orderCompletionScore,
          onTimeFulfillmentScore: calculated.components.onTimeFulfillmentScore,
          issueRateScore: calculated.components.issueRateScore,
          ratingAverage: calculated.rates.ratingAverage,
          responseRate: calculated.rates.responseRate,
          medianResponseMinutes: calculated.rates.medianResponseMinutes,
          orderCompletionRate: calculated.rates.orderCompletionRate,
          onTimeFulfillmentRate: calculated.rates.onTimeFulfillmentRate,
          sellerCancellationRate: calculated.rates.sellerCancellationRate,
          issueRate: calculated.rates.issueRate,
          eligibleOrderCount: calculated.counts.eligibleOrderCount,
          eligibleReviewCount: calculated.counts.eligibleReviewCount,
          calculationWindow: calculated.calculationWindow,
          algorithmVersion: calculated.algorithmVersion,
          configVersion: calculated.configVersion,
          triggerReason,
          metadata: JSON.stringify({
            recommendations: calculated.recommendations,
            totalOrdersInWindow: sellerOrders.length,
            customerCancelledOrdersCount,
          }),
        },
      });

      return [perf, snap];
    });

    // Invalidate Redis caches
    await Promise.all([
      redis.del(`seller_perf:${sellerId}`),
      redis.del(`seller_perf_public:${sellerId}`),
      redis.del(`seller_dashboard_metrics_${sellerId}`),
    ]);

    // Realtime notification if grade changed meaningfully
    if (previousPerformance && previousPerformance.grade !== calculated.grade && calculated.grade !== 'INSUFFICIENT_DATA') {
      try {
        SocketService.get()?.emitToUser(seller.userId, 'seller:performance_grade_changed', {
          sellerId,
          previousGrade: previousPerformance.grade,
          newGrade: calculated.grade,
          score: calculated.finalScore,
        });
      } catch (_) {}
    }

    return {
      ...updatedPerformance,
      recommendations: calculated.recommendations,
      snapshotId: snapshot.id,
    };
  }

  /**
   * Helper to resolve a sellerId from either a sellerId, storeId, or store slug.
   */
  public static async resolveSellerId(identifier: string): Promise<string> {
    if (!identifier) return identifier;
    const seller = await prisma.seller.findUnique({
      where: { id: identifier },
      select: { id: true },
    });
    if (seller) return seller.id;

    const store = await prisma.store.findFirst({
      where: { OR: [{ id: identifier }, { slug: identifier }, { sellerId: identifier }] },
      select: { sellerId: true },
    });
    if (store && store.sellerId) return store.sellerId;

    return identifier;
  }

  /**
   * Fast read for Seller App (with in-memory/Redis cache).
   */
  public static async getSellerPerformance(rawId: string): Promise<any> {
    const sellerId = await this.resolveSellerId(rawId);
    const cacheKey = `seller_perf:${sellerId}`;
    const cached = await redis.getJson<any>(cacheKey);
    if (cached) return cached;

    let performance = await prisma.sellerPerformance.findUnique({
      where: { sellerId },
    });

    if (!performance) {
      // Calculate immediately if not found
      performance = await this.calculateSellerPerformance(sellerId, { triggerReason: 'INITIAL_LOAD' });
    }

    if (!performance) {
      throw new AppError('تعذر احتساب بيانات أداء التاجر', 500);
    }

    const config = await SellerPerformanceConfigService.getConfig();
    const components = {
      customerSatisfactionScore: performance.customerSatisfactionScore,
      responseTimeScore: performance.responseTimeScore,
      orderCompletionScore: performance.orderCompletionScore,
      onTimeFulfillmentScore: performance.onTimeFulfillmentScore,
      issueRateScore: performance.issueRateScore,
    };
    const rawMetrics: RawPerformanceMetrics = {
      eligibleOrdersCount: performance.eligibleOrderCount,
      deliveredOrdersCount: Math.round(performance.eligibleOrderCount * (performance.orderCompletionRate / 100)),
      sellerCancelledOrdersCount: Math.round(performance.eligibleOrderCount * (performance.sellerCancellationRate / 100)),
      customerCancelledOrdersCount: 0,
      onTimeOrdersCount: Math.round(performance.eligibleOrderCount * (performance.onTimeFulfillmentRate / 100)),
      eligibleReviewsCount: performance.eligibleReviewCount,
      ratingAverage: performance.ratingAverage,
      totalConversationsCount: performance.totalConversationsCount,
      answeredConversationsCount: performance.answeredConversationsCount,
      medianResponseMinutes: performance.medianResponseMinutes,
      averageResponseMinutes: performance.medianResponseMinutes,
      confirmedDisputesCount: 0,
      sellerIssuesCount: Math.round(performance.eligibleOrderCount * (performance.issueRate / 100)),
    };

    const recommendations = SellerPerformanceCalculator.generateRecommendations(rawMetrics, components);

    const result = {
      ...performance,
      recommendations,
      gradeLabels: this.getGradeLabels(performance.grade),
    };

    await redis.setJson(cacheKey, result, this.CACHE_TTL_SECONDS);
    return result;
  }

  /**
   * Public view for Customer App (Storefront / Store card).
   * Only exposes approved summary indicators.
   */
  public static async getPublicSellerPerformance(rawId: string): Promise<PublicSellerPerformance> {
    const sellerId = await this.resolveSellerId(rawId);
    const cacheKey = `seller_perf_public:${sellerId}`;
    const cached = await redis.getJson<PublicSellerPerformance>(cacheKey);
    if (cached) return cached;

    const config = await SellerPerformanceConfigService.getConfig();
    const performance = await this.getSellerPerformance(sellerId);

    const gradeLabels = this.getGradeLabels(performance.grade);
    const isInsufficient = performance.dataStatus === 'INSUFFICIENT_DATA';

    const publicResult: PublicSellerPerformance = {
      sellerId,
      grade: performance.grade,
      gradeLabelAr: gradeLabels.ar,
      gradeLabelEn: gradeLabels.en,
      ratingAverage: Math.round(performance.ratingAverage * 10) / 10,
      reviewCount: performance.eligibleReviewCount,
      usuallyRespondsFast: performance.responseTimeScore >= 80,
      highOrderCompletion: performance.orderCompletionScore >= 85,
      isReliable: performance.score >= 80 && !isInsufficient,
      score: config.customerVisible && !isInsufficient ? Math.round(performance.score) : null,
      dataStatus: performance.dataStatus,
      statusLabelAr: isInsufficient ? 'متجر جديد — بيانات الأداء قيد التجميع' : gradeLabels.ar,
      statusLabelEn: isInsufficient ? 'New Seller — Performance data building' : gradeLabels.en,
    };

    await redis.setJson(cacheKey, publicResult, this.CACHE_TTL_SECONDS);
    return publicResult;
  }

  /**
   * Retrieves historical performance snapshots for trends.
   */
  public static async getSellerPerformanceHistory(sellerId: string, limit = 20): Promise<any[]> {
    const snapshots = await prisma.sellerPerformanceSnapshot.findMany({
      where: { sellerId },
      orderBy: { calculatedAt: 'desc' },
      take: Math.min(100, Math.max(1, limit)),
    });

    return snapshots.map((s) => ({
      id: s.id,
      score: s.score,
      grade: s.grade,
      dataStatus: s.dataStatus,
      customerSatisfactionScore: s.customerSatisfactionScore,
      responseTimeScore: s.responseTimeScore,
      orderCompletionScore: s.orderCompletionScore,
      onTimeFulfillmentScore: s.onTimeFulfillmentScore,
      issueRateScore: s.issueRateScore,
      ratingAverage: s.ratingAverage,
      responseRate: s.responseRate,
      orderCompletionRate: s.orderCompletionRate,
      calculatedAt: s.calculatedAt,
      triggerReason: s.triggerReason,
    }));
  }

  /**
   * Admin Leaderboard & Overview listing.
   */
  public static async listSellerPerformances(filter: AdminPerformanceFilter = {}): Promise<{
    items: any[];
    total: number;
    page: number;
    limit: number;
  }> {
    const { grade, dataStatus, search, sortBy = 'score', sortOrder = 'desc', page = 1, limit = 25 } = filter;
    const skip = (page - 1) * limit;

    const where: any = {};
    if (grade) where.grade = grade;
    if (dataStatus) where.dataStatus = dataStatus;
    if (search) {
      where.seller = {
        OR: [
          { stores: { some: { name: { contains: search, mode: 'insensitive' } } } },
          { user: { firstName: { contains: search, mode: 'insensitive' } } },
          { user: { lastName: { contains: search, mode: 'insensitive' } } },
          { user: { email: { contains: search, mode: 'insensitive' } } },
        ],
      };
    }

    const orderBy: any = {};
    if (sortBy === 'score') orderBy.score = sortOrder;
    else if (sortBy === 'orders') orderBy.eligibleOrderCount = sortOrder;
    else if (sortBy === 'reviews') orderBy.eligibleReviewCount = sortOrder;
    else orderBy.calculatedAt = sortOrder;

    const [items, total] = await Promise.all([
      prisma.sellerPerformance.findMany({
        where,
        include: {
          seller: {
            select: {
              id: true,
              user: { select: { firstName: true, lastName: true, email: true, phone: true } },
              stores: { select: { id: true, name: true, slug: true, logo: true, isVerified: true } },
            },
          },
        },
        orderBy,
        skip,
        take: limit,
      }),
      prisma.sellerPerformance.count({ where }),
    ]);

    return {
      items: items.map((item) => ({
        ...item,
        gradeLabels: this.getGradeLabels(item.grade),
      })),
      total,
      page,
      limit,
    };
  }

  /**
   * Admin-triggered authoritative recalculation with Audit Log.
   */
  public static async recalculateManual(
    sellerId: string,
    adminUserId: string,
    reason: string
  ): Promise<any> {
    const seller = await prisma.seller.findUnique({ where: { id: sellerId } });
    if (!seller) throw new AppError('البائع غير موجود', 404);

    const updated = await this.calculateSellerPerformance(sellerId, {
      triggerReason: `MANUAL_ADMIN:${adminUserId}:${reason || 'recalculation'}`,
      forceRecalculate: true,
    });

    await prisma.auditLog.create({
      data: {
        userId: adminUserId,
        action: 'SELLER_PERFORMANCE_MANUAL_RECALCULATE',
        resource: 'seller_performance',
        details: JSON.stringify({
          sellerId,
          reason,
          newScore: updated.score,
          newGrade: updated.grade,
        }),
      },
    });

    return updated;
  }

  /**
   * Localized Grade Labels.
   */
  public static getGradeLabels(grade: PerformanceGrade): { ar: string; en: string } {
    switch (grade) {
      case 'EXCELLENT':
        return { ar: 'ممتاز', en: 'Excellent' };
      case 'VERY_GOOD':
        return { ar: 'جيد جداً', en: 'Very Good' };
      case 'GOOD':
        return { ar: 'جيد', en: 'Good' };
      case 'FAIR':
        return { ar: 'مقبول', en: 'Fair' };
      case 'NEEDS_IMPROVEMENT':
        return { ar: 'يحتاج إلى تحسين', en: 'Needs Improvement' };
      case 'INSUFFICIENT_DATA':
      default:
        return { ar: 'بيانات غير كافية', en: 'Insufficient Data' };
    }
  }
}
