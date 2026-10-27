import { prisma } from '../../database/prisma';
import {
  CustomerAction,
  CustomerActionCategory,
  CustomerActionPriority,
  CustomerActionStatus,
  CustomerActionType,
  CustomerActionCenterResponse,
  ActionCenterFilterOptions,
} from './action-center.types';
import { ActionCenterRulesEngine } from './action-center.rules';
import { MembershipEligibilityService } from '../membership/membership-eligibility.service';
import { RewardsEarningService } from '../rewards/services/rewards-earning.service';
import { VoucherService } from '../vouchers/voucher.service';
import { VoucherClaimService } from '../vouchers/services/voucher-claim.service';
import { remoteConfigService } from '../remote-config/remote-config.service';
import { AppError } from '../../middleware/error.middleware';

export class CustomerActionCenterService {
  private static readonly DEFAULT_MAX_ITEMS = 3;
  private static readonly MAX_ALLOWED_ITEMS = 5;

  /**
   * Aggregates authoritative actions for a customer with deduplication, expiration,
   * dismissal filtering, and priority sorting.
   */
  public static async getActionCenter(
    userId: string,
    options: ActionCenterFilterOptions = {}
  ): Promise<CustomerActionCenterResponse> {
    const now = new Date();

    // 1. Check Feature Flag / Remote Config
    const isFeatureEnabled = await this.isActionCenterEnabled(userId, options.platform);
    if (!isFeatureEnabled) {
      return {
        items: [],
        totalCount: 0,
        hasMore: false,
        configVersion: '1.0.0',
      };
    }

    const maxItems = Math.min(
      options.limit || this.DEFAULT_MAX_ITEMS,
      this.MAX_ALLOWED_ITEMS
    );

    // 2. Concurrently fetch candidate actions and active dismissals
    // 2. Concurrently fetch candidate actions and active dismissals (excluding orders feature per requirement)
    const [
      userAndAuthActions,
      refundActions,
      membershipActions,
      rewardActions,
      voucherActions,
      permissionActions,
      announcementActions,
      dismissals,
    ] = await Promise.all([
      this.resolveUserAndAuthActions(userId),
      this.resolveRefundActions(userId),
      this.resolveMembershipActions(userId),
      this.resolveRewardActions(userId),
      this.resolveVoucherActions(userId),
      this.resolvePermissionActions(),
      this.resolveAnnouncementActions(now),
      this.fetchActiveDismissals(userId, now),
    ]);

    // 3. Aggregate candidate actions (Orders feature excluded)
    const allCandidates: CustomerAction[] = [
      ...userAndAuthActions,
      ...refundActions,
      ...membershipActions,
      ...rewardActions,
      ...voucherActions,
      ...permissionActions,
      ...announcementActions,
    ];

    // 4. Filter expired actions
    const nonExpired = ActionCenterRulesEngine.filterExpired(allCandidates, now);

    // 5. Filter out dismissed or snoozed actions
    const dismissalKeySet = new Set(dismissals.map((d) => d.deduplicationKey));
    const activeActions = nonExpired.filter(
      (action) => !dismissalKeySet.has(action.deduplicationKey)
    );

    // 6. Deduplicate actions
    const deduplicated = ActionCenterRulesEngine.deduplicate(activeActions);

    // 7. Sort by priority, urgency, recency
    const sorted = ActionCenterRulesEngine.sortActions(deduplicated);

    const totalCount = sorted.length;
    const items = sorted.slice(0, maxItems);
    const hasMore = totalCount > items.length;

    return {
      items,
      totalCount,
      hasMore,
      configVersion: '1.0.0',
    };
  }

