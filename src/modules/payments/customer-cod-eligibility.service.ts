import { prisma } from '../../database/prisma';
import { redisService } from '../../database/redis';
import { remoteConfigService } from '../remote-config/remote-config.service';
import { WalletProviderRegistry } from './adapters/wallet-provider.adapter';
import {
  CustomerCodStatus,
  QualifyingOrderStatus,
  PaymentMethodType,
  PaymentStatus,
  OrderStatus,
} from '@prisma/client';
import { AppError } from '../../middleware/error.middleware';

export interface CodEligibilityResult {
  customerId: string;
  status: CustomerCodStatus;
  isCodAvailable: boolean;
  qualifyingOrdersCount: number;
  requiredOrdersCount: number;
  remainingOrdersNeeded: number;
  reason?: string;
  suspensionReason?: string | null;
  suspendedAt?: Date | null;
  suspendedBy?: string | null;
  qualifyingPaymentMethods: string[];
  lastEvaluatedAt: Date;
}

export interface QualifyingOrderRecord {
  id: string;
  orderId: string;
  paymentId?: string | null;
  paymentMethod: PaymentMethodType;
  paymentProvider?: string | null;
  transactionReference?: string | null;
  orderTotal: number;
  deliveredAt: Date;
  status: QualifyingOrderStatus;
  qualifiedAt: Date;
  invalidationReason?: string | null;
}

const CACHE_KEY_PREFIX = 'customer:cod_eligibility:';
const CACHE_TTL_SECONDS = 300;

export class CustomerCodEligibilityService {
  /**
   * List of payment method types considered prepaid electronic payment methods.
   * Excludes CASH_ON_DELIVERY.
   */
  public static readonly APPROVED_PREPAID_METHODS: PaymentMethodType[] = [
    PaymentMethodType.WALLET,
    PaymentMethodType.YEMENI_WALLET,
    PaymentMethodType.KURAIMI,
    PaymentMethodType.CASHPAY,
    PaymentMethodType.ONECASH,
    PaymentMethodType.JAWALI,
    PaymentMethodType.JAIB,
    PaymentMethodType.YEMEN_WALLET,
    PaymentMethodType.CREDIT_CARD,
    PaymentMethodType.MADA,
    PaymentMethodType.APPLE_PAY,
    PaymentMethodType.STC_PAY,
  ];

  /**
   * Retrieves authorized customer COD eligibility.
   * Backend is the sole authority. Never trusts client counters.
   */
  public static async getCustomerCodEligibility(customerId: string): Promise<CodEligibilityResult> {
    if (!customerId) {
      throw new AppError('معرف العميل مطلوب', 400);
    }

    const cacheKey = `${CACHE_KEY_PREFIX}${customerId}`;
    try {
      const cached = await redisService.get(cacheKey);
      if (cached) {
        const parsed = JSON.parse(cached);
        return {
          ...parsed,
          suspendedAt: parsed.suspendedAt ? new Date(parsed.suspendedAt) : null,
          lastEvaluatedAt: new Date(parsed.lastEvaluatedAt),
        };
      }
    } catch (_) {}

    // Find or initialize profile from genuine database records
    let profile = await prisma.customerCodProfile.findUnique({
      where: { customerId },
    });

    if (!profile) {
      // Evaluate customer based on genuine completed order history
      return await this.recalculateCustomerCodEligibility(
        customerId,
        'INITIAL_CUSTOMER_EVALUATION',
        'SYSTEM'
      );
    }

    const requiredOrdersCount = await remoteConfigService.getCustomerCodMinOrders();
    const isSuspended = profile.isSuspended || profile.status === CustomerCodStatus.SUSPENDED;
    const isEligible = !isSuspended && profile.qualifyingOrdersCount >= requiredOrdersCount;
    const status: CustomerCodStatus = isSuspended
      ? CustomerCodStatus.SUSPENDED
      : (isEligible ? CustomerCodStatus.ELIGIBLE : CustomerCodStatus.LOCKED);

    const remainingOrdersNeeded = Math.max(0, requiredOrdersCount - profile.qualifyingOrdersCount);

    let reason: string;
    if (isSuspended) {
      reason = `تم إيقاف خدمة الدفع عند الاستلام (COD) لحسابك لأسباب رقابية أو إساءة استخدام سابقة: ${profile.suspensionReason || 'مراجعة أمنية وإدارية'}`;
    } else if (isEligible) {
      reason = 'خدمة الدفع عند الاستلام (COD) متاحة ومفعلة لطلباتك بنجاح.';
    } else {
      reason = `خدمة الدفع عند الاستلام (COD) تتطلب إكمال ${requiredOrdersCount} طلبات دفع مسبق ناجحة ومؤكدة. (أكملت ${profile.qualifyingOrdersCount} من ${requiredOrdersCount}، متبقي ${remainingOrdersNeeded}). يرجى اختيار وسيلة دفع إلكترونية لإتمام طلبك.`;
    }

    const result: CodEligibilityResult = {
      customerId,
      status,
      isCodAvailable: isEligible,
      qualifyingOrdersCount: profile.qualifyingOrdersCount,
      requiredOrdersCount,
      remainingOrdersNeeded,
      reason,
      suspensionReason: profile.suspensionReason,
      suspendedAt: profile.suspendedAt,
      suspendedBy: profile.suspendedBy,
      qualifyingPaymentMethods: this.APPROVED_PREPAID_METHODS.map((m) => String(m)),
      lastEvaluatedAt: profile.lastEvaluatedAt,
    };

    try {
      await redisService.set(cacheKey, JSON.stringify(result), CACHE_TTL_SECONDS);
    } catch (_) {}

    return result;
  }

