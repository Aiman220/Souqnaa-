/**
 * SOUQNA — FIRST ORDER FREE SHIPPING ENGINE
 * Authoritative First-Order Free Shipping Eligibility Service
 * Version: 1.0.0
 */

import { prisma } from '../../../database/prisma';
import { FirstOrderShippingConfigService } from './first-order-shipping-config.service';
import { FirstOrderPromotionAbuseService } from './first-order-abuse.service';
import {
  FirstOrderEligibilityInput,
  FirstOrderEligibilityResult,
  FirstOrderEligibilityStatus,
} from '../first-order-shipping.types';

export class FirstOrderFreeShippingEligibilityService {
  /**
   * Authoritatively evaluates whether a customer is eligible for First-Order Free Shipping.
   * Strictly server-side; NEVER relies on or trusts client assertions.
   */
  public static async evaluateEligibility(
    input: FirstOrderEligibilityInput
  ): Promise<FirstOrderEligibilityResult> {
    const config = await FirstOrderShippingConfigService.getConfig();

    // 1. Campaign Enabled Check
    if (!config.enabled) {
      return this.buildResult(
        FirstOrderEligibilityStatus.CAMPAIGN_DISABLED,
        'عرض الشحن المجاني للطلب الأول غير مفعل حالياً',
        'First order free shipping campaign is currently disabled',
        config
      );
    }

    // 2. Campaign Date Window Check
    const now = new Date();
    if (config.startAt && new Date(config.startAt) > now) {
      return this.buildResult(
        FirstOrderEligibilityStatus.CAMPAIGN_DISABLED,
        'لم تبدأ حملة الشحن المجاني للطلب الأول بعد',
        'First order free shipping campaign has not started yet',
        config
      );
    }

    if (config.endAt && new Date(config.endAt) < now) {
      return this.buildResult(
        FirstOrderEligibilityStatus.CAMPAIGN_DISABLED,
        'انتهت حملة الشحن المجاني للطلب الأول',
        'First order free shipping campaign has ended',
        config
      );
    }

    // 3. Campaign Budget Check
    if (
      config.platformBudget !== null &&
      config.platformBudget !== undefined &&
      config.consumedBudget >= config.platformBudget
    ) {
      return this.buildResult(
        FirstOrderEligibilityStatus.BUDGET_EXHAUSTED,
        'تم استنفاد الميزانية المخصصة لحملة الشحن المجاني للطلب الأول',
        'Campaign budget for first order free shipping has been exhausted',
        config
      );
    }

    // 4. Customer Identity & Account Status
    const user = await prisma.user.findUnique({
      where: { id: input.customerId },
      select: {
        id: true,
        isActive: true,
        isVerified: true,
        phone: true,
        email: true,
      },
    });

    if (!user) {
      return this.buildResult(
        FirstOrderEligibilityStatus.ACCOUNT_RESTRICTED,
        'حساب العميل غير موجود',
        'Customer account not found',
        config
      );
    }

    if (!user.isActive) {
      return this.buildResult(
        FirstOrderEligibilityStatus.ACCOUNT_RESTRICTED,
        'حساب العميل غير نشط أو معلق',
        'Customer account is restricted or inactive',
        config
      );
    }

    if (config.requireVerifiedPhone && !user.isVerified) {
      return this.buildResult(
        FirstOrderEligibilityStatus.ACCOUNT_RESTRICTED,
        'يجب تأكيد رقم الهاتف للاستفادة من عرض الشحن المجاني للطلب الأول',
        'Phone number verification is required for free shipping',
        config
      );
    }

    if (config.requireVerifiedEmail && (!user.email || !user.isVerified)) {
      return this.buildResult(
        FirstOrderEligibilityStatus.ACCOUNT_RESTRICTED,
        'يجب تأكيد البريد الإلكتروني للاستفادة من عرض الشحن المجاني للطلب الأول',
        'Email verification is required for free shipping',
        config
      );
    }

    // 5. Prior Promotion Usage Check (One-time usage policy)
    const consumedUsageCount = await prisma.promotionUsage.count({
      where: {
        customerId: user.id,
        promotionType: 'FIRST_ORDER_FREE_SHIPPING',
        status: 'CONSUMED',
      },
    });

    if (consumedUsageCount >= config.customerLimit) {
      return this.buildResult(
        FirstOrderEligibilityStatus.ALREADY_USED,
        'تمت الاستفادة مسبقاً من عرض الشحن المجاني للطلب الأول لهذا الحساب',
        'First order free shipping benefit has already been used on this account',
        config
      );
    }

    // 6. Prior Qualifying Orders Check (Not merely orders.count == 0)
    // Only orders that reached an authoritative qualifying status count as prior orders
    const priorQualifyingOrdersCount = await prisma.order.count({
      where: {
        userId: user.id,
        status: { in: config.eligibleOrderStatuses as any },
      },
    });

    if (priorQualifyingOrdersCount > 0) {
      return this.buildResult(
        FirstOrderEligibilityStatus.ORDER_NOT_QUALIFIED,
        'العرض مخصص للطلب الأول فقط، ويوجد طلبات مؤكدة سابقة على هذا الحساب',
        'This promotion is reserved for first qualifying order only',
        config
      );
    }

    // 7. Minimum Order Amount Check
    if (config.minOrderAmount > 0 && (input.cartSubtotal || 0) < config.minOrderAmount) {
      return this.buildResult(
        FirstOrderEligibilityStatus.MINIMUM_ORDER_NOT_MET,
        `الحد الأدنى لقيمة الطلب للاستفادة من الشحن المجاني هو ${config.minOrderAmount} ر.ي`,
        `Minimum order amount for free shipping is ${config.minOrderAmount} YER`,
        config
      );
    }

    // 8. Delivery Method Eligibility Check
    if (input.deliveryMethod && config.allowedDeliveryMethods && config.allowedDeliveryMethods.length > 0) {
      const normalizedMethod = input.deliveryMethod.toLowerCase().trim();
      const isMethodAllowed = config.allowedDeliveryMethods.some(
        (m) => m.toLowerCase().trim() === normalizedMethod
      );
      if (!isMethodAllowed) {
        return this.buildResult(
          FirstOrderEligibilityStatus.DELIVERY_METHOD_NOT_SUPPORTED,
          'طريقة التوصيل المختارة غير مدعومة في عرض الشحن المجاني للطلب الأول',
          'Selected delivery method is not eligible for first order free shipping',
          config
        );
      }
    }

    // 9. Delivery Zone Eligibility Check
    if (config.allowedZones && config.allowedZones.length > 0) {
      const zoneId = input.deliveryZoneId;
      const zoneName = input.deliveryZoneName;
      const zoneMatch = config.allowedZones.some(
        (z) => z === zoneId || (zoneName && z.toLowerCase() === zoneName.toLowerCase())
      );
      if (!zoneMatch) {
        return this.buildResult(
          FirstOrderEligibilityStatus.OUTSIDE_ZONE,
          'منطقة التوصيل الحالية خارج نطاق عرض الشحن المجاني للطلب الأول',
          'Current delivery zone is outside the free shipping promotional area',
          config
        );
      }
    }

    // 10. Seller Participation Check
    if (
      input.sellerIds &&
      input.sellerIds.length > 0 &&
      config.allowedSellers &&
      config.allowedSellers.length > 0
    ) {
      const allSellersAllowed = input.sellerIds.every((sId) => config.allowedSellers.includes(sId));
      if (!allSellersAllowed) {
        return this.buildResult(
          FirstOrderEligibilityStatus.NOT_ELIGIBLE,
          'بعض المتاجر في السلة غير مشمولة في عرض الشحن المجاني للطلب الأول',
          'Some sellers in your cart are not eligible for this promotion',
          config
        );
      }
    }

    // 11. Fraud & Abuse Protection Engine
    if (config.abuseProtectionEnabled) {
      const abuseEval = await FirstOrderPromotionAbuseService.evaluateAbuseSignals({
        customerId: user.id,
        config,
        ipAddress: input.ipAddress,
        userAgent: input.userAgent,
        deviceId: input.deviceId,
      });

      if (abuseEval.abuseSuspected) {
        // Record audit telemetry
        await this.logEligibilityAudit(
          user.id,
          FirstOrderEligibilityStatus.ACCOUNT_RESTRICTED,
          'ABUSE_SUSPECTED',
          input,
          abuseEval
        );

        return {
          eligible: false,
          status: FirstOrderEligibilityStatus.ACCOUNT_RESTRICTED,
          messageAr: 'عذراً، لا يمكن تطبيق العرض على هذا الحساب وفقاً لسياسات الأمان',
          messageEn: 'Sorry, this promotion cannot be applied according to security policy',
          minOrderAmount: config.minOrderAmount,
          maxDiscount: config.maxDiscount,
          costBearer: config.costBearer,
          riskScore: abuseEval.riskScore,
          abuseSuspected: true,
        };
      }
    }

    // 12. Success — Customer is fully ELIGIBLE
    const result: FirstOrderEligibilityResult = {
      eligible: true,
      status: FirstOrderEligibilityStatus.ELIGIBLE,
      messageAr: 'مبارك! طلبك الأول مؤهل للحصول على شحن مجاني',
      messageEn: 'Congratulations! Your first order qualifies for FREE shipping',
      minOrderAmount: config.minOrderAmount,
      maxDiscount: config.maxDiscount,
      costBearer: config.costBearer,
      expiresAt: config.endAt || undefined,
    };

    // Log eligible check for audit & dashboard
    await this.logEligibilityAudit(user.id, FirstOrderEligibilityStatus.ELIGIBLE, 'SUCCESS', input);

    return result;
  }

  private static buildResult(
    status: FirstOrderEligibilityStatus,
    messageAr: string,
    messageEn: string,
    config: any
  ): FirstOrderEligibilityResult {
    return {
      eligible: false,
      status,
      messageAr,
      messageEn,
      minOrderAmount: config.minOrderAmount,
      maxDiscount: config.maxDiscount,
      costBearer: config.costBearer,
      expiresAt: config.endAt || undefined,
    };
  }

  private static async logEligibilityAudit(
    customerId: string,
    status: FirstOrderEligibilityStatus,
    reason: string,
    input: FirstOrderEligibilityInput,
    abuseEval?: any
  ): Promise<void> {
    try {
      await prisma.promotionEligibilityAudit.create({
        data: {
          customerId,
          promotionType: 'FIRST_ORDER_FREE_SHIPPING',
          status,
          reason,
          cartTotal: input.cartSubtotal || null,
          ipAddress: input.ipAddress || null,
          userAgent: input.userAgent || null,
          signals: abuseEval ? JSON.stringify(abuseEval.signals) : null,
        },
      });
    } catch {
      // Fire-and-forget; never break user flow on audit failure
    }
  }
}