  /**
   * User & Authentication authoritative actions (Phone, Email, Profile, Address).
   */
  private static async resolveUserAndAuthActions(userId: string): Promise<CustomerAction[]> {
    const actions: CustomerAction[] = [];

    try {
      const user = await prisma.user.findUnique({
        where: { id: userId },
        include: {
          addresses: {
            take: 1,
          },
        },
      });

      if (!user) return actions;

      // A. Phone Verification: Phone exists but user unverified
      if (user.phone && !user.isVerified) {
        actions.push({
          id: `act_verify_phone_${user.id}`,
          type: CustomerActionType.VERIFY_PHONE,
          category: CustomerActionCategory.SECURITY,
          priority: CustomerActionPriority.HIGH,
          status: CustomerActionStatus.PENDING,
          titleAr: 'وثّق رقم هاتفك',
          titleEn: 'Verify Your Phone Number',
          descriptionAr: 'وثّق رقم هاتفك لحماية حسابك واستعادة الوصول إليه بسهولة.',
          descriptionEn: 'Verify your phone number to secure your account and recover access easily.',
          icon: 'phone_iphone',
          ctaLabelAr: 'إعداد وتوثيق',
          ctaLabelEn: 'Configure & Verify',
          deepLink: `/profile/phone?phone=${encodeURIComponent(user.phone)}`,
          dismissible: true,
          snoozable: true,
          requiresAction: true,
          deduplicationKey: 'VERIFY_PHONE',
          metadata: { phone: user.phone },
          createdAt: user.createdAt.toISOString(),
        });
      }

      // B. Email Verification or Linking
      const isPlaceholderEmail =
        typeof user.email === 'string' &&
        (user.email.endsWith('@social.souqna.ye') ||
         user.email.endsWith('@facebook.com') ||
         user.email.startsWith('facebook_') ||
         user.email.trim() === '');

      if (isPlaceholderEmail) {
        actions.push({
          id: `act_link_email_${user.id}`,
          type: CustomerActionType.VERIFY_EMAIL,
          category: CustomerActionCategory.SECURITY,
          priority: CustomerActionPriority.MEDIUM,
          status: CustomerActionStatus.PENDING,
          titleAr: 'ربط بريد إلكتروني',
          titleEn: 'Link Your Email Address',
          descriptionAr: 'اربط بريدك الإلكتروني لتأمين حسابك وتلقي الفواتير وإشعارات الطلبات.',
          descriptionEn: 'Link an email address to secure your account and receive receipts.',
          icon: 'mail',
          ctaLabelAr: 'ربط الآن',
          ctaLabelEn: 'Link Now',
          deepLink: '/profile/email',
          dismissible: true,
          snoozable: true,
          requiresAction: true,
          deduplicationKey: 'LINK_EMAIL',
          metadata: {},
          createdAt: user.createdAt.toISOString(),
        });
      } else if (user.email && !user.isVerified) {
        actions.push({
          id: `act_verify_email_${user.id}`,
          type: CustomerActionType.VERIFY_EMAIL,
          category: CustomerActionCategory.SECURITY,
          priority: CustomerActionPriority.HIGH,
          status: CustomerActionStatus.PENDING,
          titleAr: 'وثّق بريدك الإلكتروني',
          titleEn: 'Verify Your Email Address',
          descriptionAr: 'وثّق بريدك الإلكتروني لتأمين حسابك وتلقي إشعارات الطلبات والفواتير.',
          descriptionEn: 'Verify your email to secure your account and receive order receipts.',
          icon: 'mail',
          ctaLabelAr: 'إعداد وتوثيق',
          ctaLabelEn: 'Configure & Verify',
          deepLink: `/profile/email?email=${encodeURIComponent(user.email)}`,
          dismissible: true,
          snoozable: true,
          requiresAction: true,
          deduplicationKey: 'VERIFY_EMAIL',
          metadata: { email: user.email },
          createdAt: user.createdAt.toISOString(),
        });
      }

      // C. Profile Completion: Missing essential name details
      const isMissingName = !user.firstName || user.firstName.trim() === '' || !user.lastName || user.lastName.trim() === '';
      if (isMissingName) {
        actions.push({
          id: `act_profile_complete_${user.id}`,
          type: CustomerActionType.COMPLETE_PROFILE,
          category: CustomerActionCategory.ACCOUNT,
          priority: CustomerActionPriority.MEDIUM,
          status: CustomerActionStatus.PENDING,
          titleAr: 'أكمل بيانات ملفك الشخصي',
          titleEn: 'Complete Your Profile',
          descriptionAr: 'أكمل بياناتك الشخصية لتسهيل استلام الشحنات وتخصيص تجربة التسوق.',
          descriptionEn: 'Complete your profile details for faster deliveries and personalized shopping.',
          icon: 'person',
          ctaLabelAr: 'إكمال الملف',
          ctaLabelEn: 'Complete Profile',
          deepLink: '/profile/edit',
          dismissible: true,
          snoozable: true,
          requiresAction: true,
          deduplicationKey: 'COMPLETE_PROFILE',
          createdAt: user.createdAt.toISOString(),
        });
      }

      // D. Missing Delivery Address
      if (user.addresses.length === 0) {
        actions.push({
          id: `act_address_add_${user.id}`,
          type: CustomerActionType.ADDRESS_ACTION,
          category: CustomerActionCategory.DELIVERY,
          priority: CustomerActionPriority.MEDIUM,
          status: CustomerActionStatus.PENDING,
          titleAr: 'أضف عنوان التوصيل الأول',
          titleEn: 'Add Your Delivery Address',
          descriptionAr: 'أضف عنوانك لتسريع إتمام الطلبات وتحديد خيارات التوصيل المتاحة لمنطقتك.',
          descriptionEn: 'Add your delivery address to speed up checkout and view shipping options.',
          icon: 'location_on',
          ctaLabelAr: 'إضافة عنوان',
          ctaLabelEn: 'Add Address',
          deepLink: '/profile/addresses/add',
          dismissible: true,
          snoozable: true,
          requiresAction: true,
          deduplicationKey: 'ADDRESS_ACTION:MISSING',
          createdAt: user.createdAt.toISOString(),
        });
      }
    } catch (err) {
      console.error('[ActionCenter] Error resolving user/auth actions:', err);
    }

    return actions;
  }