  /**
   * Checks whether a payment method and provider are eligible prepaid electronic methods.
   */
  public static async isPrepaidElectronicMethod(
    method: PaymentMethodType,
    provider?: string | null
  ): Promise<boolean> {
    if (method === PaymentMethodType.CASH_ON_DELIVERY) {
      return false;
    }

    if (method === PaymentMethodType.WALLET) {
      return true; // Internal platform SOUQNA Pay wallet
    }

    // Yemeni digital wallet methods
    if (
      method === PaymentMethodType.YEMENI_WALLET ||
      method === PaymentMethodType.KURAIMI ||
      method === PaymentMethodType.CASHPAY ||
      method === PaymentMethodType.ONECASH ||
      method === PaymentMethodType.JAWALI ||
      method === PaymentMethodType.JAIB ||
      method === PaymentMethodType.YEMEN_WALLET
    ) {
      const code = provider || String(method);
      return WalletProviderRegistry.hasAdapter(code) || (await remoteConfigService.isWalletProviderActive(code));
    }

    // Online payment gateways (Mada, Apple Pay, Cards, STC Pay)
    if (
      method === PaymentMethodType.CREDIT_CARD ||
      method === PaymentMethodType.MADA ||
      method === PaymentMethodType.APPLE_PAY ||
      method === PaymentMethodType.STC_PAY
    ) {
      return true;
    }

    return false;
  }

