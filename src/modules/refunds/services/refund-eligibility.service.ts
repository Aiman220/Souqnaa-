import { prisma } from '../../../database/prisma';
import { AppError } from '../../../middleware/error.middleware';
import { RefundStatus, OrderStatus, PaymentStatus } from '@prisma/client';

export interface RefundableItemCheck {
  orderItemId: string;
  productId: string;
  productName: string;
  unitPrice: number;
  originalQuantity: number;
  voucherDiscount: number;
  effectiveItemTotal: number;
  alreadyRefundedQuantity: number;
  alreadyRefundedAmount: number;
  remainingRefundableQuantity: number;
  remainingRefundableAmount: number;
  isEligible: boolean;
  ineligibilityReason?: string;
}

export interface OrderRefundEligibility {
  orderId: string;
  orderNumber: string;
  orderStatus: OrderStatus;
  paymentStatus?: PaymentStatus;
  isEligible: boolean;
  ineligibilityReason?: string;
  deliveredAt?: string;
  refundDeadline?: string;
  remainingDays: number;
  remainingHours: number;
  remainingSeconds: number;
  currency: string;
  orderTotal: number;
  capturedAmount: number;
  alreadyRefundedTotal: number;
  pendingRefundTotal: number;
  remainingRefundableTotal: number;
  allowedRefundTypes: string[];
  activeRefundId?: string | null;
  items: RefundableItemCheck[];
}

export class RefundEligibilityService {
  private static DEFAULT_REFUND_WINDOW_DAYS = 14;