  /**
   * Order & Payment authoritative actions.
   */
  private static async resolveOrderAndPaymentActions(userId: string): Promise<CustomerAction[]> {
    const actions: CustomerAction[] = [];

    try {
      // Find non-cancelled orders requiring immediate payment
      const pendingPaymentOrders = await prisma.order.findMany({
        where: {
          userId,
          status: {
            notIn: [
              'CANCELLED_BY_CUSTOMER',
              'CANCELLED_BY_SELLER',
              'CANCELLED_BY_ADMIN',
              'REJECTED_BY_SELLER',
            ],
          },
          OR: [
            { status: 'PENDING' },
            { payment: { status: { in: ['PENDING', 'FAILED'] } } },
          ],
        },
        include: { payment: true },
        take: 2,
        orderBy: { createdAt: 'desc' },
      });

      for (const order of pendingPaymentOrders) {
        actions.push({
          id: `act_order_payment_${order.id}`,
          type: CustomerActionType.PAYMENT_ACTION,
          category: CustomerActionCategory.PAYMENT,
          priority: CustomerActionPriority.CRITICAL,
          status: CustomerActionStatus.PENDING,
          titleAr: `طلب #${order.orderNumber} بانتظار إتمام الدفع`,
          titleEn: `Order #${order.orderNumber} Requires Payment`,
          descriptionAr: 'لديك طلب بانتظار إتمام الدفع لمباشرة تجهيزه وشحنه إلى عنوانك.',
          descriptionEn: 'Payment is required to confirm and dispatch your order.',
          icon: 'payment',
          ctaLabelAr: 'إتمام الدفع',
          ctaLabelEn: 'Pay Now',
          deepLink: `/orders/${order.id}`,
          dismissible: false, // Critical payment actions are non-dismissible
          snoozable: false,
          requiresAction: true,
          deduplicationKey: `ORDER_PAYMENT:${order.id}`,
          metadata: { orderId: order.id, orderNumber: order.orderNumber, total: order.total },
          createdAt: order.createdAt.toISOString(),
        });
      }
    } catch (err) {
      console.error('[ActionCenter] Error resolving order/payment actions:', err);
    }

    return actions;
  }