  /**
   * Evaluates a completed order to see if it satisfies all 8 qualifying conditions.
   * Runs inside database transactions with duplicate prevention and idempotency.
   */
  public static async evaluateQualifyingOrder(
    orderId: string,
    existingTx?: any
  ): Promise<{ qualified: boolean; reason: string }> {
    const requiredOrdersCount = await remoteConfigService.getCustomerCodMinOrders();

    const execute = async (tx: any) => {
      const order = await tx.order.findUnique({
        where: { id: orderId },
        include: {
          payment: {
            include: {
              transactions: true,
            },
          },
        },
      });

      if (!order) {
        return { qualified: false, reason: 'الطلب غير موجود' };
      }

      // Condition 1 & 5: Must reach terminal DELIVERED status and belong to customer
      if (order.status !== OrderStatus.DELIVERED) {
        return {
          qualified: false,
          reason: `حالة الطلب الحالية (${order.status}) غير مكتملة بنجاح، يجب أن يكون الطلب في حالة DELIVERED`,
        };
      }

      // Condition 2: Payment must exist and be verified PAID
      const payment = order.payment;
      if (!payment || payment.status !== PaymentStatus.PAID) {
        return {
          qualified: false,
          reason: 'الدفعة المالية للطلب غير مؤكدة أو لم تُعتمد بنجاح بعد',
        };
      }

      // Condition 4: Payment method must be an approved prepaid electronic payment method (COD NEVER qualifies!)
      if (payment.method === PaymentMethodType.CASH_ON_DELIVERY) {
        return {
          qualified: false,
          reason: 'طلبات الدفع عند الاستلام (COD) لا تُحتسب نهائياً ضمن الطلبات المؤهلة للدفع المسبق',
        };
      }

      const isApprovedMethod = await this.isPrepaidElectronicMethod(payment.method, payment.walletProvider);
      if (!isApprovedMethod) {
        return {
          qualified: false,
          reason: `وسيلة الدفع المستخدمة [${payment.walletProvider || payment.method}] غير معتمدة كوسيلة دفع إلكترونية مؤهلة`,
        };
      }

      // Condition 3: Payment transaction must be recorded in the existing payment system with status PAID
      const hasVerifiedTx = payment.transactions.some((t: any) => t.status === PaymentStatus.PAID);
      if (!hasVerifiedTx) {
        return {
          qualified: false,
          reason: 'لا توجد عملية دفع مؤكدة ومسجلة بسجل حركات الدفع الرسمية (PaymentTransaction)',
        };
      }

      // Condition 6: Order is not cancelled
      const statusStr = String(order.status);
      if (statusStr.startsWith('CANCELLED_') || statusStr.startsWith('REJECTED_')) {
        return {
          qualified: false,
          reason: 'الطلب ملغي ولا يمكن احتسابه ضمن الطلبات المؤهلة',
        };
      }

      // Condition 7: Check if fully refunded
      const completedRefunds = await tx.refundRequest.findMany({
        where: {
          orderId: order.id,
          status: 'REFUND_COMPLETED',
        },
        select: { approvedAmount: true },
      });
      const totalRefunded = completedRefunds.reduce(
        (sum: number, r: { approvedAmount: number | null }) => sum + (r.approvedAmount || 0),
        0
      );

      // Full refund invalidates the order
      if (totalRefunded >= order.total - 0.01) {
        return {
          qualified: false,
          reason: 'الطلب تم استرجاع مبلغه بالكامل وبالتالي لا يحتسب ضمن الطلبات المؤهلة',
        };
      }

      // Condition 8: Idempotency & Duplicate Prevention
      let profile = await tx.customerCodProfile.findUnique({
        where: { customerId: order.userId },
      });

      if (!profile) {
        profile = await tx.customerCodProfile.create({
          data: {
            customerId: order.userId,
            status: CustomerCodStatus.LOCKED,
            qualifyingOrdersCount: 0,
            lastEvaluatedAt: new Date(),
          },
        });
      }

      const existingQualification = await tx.customerCodQualifyingOrder.findUnique({
        where: { orderId: order.id },
      });

      if (existingQualification) {
        if (existingQualification.status === QualifyingOrderStatus.ACTIVE) {
          return { qualified: true, reason: 'الطلب مسجل ومؤهل مسبقاً (معالجة متطابقة Idempotent)' };
        } else {
          // Re-activate if was previously invalidated
          await tx.customerCodQualifyingOrder.update({
            where: { id: existingQualification.id },
            data: {
              status: QualifyingOrderStatus.ACTIVE,
              invalidationReason: null,
              invalidatedAt: null,
            },
          });
        }
      } else {
        // Create immutable qualifying order record (unique constraint enforces single qualification)
        await tx.customerCodQualifyingOrder.create({
          data: {
            profileId: profile.id,
            customerId: order.userId,
            orderId: order.id,
            paymentId: payment.id,
            paymentMethod: payment.method,
            paymentProvider: payment.walletProvider,
            transactionReference: payment.walletTransactionRef || payment.transactionId,
            orderTotal: order.total,
            deliveredAt: order.deliveredAt || new Date(),
            status: QualifyingOrderStatus.ACTIVE,
          },
        });
      }

      // Recalculate active qualifying orders
      const activeCount = await tx.customerCodQualifyingOrder.count({
        where: {
          customerId: order.userId,
          status: QualifyingOrderStatus.ACTIVE,
        },
      });

      const prevStatus = profile.status;
      const prevCount = profile.qualifyingOrdersCount;
      const nextStatus: CustomerCodStatus = profile.isSuspended
        ? CustomerCodStatus.SUSPENDED
        : (activeCount >= requiredOrdersCount ? CustomerCodStatus.ELIGIBLE : CustomerCodStatus.LOCKED);

      await tx.customerCodProfile.update({
        where: { id: profile.id },
        data: {
          qualifyingOrdersCount: activeCount,
          status: nextStatus,
          lastEvaluatedAt: new Date(),
        },
      });

      if (prevStatus !== nextStatus || prevCount !== activeCount) {
        await tx.customerCodEligibilityHistory.create({
          data: {
            profileId: profile.id,
            customerId: order.userId,
            previousStatus: prevStatus,
            newStatus: nextStatus,
            previousOrderCount: prevCount,
            newOrderCount: activeCount,
            changeReason: `تم احتساب طلب الدفع المسبق الناجح (${order.orderNumber}) - إجمالي الطلبات المؤهلة: ${activeCount}`,
            triggeredBy: 'ORDER_DELIVERED',
            operatorId: 'SYSTEM',
          },
        });
      }

      return { qualified: true, reason: 'تم التحقق من الطلب واحتسابه بنجاح ضمن طلبات الدفع المسبق المؤهلة' };
    };

    const result = existingTx
      ? await execute(existingTx)
      : await prisma.$transaction(execute, { maxWait: 15000, timeout: 60000 });

    // Invalidate Redis cache
    if (result.qualified) {
      try {
        const order = await prisma.order.findUnique({ where: { id: orderId }, select: { userId: true } });
        if (order?.userId) {
          await redisService.del(`${CACHE_KEY_PREFIX}${order.userId}`);
        }
      } catch (_) {}
    }

    return result;
  }