  /**
   * Evaluates order and item refundability, strictly enforcing the 14-day delivery policy.
   */
  static async checkOrderEligibility(
    orderId: string,
    customerId?: string
  ): Promise<OrderRefundEligibility> {
    const order = await prisma.order.findFirst({
      where: {
        OR: [{ id: orderId }, { orderNumber: orderId }],
        ...(customerId ? { userId: customerId } : {}),
      },
      include: {
        payment: true,
        sellerOrders: {
          include: {
            items: {
              include: {
                product: { select: { id: true, nameAr: true, nameEn: true, isActive: true } },
              },
            },
          },
        },
      },
    });

    if (!order) {
      throw new AppError('الطلب غير موجود أو لا تملك صلاحية الوصول إليه', 404);
    }

    // 1. Fetch Refund Policy Config
    let refundWindowDays = this.DEFAULT_REFUND_WINDOW_DAYS;
    let refundWindowEnabled = true;
    let allowPartialRefund = true;
    let allowFullRefund = true;

    try {
      const policy = await prisma.refundPolicyConfig.findFirst();
      if (policy) {
        refundWindowDays = policy.refundWindowDays;
        refundWindowEnabled = policy.refundWindowEnabled;
        allowPartialRefund = policy.allowPartialRefund;
        allowFullRefund = policy.allowFullRefund;
      }
    } catch (_) {}

    // Allowed refund types
    const allowedRefundTypes: string[] = [];
    if (allowFullRefund) allowedRefundTypes.push('FULL_ORDER');
    if (allowPartialRefund) {
      allowedRefundTypes.push(
        'PARTIAL_ORDER',
        'ITEM',
        'QUANTITY',
        'DAMAGED',
        'WRONG_ITEM',
        'MISSING_ITEM',
        'NOT_AS_DESCRIBED',
        'OTHER'
      );
    }

    // 2. Authoritative Delivery Validation (DELIVERED status & deliveredAt)
    const isDelivered = order.status === OrderStatus.DELIVERED;
    const deliveredAtDate = order.deliveredAt || (isDelivered ? order.updatedAt : null);

    // Calculate deadline using server UTC time
    let refundDeadlineDate: Date | null = null;
    let remainingMs = 0;
    let isWithinWindow = false;

    if (deliveredAtDate && refundWindowEnabled) {
      refundDeadlineDate = new Date(
        deliveredAtDate.getTime() + refundWindowDays * 24 * 60 * 60 * 1000
      );
      remainingMs = refundDeadlineDate.getTime() - Date.now();
      isWithinWindow = remainingMs > 0;
    }

    const remainingSeconds = Math.max(0, Math.floor(remainingMs / 1000));
    const remainingDays = Math.ceil(remainingSeconds / (24 * 3600));
    const remainingHours = Math.floor((remainingSeconds % (24 * 3600)) / 3600);

    // 3. Find existing refund requests
    const existingRefunds = await prisma.refundRequest.findMany({
      where: {
        orderId: order.id,
        status: {
          notIn: [RefundStatus.CANCELLED, RefundStatus.CLOSED, RefundStatus.EXPIRED],
        },
      },
      include: {
        items: true,
      },
    });

    // Check active pending refund request on the order
    const activeRefund = existingRefunds.find(
      (r) =>
        r.status !== RefundStatus.REFUND_COMPLETED &&
        r.status !== RefundStatus.REFUNDED &&
        r.status !== RefundStatus.CANCELLED &&
        r.status !== RefundStatus.CLOSED
    );

    // 4. Determine eligibility reason
    let orderIneligibleReason: string | undefined;

    if (!isDelivered) {
      orderIneligibleReason =
        'يمكن طلب الاسترجاع فقط بعد توصيل الطلب واستلامه بالكامل (DELIVERED).';
    } else if (refundWindowEnabled && !isWithinWindow) {
      orderIneligibleReason =
        'انتهت مدة طلب الاسترجاع أو الاسترداد لهذا الطلب (REFUND_WINDOW_EXPIRED). الحد الأقصى المسموح به هو 14 يوماً من تاريخ التوصيل.';
    } else if (activeRefund) {
      orderIneligibleReason =
        'يوجد طلب استرجاع قيد المعالجة حالياً لهذا الطلب. لا يمكن تقديم أكثر من طلب استرجاع نشط في نفس الوقت.';
    }

    // 5. Item-level calculations and vouchers accounting
    const itemEligibilityList: RefundableItemCheck[] = [];
    let totalSuccessfulRefunded = 0;
    let totalPendingRefund = 0;
    let totalOrderRemaining = 0;

    for (const sellerOrder of order.sellerOrders) {
      for (const item of sellerOrder.items) {
        const itemRefundRequests = existingRefunds.flatMap((r) =>
          r.items.filter((ri) => ri.orderItemId === item.id)
        );

        let alreadyRefundedQty = 0;
        let alreadyRefundedAmount = 0;
        let pendingRefundQty = 0;
        let pendingRefundAmount = 0;

        for (const rItem of itemRefundRequests) {
          const parentRefund = existingRefunds.find((r) => r.id === rItem.refundRequestId);
          if (!parentRefund) continue;

          if (
            parentRefund.status === RefundStatus.REFUND_COMPLETED ||
            parentRefund.status === RefundStatus.REFUNDED
          ) {
            alreadyRefundedQty += rItem.quantity;
            alreadyRefundedAmount += rItem.approvedAmount ?? rItem.requestedAmount;
          } else {
            pendingRefundQty += rItem.quantity;
            pendingRefundAmount += rItem.requestedAmount;
          }
        }

        const effectiveTotal = Math.max(0, item.totalPrice - (item.voucherDiscountAmount || 0));
        const remainingQty = Math.max(0, item.quantity - alreadyRefundedQty - pendingRefundQty);
        const remainingAmount = Math.max(0, effectiveTotal - alreadyRefundedAmount - pendingRefundAmount);

        let itemEligible = !orderIneligibleReason && remainingQty > 0 && remainingAmount > 0;
        let itemReason: string | undefined = orderIneligibleReason;

        if (pendingRefundQty > 0) {
          itemEligible = false;
          itemReason = 'يوجد طلب استرجاع نشط قيد المراجعة حالياً لهذا المنتج';
        } else if (remainingQty <= 0 || remainingAmount <= 0) {
          itemEligible = false;
          itemReason = 'تم استرداد كامل قيمة هذا المنتج مسبقاً';
        }

        totalSuccessfulRefunded += alreadyRefundedAmount;
        totalPendingRefund += pendingRefundAmount;
        totalOrderRemaining += remainingAmount;

        itemEligibilityList.push({
          orderItemId: item.id,
          productId: item.productId,
          productName: item.productNameAr || item.productNameEn,
          unitPrice: item.unitPrice,
          originalQuantity: item.quantity,
          voucherDiscount: item.voucherDiscountAmount || 0,
          effectiveItemTotal: effectiveTotal,
          alreadyRefundedQuantity: alreadyRefundedQty,
          alreadyRefundedAmount,
          remainingRefundableQuantity: remainingQty,
          remainingRefundableAmount: remainingAmount,
          isEligible: itemEligible,
          ineligibilityReason: itemReason,
        });
      }
    }

    const capturedAmount = order.payment?.amount ?? order.total;
    const authoritativeRemaining = Math.max(
      0,
      parseFloat((capturedAmount - totalSuccessfulRefunded - totalPendingRefund).toFixed(2))
    );

    const hasAnyEligibleItem = itemEligibilityList.some((i) => i.isEligible);
    const finalOrderEligible = !orderIneligibleReason && hasAnyEligibleItem && authoritativeRemaining > 0;

    return {
      orderId: order.id,
      orderNumber: order.orderNumber,
      orderStatus: order.status,
      paymentStatus: order.payment?.status,
      isEligible: finalOrderEligible,
      ineligibilityReason:
        orderIneligibleReason ?? (hasAnyEligibleItem ? undefined : 'لا توجد منتجات مؤهلة للاسترجاع في هذا الطلب'),
      deliveredAt: deliveredAtDate ? deliveredAtDate.toISOString() : undefined,
      refundDeadline: refundDeadlineDate ? refundDeadlineDate.toISOString() : undefined,
      remainingDays,
      remainingHours,
      remainingSeconds,
      currency: order.currency,
      orderTotal: order.total,
      capturedAmount,
      alreadyRefundedTotal: totalSuccessfulRefunded,
      pendingRefundTotal: totalPendingRefund,
      remainingRefundableTotal: authoritativeRemaining,
      allowedRefundTypes,
      activeRefundId: activeRefund?.id || null,
      items: itemEligibilityList,
    };
  }