  /**
   * Refund & Dispute authoritative actions.
   */
  private static async resolveRefundActions(userId: string): Promise<CustomerAction[]> {
    const actions: CustomerAction[] = [];

    try {
      const pendingRefunds = await prisma.refundRequest.findMany({
        where: {
          customerId: userId,
          status: {
            in: ['SELLER_ACCEPTED', 'UNDER_SELLER_REVIEW', 'CUSTOMER_DISPUTED'],
          },
        },
        take: 1,
        orderBy: { updatedAt: 'desc' },
      });

      for (const refund of pendingRefunds) {
        if (refund.status === 'SELLER_ACCEPTED') {
          actions.push({
            id: `act_refund_accepted_${refund.id}`,
            type: CustomerActionType.REFUND_ACTION,
            category: CustomerActionCategory.ORDER,
            priority: CustomerActionPriority.HIGH,
            status: CustomerActionStatus.PENDING,
            titleAr: 'تمت الموافقة على طلب الاسترجاع',
            titleEn: 'Return Request Approved',
            descriptionAr: 'وافق البائع على طلب الاسترجاع، يرجى متابعة الخطوات لإتمام الاسترجاع.',
            descriptionEn: 'The seller accepted your return request. Please review next steps.',
            icon: 'assignment_return',
            ctaLabelAr: 'متابعة الاسترجاع',
            ctaLabelEn: 'View Return',
            deepLink: `/refunds/${refund.id}`,
            dismissible: true,
            snoozable: true,
            requiresAction: true,
            deduplicationKey: `REFUND_ACTION:${refund.id}`,
            metadata: { refundId: refund.id },
            createdAt: refund.createdAt.toISOString(),
          });
        }
      }
    } catch (err) {
      console.error('[ActionCenter] Error resolving refund actions:', err);
    }

    return actions;
  }

  /**
   * Membership & VIP Tiers authoritative actions.
   */
  private static async resolveMembershipActions(userId: string): Promise<CustomerAction[]> {
    const actions: CustomerAction[] = [];

    try {
      const summary = await MembershipEligibilityService.getCustomerSummary(userId);

      // A. Grace Period Warning
      if (summary.isGracePeriod) {
        actions.push({
          id: `act_membership_grace_${summary.tierId}`,
          type: CustomerActionType.MEMBERSHIP_ACTION,
          category: CustomerActionCategory.MEMBERSHIP,
          priority: CustomerActionPriority.HIGH,
          status: CustomerActionStatus.PENDING,
          titleAr: 'فترة سماح لتجديد عضويتك',
          titleEn: 'Membership Renewal Grace Period',
          descriptionAr: `عضويتك في فئة ${summary.tierNameAr} في فترة سماح. تسوق الآن للحفاظ على مزاياك.`,
          descriptionEn: `Your ${summary.tierNameEn} tier is in a grace period. Shop now to keep your benefits.`,
          icon: 'workspace_premium',
          ctaLabelAr: 'تفاصيل العضوية',
          ctaLabelEn: 'View VIP',
          deepLink: '/membership',
          dismissible: false,
          snoozable: false,
          requiresAction: true,
          deduplicationKey: 'MEMBERSHIP_GRACE',
          metadata: { tierCode: summary.tierCode },
          createdAt: new Date().toISOString(),
        });
      }

      // B. Progress toward next tier
      if (summary.progress && summary.progress.remaining > 0 && summary.progress.percentage >= 40) {
        actions.push({
          id: `act_membership_prog_${summary.progress.nextTierCode}`,
          type: CustomerActionType.MEMBERSHIP_PROGRESS,
          category: CustomerActionCategory.MEMBERSHIP,
          priority: CustomerActionPriority.MEDIUM,
          status: CustomerActionStatus.PENDING,
          titleAr: `أنت قريب من فئة ${summary.progress.nextTierNameAr}! 👑`,
          titleEn: `You are close to ${summary.progress.nextTierNameEn}! 👑`,
          descriptionAr: `تبقى لك ${summary.progress.remaining.toLocaleString()} للترقية إلى ${summary.progress.nextTierNameAr} وفتح مزايا حصرية.`,
          descriptionEn: `Only ${summary.progress.remaining.toLocaleString()} left to unlock ${summary.progress.nextTierNameEn} benefits.`,
          icon: 'stars',
          ctaLabelAr: 'استكشف المزايا',
          ctaLabelEn: 'Explore Perks',
          deepLink: '/membership',
          dismissible: true,
          snoozable: true,
          requiresAction: false,
          deduplicationKey: 'MEMBERSHIP_PROGRESS',
          metadata: {
            nextTierCode: summary.progress.nextTierCode,
            percentage: summary.progress.percentage,
            remaining: summary.progress.remaining,
          },
          createdAt: new Date().toISOString(),
        });
      }
    } catch (err) {
      console.error('[ActionCenter] Error resolving membership actions:', err);
    }

    return actions;
  }