  /**
   * Recalculates customer COD eligibility using genuine historical database records.
   * Ensures legacy and existing customers are properly evaluated without mock counters.
   */
  public static async recalculateCustomerCodEligibility(
    customerId: string,
    reason?: string,
    operatorId?: string
  ): Promise<CodEligibilityResult> {
    const requiredOrdersCount = await remoteConfigService.getCustomerCodMinOrders();

    const result = await prisma.$transaction(
      async (tx) => {
        let profile = await tx.customerCodProfile.findUnique({
          where: { customerId },
        });

        if (!profile) {
          profile = await tx.customerCodProfile.create({
            data: {
              customerId,
              status: CustomerCodStatus.LOCKED,
              qualifyingOrdersCount: 0,
              lastEvaluatedAt: new Date(),
            },
          });
        }

      // Fetch all historical delivered orders for this customer
      const candidateOrders = await tx.order.findMany({
        where: {
          userId: customerId,
          status: OrderStatus.DELIVERED,
          payment: {
            status: PaymentStatus.PAID,
            method: { not: PaymentMethodType.CASH_ON_DELIVERY },
          },
        },
        include: {
          payment: {
            include: {
              transactions: true,
            },
          },
        },
        orderBy: { createdAt: 'asc' },
      });

      for (const order of candidateOrders) {
        const payment = order.payment;
        if (!payment || payment.status !== PaymentStatus.PAID) continue;
        if (payment.method === PaymentMethodType.CASH_ON_DELIVERY) continue;

        const isApprovedMethod = await this.isPrepaidElectronicMethod(payment.method, payment.walletProvider);
        if (!isApprovedMethod) continue;

        const hasVerifiedTx = payment.transactions.some((t: any) => t.status === PaymentStatus.PAID);
        if (!hasVerifiedTx) continue;

        // Check refunds
        const refunds = await tx.refundRequest.findMany({
          where: { orderId: order.id, status: 'REFUND_COMPLETED' },
          select: { approvedAmount: true },
        });
        const totalRefunded = refunds.reduce(
          (sum: number, r: { approvedAmount: number | null }) => sum + (r.approvedAmount || 0),
          0
        );
        const isFullyRefunded = totalRefunded >= order.total - 0.01;

        const existingQual = await tx.customerCodQualifyingOrder.findUnique({
          where: { orderId: order.id },
        });

        if (isFullyRefunded) {
          if (existingQual && existingQual.status === QualifyingOrderStatus.ACTIVE) {
            await tx.customerCodQualifyingOrder.update({
              where: { id: existingQual.id },
              data: {
                status: QualifyingOrderStatus.INVALIDATED_REFUND,
                invalidationReason: 'الطلب تم استرجاع مبلغه بالكامل',
                invalidatedAt: new Date(),
              },
            });
          }
        } else {
          if (!existingQual) {
            await tx.customerCodQualifyingOrder.create({
              data: {
                profileId: profile.id,
                customerId,
                orderId: order.id,
                paymentId: payment.id,
                paymentMethod: payment.method,
                paymentProvider: payment.walletProvider,
                transactionReference: payment.walletTransactionRef || payment.transactionId,
                orderTotal: order.total,
                deliveredAt: order.deliveredAt || order.createdAt,
                status: QualifyingOrderStatus.ACTIVE,
              },
            });
          } else if (existingQual.status !== QualifyingOrderStatus.ACTIVE && !existingQual.invalidationReason?.includes('FRAUD')) {
            await tx.customerCodQualifyingOrder.update({
              where: { id: existingQual.id },
              data: {
                status: QualifyingOrderStatus.ACTIVE,
                invalidationReason: null,
                invalidatedAt: null,
              },
            });
          }
        }
      }

      // Count active qualifications
      const activeCount = await tx.customerCodQualifyingOrder.count({
        where: {
          customerId,
          status: QualifyingOrderStatus.ACTIVE,
        },
      });

      const prevStatus = profile.status;
      const prevCount = profile.qualifyingOrdersCount;
      const nextStatus: CustomerCodStatus = profile.isSuspended
        ? CustomerCodStatus.SUSPENDED
        : (activeCount >= requiredOrdersCount ? CustomerCodStatus.ELIGIBLE : CustomerCodStatus.LOCKED);

      const updatedProfile = await tx.customerCodProfile.update({
        where: { id: profile.id },
        data: {
          qualifyingOrdersCount: activeCount,
          status: nextStatus,
          lastEvaluatedAt: new Date(),
        },
      });

      if (prevStatus !== nextStatus || prevCount !== activeCount || reason) {
        await tx.customerCodEligibilityHistory.create({
          data: {
            profileId: profile.id,
            customerId,
            previousStatus: prevStatus,
            newStatus: nextStatus,
            previousOrderCount: prevCount,
            newOrderCount: activeCount,
            changeReason: reason || 'إعادة احتساب وتدقيق أهلية الدفع عند الاستلام بناءً على السجلات الفعلية',
            triggeredBy: operatorId ? 'MANUAL_RECALCULATION' : 'SYSTEM_RECONCILIATION',
            operatorId: operatorId || 'SYSTEM',
          },
        });
      }

      const isEligible = !updatedProfile.isSuspended && updatedProfile.qualifyingOrdersCount >= requiredOrdersCount;
      const remainingOrdersNeeded = Math.max(0, requiredOrdersCount - updatedProfile.qualifyingOrdersCount);

      let msgReason: string;
      if (updatedProfile.isSuspended) {
        msgReason = `تم إيقاف خدمة الدفع عند الاستلام (COD) لحسابك: ${updatedProfile.suspensionReason || 'مراجعة أمنية وإدارية'}`;
      } else if (isEligible) {
        msgReason = 'خدمة الدفع عند الاستلام (COD) متاحة ومفعلة لطلباتك بنجاح.';
      } else {
        msgReason = `خدمة الدفع عند الاستلام (COD) تتطلب إكمال ${requiredOrdersCount} طلبات دفع مسبق ناجحة ومؤكدة. (أكملت ${updatedProfile.qualifyingOrdersCount} من ${requiredOrdersCount}، متبقي ${remainingOrdersNeeded}).`;
      }

      return {
        customerId,
        status: updatedProfile.status,
        isCodAvailable: isEligible,
        qualifyingOrdersCount: updatedProfile.qualifyingOrdersCount,
        requiredOrdersCount,
        remainingOrdersNeeded,
        reason: msgReason,
        suspensionReason: updatedProfile.suspensionReason,
        suspendedAt: updatedProfile.suspendedAt,
        suspendedBy: updatedProfile.suspendedBy,
        qualifyingPaymentMethods: this.APPROVED_PREPAID_METHODS.map((m) => String(m)),
        lastEvaluatedAt: updatedProfile.lastEvaluatedAt,
      };
    },
    { maxWait: 15000, timeout: 60000 });

    // Invalidate Redis cache
    try {
      await redisService.del(`${CACHE_KEY_PREFIX}${customerId}`);
    } catch (_) {}

    return result;
  }