  /**
   * Validates requested refund payload against database truth.
   * Throws AppError with code REFUND_WINDOW_EXPIRED if window expired.
   */
  static async validateRequestedItems(
    orderId: string,
    customerId: string,
    requestedItems: Array<{ orderItemId: string; quantity: number; requestedAmount?: number }>
  ): Promise<{
    order: any;
    sellerId: string;
    sellerOrderId: string;
    validatedItems: Array<{
      orderItemId: string;
      productId: string;
      variantId?: string | null;
      quantity: number;
      authoritativeRefundAmount: number;
    }>;
    totalAuthoritativeAmount: number;
  }> {
    if (!requestedItems || requestedItems.length === 0) {
      throw new AppError('يجب تحديد منتج واحد على الأقل للاسترجاع', 400);
    }

    const eligibility = await this.checkOrderEligibility(orderId, customerId);

    if (!eligibility.isEligible) {
      if (eligibility.remainingSeconds <= 0 && eligibility.orderStatus === OrderStatus.DELIVERED) {
        throw new AppError(
          'انتهت مدة طلب الاسترجاع أو الاسترداد لهذا الطلب (REFUND_WINDOW_EXPIRED).',
          400
        );
      }
      throw new AppError(
        eligibility.ineligibilityReason || 'هذا الطلب غير مؤهل للاسترجاع حالياً',
        400
      );
    }

    const order = await prisma.order.findUnique({
      where: { id: eligibility.orderId },
      include: {
        payment: true,
        sellerOrders: {
          include: {
            items: true,
            seller: true,
          },
        },
      },
    });

    if (!order) throw new AppError('الطلب غير موجود', 404);

    let totalAmount = 0;
    const validatedItems = [];
    let detectedSellerId: string | null = null;
    let detectedSellerOrderId: string | null = null;

    for (const reqItem of requestedItems) {
      const eligibleItem = eligibility.items.find((i) => i.orderItemId === reqItem.orderItemId);
      if (!eligibleItem) {
        throw new AppError(`المنتج المحدد [${reqItem.orderItemId}] لا ينتمي لهذا الطلب`, 400);
      }

      if (!eligibleItem.isEligible) {
        throw new AppError(
          `المنتج [${eligibleItem.productName}] غير مؤهل للاسترجاع: ${eligibleItem.ineligibilityReason}`,
          400
        );
      }

      if (reqItem.quantity <= 0 || reqItem.quantity > eligibleItem.remainingRefundableQuantity) {
        throw new AppError(
          `الكمية المطلوبة (${reqItem.quantity}) للمنتج [${eligibleItem.productName}] تتجاوز الكمية المتبقية القابلة للاسترجاع (${eligibleItem.remainingRefundableQuantity})`,
          400
        );
      }

      let dbOrderItem: any = null;
      let parentSellerOrder: any = null;
      for (const so of order.sellerOrders) {
        const found = so.items.find((it) => it.id === reqItem.orderItemId);
        if (found) {
          dbOrderItem = found;
          parentSellerOrder = so;
          break;
        }
      }

      if (!dbOrderItem || !parentSellerOrder) {
        throw new AppError('فشل العثور على سجل المنتج في تفاصيل متجر الطلب', 400);
      }

      if (!detectedSellerId) {
        detectedSellerId = parentSellerOrder.sellerId;
        detectedSellerOrderId = parentSellerOrder.id;
      } else if (detectedSellerId !== parentSellerOrder.sellerId) {
        throw new AppError(
          'لا يمكن تقديم طلب استرجاع موحد لمنتجات تتبع متاجر مختلفة في طلب واحد. يرجى تقديم طلب استرجاع منفصل لكل متجر.',
          400
        );
      }

      const unitEffectivePrice = eligibleItem.effectiveItemTotal / eligibleItem.originalQuantity;
      const computedItemRefund = Math.min(
        eligibleItem.remainingRefundableAmount,
        parseFloat((unitEffectivePrice * reqItem.quantity).toFixed(2))
      );

      if (reqItem.requestedAmount && reqItem.requestedAmount > computedItemRefund + 0.01) {
        throw new AppError(
          `المبلغ المطلوب للمنتج [${eligibleItem.productName}] (${reqItem.requestedAmount}) يتجاوز الحد الأقصى المسموح به (${computedItemRefund})`,
          400
        );
      }

      totalAmount += computedItemRefund;
      validatedItems.push({
        orderItemId: dbOrderItem.id,
        productId: dbOrderItem.productId,
        variantId: dbOrderItem.variantId,
        quantity: reqItem.quantity,
        authoritativeRefundAmount: computedItemRefund,
      });
    }

    if (totalAmount > eligibility.remainingRefundableTotal + 0.01) {
      throw new AppError(
        `إجمالي المبلغ المطلوب (${totalAmount}) يتجاوز الحد المتبقي القابل للاسترجاع في هذا الطلب (${eligibility.remainingRefundableTotal})`,
        400
      );
    }

    return {
      order,
      sellerId: detectedSellerId!,
      sellerOrderId: detectedSellerOrderId!,
      validatedItems,
      totalAuthoritativeAmount: parseFloat(totalAmount.toFixed(2)),
    };
  }
}