  /**
   * SOUQNAA Coins & Rewards authoritative actions.
   */
  private static async resolveRewardActions(userId: string): Promise<CustomerAction[]> {
    const actions: CustomerAction[] = [];

    try {
      // Daily check-in status
      const checkinStatus = await RewardsEarningService.getDailyCheckinStatus(userId);
      if (!checkinStatus.hasClaimedToday) {
        actions.push({
          id: `act_daily_checkin_${new Date().toISOString().split('T')[0]}`,
          type: CustomerActionType.CLAIM_REWARD,
          category: CustomerActionCategory.REWARD,
          priority: CustomerActionPriority.MEDIUM,
          status: CustomerActionStatus.PENDING,
          titleAr: 'سجّل حضورك اليومي واكسب العملات 🪙',
          titleEn: 'Claim Your Daily Check-in Coins 🪙',
          descriptionAr: `لديك مكافأة حضور يومي بقيمة ${checkinStatus.todayRewardCoins} عملة بانتظارك اليوم!`,
          descriptionEn: `Your daily check-in bonus of ${checkinStatus.todayRewardCoins} coins is waiting for you!`,
          icon: 'stars',
          ctaLabelAr: 'استلام الآن',
          ctaLabelEn: 'Claim Now',
          deepLink: '/rewards',
          dismissible: true,
          snoozable: true,
          requiresAction: false,
          deduplicationKey: 'DAILY_CHECKIN',
          metadata: { coins: checkinStatus.todayRewardCoins, streak: checkinStatus.currentStreak },
          createdAt: new Date().toISOString(),
        });
      }
    } catch (err) {
      console.error('[ActionCenter] Error resolving rewards actions:', err);
    }

    return actions;
  }

  /**
   * Coupons & Vouchers authoritative actions.
   */
  private static async resolveVoucherActions(userId: string): Promise<CustomerAction[]> {
    const actions: CustomerAction[] = [];

    try {
      const vouchers = await VoucherService.getVoucherCenterVouchers({ customerId: userId });
      const availableUnclaimed = vouchers
        .filter((v: any) => !v.isClaimed && !v.isDepleted && v.status === 'ACTIVE')
        .sort((a: any, b: any) => (b.discountValue || 0) - (a.discountValue || 0));

      const topVoucher = availableUnclaimed[0];
      if (topVoucher) {
        actions.push({
          id: `act_voucher_${topVoucher.id}`,
          type: CustomerActionType.CLAIM_COUPON,
          category: CustomerActionCategory.PROMOTION,
          priority: CustomerActionPriority.MEDIUM,
          status: CustomerActionStatus.PENDING,
          titleAr: `كوبون خصم متاح لك: ${topVoucher.name} 🎟️`,
          titleEn: `Special Voucher Available: ${topVoucher.name} 🎟️`,
          descriptionAr: topVoucher.description || `استفد من خصم ${topVoucher.discountValue} على مشترياتك القادمة.`,
          descriptionEn: topVoucher.description || `Enjoy ${topVoucher.discountValue} discount on your next order.`,
          icon: 'confirmation_number',
          ctaLabelAr: 'احصل عليه',
          ctaLabelEn: 'Claim Now',
          deepLink: '/voucher-center',
          dismissible: true,
          snoozable: true,
          requiresAction: false,
          expiresAt: topVoucher.endAt ? new Date(topVoucher.endAt).toISOString() : null,
          deduplicationKey: `COUPON:${topVoucher.id}`,
          metadata: { voucherId: topVoucher.id, code: topVoucher.code },
          createdAt: topVoucher.createdAt ? new Date(topVoucher.createdAt).toISOString() : new Date().toISOString(),
        });
      }
    } catch (err) {
      console.error('[ActionCenter] Error resolving voucher actions:', err);
    }

    return actions;
  }