  /**
   * Returns list of qualifying completed prepaid orders for customer.
   */
  public static async getQualifyingCompletedOrders(customerId: string): Promise<QualifyingOrderRecord[]> {
    const list = await prisma.customerCodQualifyingOrder.findMany({
      where: { customerId },
      orderBy: { deliveredAt: 'desc' },
    });

    return list.map((item) => ({
      id: item.id,
      orderId: item.orderId,
      paymentId: item.paymentId,
      paymentMethod: item.paymentMethod,
      paymentProvider: item.paymentProvider,
      transactionReference: item.transactionReference,
      orderTotal: item.orderTotal,
      deliveredAt: item.deliveredAt,
      status: item.status,
      qualifiedAt: item.qualifiedAt,
      invalidationReason: item.invalidationReason,
    }));
  }

  /**
   * Returns immutable audit trail of customer COD eligibility history.
   */
  public static async getCodEligibilityHistory(customerId: string) {
    return prisma.customerCodEligibilityHistory.findMany({
      where: { customerId },
      orderBy: { createdAt: 'desc' },
      take: 50,
    });
  }

  /**
   * Suspends customer COD eligibility for documented fraud or repeated risk reasons.
   */
  public static async invalidateEligibilityForFraud(
    customerId: string,
    reason: string,
    adminUserId?: string
  ): Promise<CodEligibilityResult> {
    if (!reason || reason.trim().length < 5) {
      throw new AppError('يرجى توثيق سبب تعليق أو حظر خدمة الدفع عند الاستلام بالتفصيل (5 أحرف على الأقل)', 400);
    }

    const cleanReason = reason.trim();
    await prisma.$transaction(
      async (tx) => {
        let profile = await tx.customerCodProfile.findUnique({
          where: { customerId },
        });

        if (!profile) {
          profile = await tx.customerCodProfile.create({
            data: {
              customerId,
              status: CustomerCodStatus.LOCKED,
              qualifyingOrdersCount: 0,
              lastEvaluatedAt: new Date(),
            },
          });
        }

        const prevStatus = profile.status;
        const prevCount = profile.qualifyingOrdersCount;

        await tx.customerCodProfile.update({
          where: { id: profile.id },
          data: {
            status: CustomerCodStatus.SUSPENDED,
            isSuspended: true,
            suspensionReason: cleanReason,
            suspendedAt: new Date(),
            suspendedBy: adminUserId || 'ADMIN',
            lastEvaluatedAt: new Date(),
          },
        });

        await tx.customerCodEligibilityHistory.create({
          data: {
            profileId: profile.id,
            customerId,
            previousStatus: prevStatus,
            newStatus: CustomerCodStatus.SUSPENDED,
            previousOrderCount: prevCount,
            newOrderCount: prevCount,
            changeReason: `تعليق خدمة الدفع عند الاستلام بداعي مخاطر/احتيال موثق: ${cleanReason}`,
            triggeredBy: 'FRAUD_SUSPENSION',
            operatorId: adminUserId || 'ADMIN',
          },
        });
      },
      { maxWait: 15000, timeout: 60000 }
    );

    try {
      await redisService.del(`${CACHE_KEY_PREFIX}${customerId}`);
    } catch (_) {}

    return this.getCustomerCodEligibility(customerId);
  }

  /**
   * Reinstates customer COD eligibility after authorized administrative review.
   */
  public static async reinstateCodEligibility(
    customerId: string,
    reason: string,
    adminUserId: string
  ): Promise<CodEligibilityResult> {
    if (!reason || reason.trim().length < 5) {
      throw new AppError('يرجى كتابة سبب رفع التعليق وإعادة التفعيل (5 أحرف على الأقل)', 400);
    }

    const cleanReason = reason.trim();
    const requiredOrdersCount = await remoteConfigService.getCustomerCodMinOrders();

    await prisma.$transaction(
      async (tx) => {
        const profile = await tx.customerCodProfile.findUnique({
          where: { customerId },
        });

        if (!profile) {
          throw new AppError('ملف العميل غير موجود', 404);
        }

        const prevStatus = profile.status;
        const activeCount = await tx.customerCodQualifyingOrder.count({
          where: { customerId, status: QualifyingOrderStatus.ACTIVE },
        });

        const nextStatus: CustomerCodStatus = activeCount >= requiredOrdersCount
          ? CustomerCodStatus.ELIGIBLE
          : CustomerCodStatus.LOCKED;

        await tx.customerCodProfile.update({
          where: { id: profile.id },
          data: {
            isSuspended: false,
            status: nextStatus,
            qualifyingOrdersCount: activeCount,
            reinstatedAt: new Date(),
            reinstatedBy: adminUserId,
            reinstateReason: cleanReason,
            lastEvaluatedAt: new Date(),
          },
        });

        await tx.customerCodEligibilityHistory.create({
          data: {
            profileId: profile.id,
            customerId,
            previousStatus: prevStatus,
            newStatus: nextStatus,
            previousOrderCount: profile.qualifyingOrdersCount,
            newOrderCount: activeCount,
            changeReason: `رفع تعليق الدفع عند الاستلام بموجب تدقيق إداري: ${cleanReason}`,
            triggeredBy: 'ADMIN_REINSTATE',
            operatorId: adminUserId,
          },
        });
      },
      { maxWait: 15000, timeout: 60000 }
    );

    try {
      await redisService.del(`${CACHE_KEY_PREFIX}${customerId}`);
    } catch (_) {}

    return this.getCustomerCodEligibility(customerId);
  }