  /**
   * System Permission Recommendation Actions.
   * Note: Flutter checks local OS permission state before display.
   */
  private static async resolvePermissionActions(): Promise<CustomerAction[]> {
    return [
      {
        id: 'act_perm_notification',
        type: CustomerActionType.ENABLE_NOTIFICATION_PERMISSION,
        category: CustomerActionCategory.PERMISSION,
        priority: CustomerActionPriority.MEDIUM,
        status: CustomerActionStatus.PENDING,
        titleAr: 'فعّل الإشعارات لمتابعة طلباتك 🔔',
        titleEn: 'Enable Order Notifications 🔔',
        descriptionAr: 'فعّل الإشعارات لتصلك تحديثات حالة الشحن وعروض الخصم الحصرية لحظياً.',
        descriptionEn: 'Enable notifications to get real-time shipping updates and exclusive discounts.',
        icon: 'notifications',
        ctaLabelAr: 'تفعيل الآن',
        ctaLabelEn: 'Enable Now',
        deepLink: '/notifications',
        dismissible: true,
        snoozable: true,
        requiresAction: false,
        deduplicationKey: 'PERMISSION:NOTIFICATION',
        createdAt: new Date().toISOString(),
      },
      {
        id: 'act_perm_location',
        type: CustomerActionType.ENABLE_LOCATION_PERMISSION,
        category: CustomerActionCategory.PERMISSION,
        priority: CustomerActionPriority.LOW,
        status: CustomerActionStatus.PENDING,
        titleAr: 'فعّل الموقع لتحديد عنوان التوصيل 📍',
        titleEn: 'Enable Location for Accurate Delivery 📍',
        descriptionAr: 'فعّل الموقع لتسهيل تحديد عنوان التوصيل بدقة وعرض أقرب المتاجر إليك.',
        descriptionEn: 'Enable location to accurately set your delivery address and find nearby stores.',
        icon: 'location_on',
        ctaLabelAr: 'تفعيل الموقع',
        ctaLabelEn: 'Enable Location',
        deepLink: '/profile/addresses/map-picker',
        dismissible: true,
        snoozable: true,
        requiresAction: false,
        deduplicationKey: 'PERMISSION:LOCATION',
        createdAt: new Date().toISOString(),
      },
    ];
  }

  /**
   * Announcements configured by Admin.
   */
  private static async resolveAnnouncementActions(now: Date): Promise<CustomerAction[]> {
    const actions: CustomerAction[] = [];

    try {
      const announcements = await prisma.customerActionAnnouncement.findMany({
        where: {
          isActive: true,
          startsAt: { lte: now },
          OR: [{ expiresAt: null }, { expiresAt: { gt: now } }],
        },
        orderBy: [{ priority: 'desc' }, { createdAt: 'desc' }],
        take: 2,
      });

      for (const ann of announcements) {
        actions.push({
          id: `act_announcement_${ann.id}`,
          type: CustomerActionType.PLATFORM_ANNOUNCEMENT,
          category: ann.category,
          priority: (ann.priority as CustomerActionPriority) || CustomerActionPriority.MEDIUM,
          status: CustomerActionStatus.PENDING,
          titleAr: ann.titleAr,
          titleEn: ann.titleEn,
          descriptionAr: ann.descriptionAr,
          descriptionEn: ann.descriptionEn,
          icon: ann.icon || 'campaign',
          image: ann.imageUrl,
          ctaLabelAr: ann.ctaLabelAr || 'استكشف',
          ctaLabelEn: ann.ctaLabelEn || 'Explore',
          deepLink: ann.deepLink || '/home',
          dismissible: ann.dismissible,
          snoozable: ann.snoozable,
          requiresAction: false,
          expiresAt: ann.expiresAt ? ann.expiresAt.toISOString() : null,
          deduplicationKey: `ANNOUNCEMENT:${ann.id}`,
          createdAt: ann.createdAt.toISOString(),
          updatedAt: ann.updatedAt.toISOString(),
        });
      }
    } catch (err) {
      console.error('[ActionCenter] Error resolving announcement actions:', err);
    }

    return actions;
  }