  /**
   * Handles refund completion on a qualifying order.
   * Partial refund follows defined policy and does not automatically invalidate legitimate completed orders.
   * Full refund invalidates the qualifying order.
   */
  public static async handleRefundCompleted(params: {
    orderId: string;
    refundApprovedAmount: number;
    totalOrderAmount: number;
    isFraudOrDisputed?: boolean;
    tx?: any;
  }): Promise<void> {
    const requiredOrdersCount = await remoteConfigService.getCustomerCodMinOrders();

    const execute = async (tx: any) => {
      const qualOrder = await tx.customerCodQualifyingOrder.findUnique({
        where: { orderId: params.orderId },
      });

      if (!qualOrder) return;

      const completedRefunds = await tx.refundRequest.findMany({
        where: { orderId: params.orderId, status: 'REFUND_COMPLETED' },
        select: { approvedAmount: true },
      });

      const totalRefunded = completedRefunds.reduce(
        (sum: number, r: { approvedAmount: number | null }) => sum + (r.approvedAmount || 0),
        0
      );

      const isFullyRefunded = totalRefunded >= qualOrder.orderTotal - 0.01;
      const isFraud = params.isFraudOrDisputed === true;

      if (isFullyRefunded || isFraud) {
        const nextStatus = isFraud
          ? QualifyingOrderStatus.INVALIDATED_FRAUD
          : QualifyingOrderStatus.INVALIDATED_REFUND;
        const reason = isFraud
          ? 'تم إلغاء تأهيل الطلب بسبب نزاع مالي أو تحقيق احتيال مؤكد'
          : 'تم إلغاء تأهيل الطلب بسبب استرداد كامل قيمة الطلب';

        await tx.customerCodQualifyingOrder.update({
          where: { id: qualOrder.id },
          data: {
            status: nextStatus,
            invalidationReason: reason,
            invalidatedAt: new Date(),
          },
        });

        // Update profile
        const activeCount = await tx.customerCodQualifyingOrder.count({
          where: { customerId: qualOrder.customerId, status: QualifyingOrderStatus.ACTIVE },
        });

        const profile = await tx.customerCodProfile.findUnique({
          where: { customerId: qualOrder.customerId },
        });

        if (profile) {
          const prevStatus = profile.status;
          const nextStatus: CustomerCodStatus = profile.isSuspended
            ? CustomerCodStatus.SUSPENDED
            : (activeCount >= requiredOrdersCount ? CustomerCodStatus.ELIGIBLE : CustomerCodStatus.LOCKED);

          await tx.customerCodProfile.update({
            where: { id: profile.id },
            data: {
              qualifyingOrdersCount: activeCount,
              status: nextStatus,
              lastEvaluatedAt: new Date(),
            },
          });

          if (prevStatus !== nextStatus) {
            await tx.customerCodEligibilityHistory.create({
              data: {
                profileId: profile.id,
                customerId: qualOrder.customerId,
                previousStatus: prevStatus,
                newStatus: nextStatus,
                previousOrderCount: profile.qualifyingOrdersCount,
                newOrderCount: activeCount,
                changeReason: reason,
                triggeredBy: 'REFUND_COMPLETED',
                operatorId: 'SYSTEM',
              },
            });
          }
        }
      }
      // If partial refund and not fully refunded and not fraud:
      // Order retains qualifying status per policy (retains legitimate prepaid order status).
    };

    if (params.tx) {
      await execute(params.tx);
    } else {
      await prisma.$transaction(execute, { maxWait: 15000, timeout: 60000 });
    }

    try {
      const order = await prisma.order.findUnique({ where: { id: params.orderId }, select: { userId: true } });
      if (order?.userId) {
        await redisService.del(`${CACHE_KEY_PREFIX}${order.userId}`);
      }
    } catch (_) {}
  }

  /**
   * Handles order cancellation after qualification.
   */
  public static async handleOrderCancelled(orderId: string, cancelReason?: string): Promise<void> {
    const requiredOrdersCount = await remoteConfigService.getCustomerCodMinOrders();

    await prisma.$transaction(
      async (tx) => {
        const qualOrder = await tx.customerCodQualifyingOrder.findUnique({
          where: { orderId },
        });

        if (!qualOrder || qualOrder.status !== QualifyingOrderStatus.ACTIVE) return;

        await tx.customerCodQualifyingOrder.update({
          where: { id: qualOrder.id },
          data: {
            status: QualifyingOrderStatus.INVALIDATED_CANCEL,
            invalidationReason: cancelReason || 'تم إلغاء الطلب بعد التأهيل',
            invalidatedAt: new Date(),
          },
        });

        const activeCount = await tx.customerCodQualifyingOrder.count({
          where: { customerId: qualOrder.customerId, status: QualifyingOrderStatus.ACTIVE },
        });

        const profile = await tx.customerCodProfile.findUnique({
          where: { customerId: qualOrder.customerId },
        });

        if (profile) {
          const prevStatus = profile.status;
          const nextStatus: CustomerCodStatus = profile.isSuspended
            ? CustomerCodStatus.SUSPENDED
            : (activeCount >= requiredOrdersCount ? CustomerCodStatus.ELIGIBLE : CustomerCodStatus.LOCKED);

          await tx.customerCodProfile.update({
            where: { id: profile.id },
            data: {
              qualifyingOrdersCount: activeCount,
              status: nextStatus,
              lastEvaluatedAt: new Date(),
            },
          });

          if (prevStatus !== nextStatus) {
            await tx.customerCodEligibilityHistory.create({
              data: {
                profileId: profile.id,
                customerId: qualOrder.customerId,
                previousStatus: prevStatus,
                newStatus: nextStatus,
                previousOrderCount: profile.qualifyingOrdersCount,
                newOrderCount: activeCount,
                changeReason: `تم استبعاد الطلب الملغي (${orderId}) من الطلبات المؤهلة`,
                triggeredBy: 'ORDER_CANCELLED',
                operatorId: 'SYSTEM',
              },
            });
          }
        }
      },
      { maxWait: 15000, timeout: 60000 }
    );

    try {
      const order = await prisma.order.findUnique({ where: { id: orderId }, select: { userId: true } });
      if (order?.userId) {
        await redisService.del(`${CACHE_KEY_PREFIX}${order.userId}`);
      }
    } catch (_) {}
  }
}