  /**
   * Fetches active dismissals & snoozes from DB.
   */
  private static async fetchActiveDismissals(userId: string, now: Date) {
    try {
      return await prisma.customerActionDismissal.findMany({
        where: {
          userId,
          OR: [
            { snoozedUntil: null },
            { snoozedUntil: { gt: now } },
          ],
        },
      });
    } catch (err) {
      console.error('[ActionCenter] Error fetching dismissals:', err);
      return [];
    }
  }

  /**
   * Dismisses an action for the customer.
   */
  public static async dismissAction(
    userId: string,
    actionId: string,
    deduplicationKey?: string
  ): Promise<boolean> {
    const key = deduplicationKey || actionId;

    // Prevent dismissing critical actions
    if (key.startsWith('ORDER_PAYMENT:') || key === 'SECURITY_CRITICAL') {
      throw new AppError('لا يمكن تجاهل هذا الإجراء الحرج للأمان أو الدفع', 400);
    }

    await prisma.customerActionDismissal.upsert({
      where: {
        userId_deduplicationKey: {
          userId,
          deduplicationKey: key,
        },
      },
      create: {
        userId,
        deduplicationKey: key,
        actionType: 'DISMISSED',
        snoozedUntil: null,
      },
      update: {
        dismissedAt: new Date(),
        snoozedUntil: null,
      },
    });

    return true;
  }

  /**
   * Snoozes an action for a given number of hours.
   */
  public static async snoozeAction(
    userId: string,
    actionId: string,
    deduplicationKey?: string,
    snoozeHours: number = 24
  ): Promise<boolean> {
    const key = deduplicationKey || actionId;
    const snoozedUntil = new Date(Date.now() + snoozeHours * 60 * 60 * 1000);

    await prisma.customerActionDismissal.upsert({
      where: {
        userId_deduplicationKey: {
          userId,
          deduplicationKey: key,
        },
      },
      create: {
        userId,
        deduplicationKey: key,
        actionType: 'SNOOZED',
        snoozedUntil,
      },
      update: {
        snoozedUntil,
      },
    });

    return true;
  }

  /**
   * Authoritative Action Execution / Claim.
   * Validates eligibility atomically using the authoritative underlying engines.
   */
  public static async claimAction(
    userId: string,
    actionId: string,
    claimType?: string,
    metadata: Record<string, any> = {}
  ): Promise<any> {
    // 1. Daily Check-in Claim
    if (claimType === 'DAILY_CHECKIN' || actionId.includes('daily_checkin')) {
      return await RewardsEarningService.claimDailyCheckin(userId);
    }

    // 2. Voucher Claim
    if (claimType === 'CLAIM_COUPON' || actionId.includes('voucher')) {
      const voucherId = metadata.voucherId || actionId.replace('act_voucher_', '');
      return await VoucherClaimService.claimVoucher({
        voucherId,
        customerId: userId,
        claimSource: 'ACTION_CENTER',
      });
    }

    // 3. Mission Claim
    if (claimType === 'MISSION' && metadata.missionId) {
      return await RewardsEarningService.claimMissionReward(userId, metadata.missionId);
    }

    return {
      success: true,
      message: 'Action completed successfully',
    };
  }

  private static async isActionCenterEnabled(userId?: string, platform?: string): Promise<boolean> {
    try {
      return await remoteConfigService.isFeatureActive('customer_action_center', {
        userId,
        platform,
      });
    } catch (_) {
      return true;
    }
  }
}
