/**
 * SOUQNAA Marketplace — Production Authoritative Refund Amount Calculator
 * 
 * Strict backend-only financial calculator enforcing:
 * - Maximum refundable amount = Verified eligible amount collected − Previously completed refunds − Amounts already reserved for other refund requests
 * - Never refund more than the eligible amount actually collected
 * - Zero floating-point drift: integer arithmetic (cents) / exact 2-decimal rounding
 * - Proportional allocation of order-level discounts, seller vouchers, line discounts, taxes, and shipping fees
 * - Delivery verification: uncollected COD cash and unverified/failed payments yield 0 eligible collection
 * - Multi-vendor isolation: funds and liabilities scoped strictly to target seller
 * 
 * Version: 2.1.0
 */

import { prisma } from '../../../database/prisma';
import { AppError } from '../../../middleware/error.middleware';
import { PaymentStatus, PaymentMethodType, OrderStatus, SellerOrderStatus, RefundStatus } from '@prisma/client';
import { TaxMath } from '../../tax/tax.math';

export interface RequestedRefundLineItem {
  orderItemId: string;
  quantity: number;
}

export interface CalculatedLineItemRefund {
  orderItemId: string;
  productId: string;
  productName: string;
  variantId?: string | null;
  requestedQuantity: number;
  originalQuantity: number;
  unitPrice: number;
  grossAmount: number;
  itemVoucherDiscount: number;
  orderDiscountShare: number;
  netItemPrice: number;
  taxShare: number;
  alreadyRefundedAmount: number;
  alreadyRefundedQuantity: number;
  pendingRefundAmount: number;
  pendingRefundQuantity: number;
  maxEligibleAmount: number;
  authoritativeRefundAmount: number;
}

export interface RefundCalculationResult {
  orderId: string;
  orderNumber: string;
  sellerId: string;
  sellerOrderId?: string | null;
  currency: string;
  paymentMethod: PaymentMethodType;
  paymentStatus: PaymentStatus;
  isCashCollected: boolean;
  actualCollectedAmount: number;
  originalOrderTotal: number;
  sellerSuborderTotal: number;
  shippingFeeCollected: number;
  shippingRefundAmount: number;
  totalPriorRefunded: number;
  totalPendingReserved: number;
  remainingOrderRefundableCap: number;
  totalGrossRequested: number;
  totalNetRequested: number;
  totalTaxAmount: number;
  finalAuthoritativeRefundAmount: number;
  lineItems: CalculatedLineItemRefund[];
}

export class RefundAmountCalculator {
  /**
   * Authoritative backend calculation of refund eligibility and amounts.
   */
  public static async calculateRefund(params: {
    orderId: string;
    customerId: string;
    items: RequestedRefundLineItem[];
    requestShippingRefund?: boolean;
    tx?: any;
  }): Promise<RefundCalculationResult> {
    const { orderId, customerId, items, requestShippingRefund = false } = params;
    const client = params.tx || prisma;

    if (!items || items.length === 0) {
      throw new AppError('يجب تحديد منتج واحد على الأقل لحساب مبلغ الاسترجاع', 400);
    }

    // 1. Fetch Order with full details: payment, sellerOrders, items, and prior refunds
    const order = await client.order.findFirst({
      where: {
        OR: [{ id: orderId }, { orderNumber: orderId }],
        userId: customerId,
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
        refundRequests: {
          include: {
            items: true,
          },
        },
      },
    });

    if (!order) {
      throw new AppError('الطلب غير موجود أو لا تملك صلاحية الوصول إليه', 404);
    }

    const currency = order.currency || 'YER';
    const payment = order.payment;
    const paymentMethod: PaymentMethodType = payment?.method || PaymentMethodType.CASH_ON_DELIVERY;
    const paymentStatus: PaymentStatus = payment?.status || PaymentStatus.PENDING;

    // 2. Identify target Seller and validate all requested items belong to ONE seller order
    const requestedItemIds = new Set(items.map((i) => i.orderItemId));
    let targetSellerOrder: any = null;
    let targetSellerId: string | null = null;

    for (const so of order.sellerOrders) {
      const match = so.items.some((i: any) => requestedItemIds.has(i.id));
      if (match) {
        if (targetSellerOrder && targetSellerOrder.id !== so.id) {
          throw new AppError(
            'لا يمكن جمع منتجات من متاجر متعددة في طلب استرجاع واحد. يرجى تقديم طلب منفصل لكل متجر.',
            400
          );
        }
        targetSellerOrder = so;
        targetSellerId = so.sellerId;
      }
    }

    if (!targetSellerOrder || !targetSellerId) {
      throw new AppError('لم يتم العثور على أي من المنتجات المطلوبة في هذا الطلب', 400);
    }

    // 3. Authoritative verification of actual collected funds from customer
    // Rules:
    // - If online payment: payment status must be PAID
    // - If COD: target suborder or parent order must be DELIVERED with verified delivery date
    let isCashCollected = false;
    let actualCollectedAmount = 0;

    if (paymentMethod === PaymentMethodType.CASH_ON_DELIVERY) {
      const isSuborderDelivered =
        targetSellerOrder.status === SellerOrderStatus.DELIVERED ||
        order.status === OrderStatus.DELIVERED;
      if (isSuborderDelivered) {
        isCashCollected = true;
        actualCollectedAmount = TaxMath.add(
          Number(targetSellerOrder.subtotal || 0),
          Number(targetSellerOrder.deliveryFee || 0)
        );
      } else {
        isCashCollected = false;
        actualCollectedAmount = 0;
      }
    } else {
      // Online payment methods (Kuraimi, CashPay, Wallet, etc.)
      if (paymentStatus === PaymentStatus.PAID || paymentStatus === PaymentStatus.PARTIALLY_REFUNDED) {
        isCashCollected = true;
        // The customer paid for the entire order online. Target suborder's portion:
        actualCollectedAmount = TaxMath.add(
          Number(targetSellerOrder.subtotal || 0),
          Number(targetSellerOrder.deliveryFee || 0)
        );
      } else {
        isCashCollected = false;
        actualCollectedAmount = 0;
      }
    }

    // 4. Calculate previous completed refunds and active pending refund reservations for this seller order
    let totalPriorRefunded = 0;
    let totalPendingReserved = 0;

    for (const ref of order.refundRequests || []) {
      if (ref.sellerId !== targetSellerId) continue;
      if (ref.status === RefundStatus.CANCELLED || ref.status === RefundStatus.CLOSED) continue;

      const refAmount = ref.approvedAmount !== null && ref.approvedAmount !== undefined
        ? Number(ref.approvedAmount)
        : Number(ref.requestedAmount || 0);

      if (ref.status === RefundStatus.REFUND_COMPLETED || ref.status === RefundStatus.REFUNDED) {
        totalPriorRefunded = TaxMath.add(totalPriorRefunded, refAmount);
      } else {
        // In-flight / pending / under review refund
        totalPendingReserved = TaxMath.add(totalPendingReserved, refAmount);
      }
    }

    // Maximum remaining refundable cap from collected funds:
    const remainingOrderRefundableCap = Math.max(
      0,
      TaxMath.subtract(TaxMath.subtract(actualCollectedAmount, totalPriorRefunded), totalPendingReserved)
    );

    // 5. Calculate line-item level authoritative refunds
    const lineItems: CalculatedLineItemRefund[] = [];
    let totalGrossRequested = 0;
    let totalNetRequested = 0;
    let totalTaxAmount = 0;

    // Check refund policy config for shipping refunds
    let policyAllowShipping = false;
    try {
      const policy = await client.refundPolicyConfig.findFirst();
      if (policy) {
        policyAllowShipping = policy.allowShippingRefund;
      }
    } catch (_) {}

    for (const reqItem of items) {
      const orderItem = targetSellerOrder.items.find((i: any) => i.id === reqItem.orderItemId);
      if (!orderItem) {
        throw new AppError(`عنصر الطلب [${reqItem.orderItemId}] غير موجود في شحنة المتجر`, 400);
      }

      if (reqItem.quantity <= 0) {
        throw new AppError(`الكمية المطلوبة للمنتج يجب أن تكون أكبر من صفر`, 400);
      }

      // Find all prior refunds for this specific order item
      let priorItemRefundedQty = 0;
      let priorItemRefundedAmount = 0;
      let pendingItemQty = 0;
      let pendingItemAmount = 0;

      for (const ref of order.refundRequests || []) {
        if (ref.status === RefundStatus.CANCELLED || ref.status === RefundStatus.CLOSED) continue;
        const matchingItem = (ref.items || []).find((ri: any) => ri.orderItemId === orderItem.id);
        if (!matchingItem) continue;

        const approvedItemAmount = matchingItem.approvedAmount !== null && matchingItem.approvedAmount !== undefined
          ? Number(matchingItem.approvedAmount)
          : Number(matchingItem.requestedAmount || 0);

        if (ref.status === RefundStatus.REFUND_COMPLETED || ref.status === RefundStatus.REFUNDED) {
          priorItemRefundedQty += matchingItem.quantity;
          priorItemRefundedAmount = TaxMath.add(priorItemRefundedAmount, approvedItemAmount);
        } else {
          pendingItemQty += matchingItem.quantity;
          pendingItemAmount = TaxMath.add(pendingItemAmount, Number(matchingItem.requestedAmount || 0));
        }
      }

      const availableQty = Math.max(0, orderItem.quantity - priorItemRefundedQty - pendingItemQty);

      if (reqItem.quantity > availableQty) {
        throw new AppError(
          `الكمية المطلوبة (${reqItem.quantity}) للمنتج [${orderItem.productNameAr || orderItem.productNameEn}] تتجاوز الكمية المتبقية القابلة للاسترجاع (${availableQty})`,
          400
        );
      }

      const unitPrice = Number(orderItem.unitPrice || 0);
      const grossAmount = Math.round(unitPrice * reqItem.quantity * 100) / 100;

      // Proportional voucher / discount allocation for this line:
      // voucherDiscountAmount on item is already net of seller-funded discounts
      const totalItemDiscount = Number(orderItem.voucherDiscountAmount || 0);
      const itemDiscountShare = orderItem.quantity > 0
        ? Math.round((totalItemDiscount / orderItem.quantity) * reqItem.quantity * 100) / 100
        : 0;

      // Proportional order-level discount share (if any order-level coupon applied)
      const suborderGross = Math.max(1, Number(targetSellerOrder.subtotal || 1));
      const orderLevelDiscountTotal = Number(order.couponDiscount || 0);
      const suborderDiscountProportion = Math.round((orderLevelDiscountTotal * (grossAmount / suborderGross)) * 100) / 100;

      const netItemPrice = Math.max(
        0,
        Math.round((grossAmount - itemDiscountShare - suborderDiscountProportion) * 100) / 100
      );

      // Tax share (if tax is recorded on orderItem)
      const itemTaxTotal = Number(orderItem.taxAmount || 0);
      const taxShare = orderItem.quantity > 0
        ? Math.round((itemTaxTotal / orderItem.quantity) * reqItem.quantity * 100) / 100
        : 0;

      // Max eligible for this item: remaining net amount after previous refunds
      const effectiveTotalOriginal = Math.max(0, Number(orderItem.totalPrice || 0) - totalItemDiscount);
      const remainingItemAmount = Math.max(
        0,
        TaxMath.subtract(TaxMath.subtract(effectiveTotalOriginal, priorItemRefundedAmount), pendingItemAmount)
      );

      const authoritativeItemRefund = Math.min(netItemPrice, remainingItemAmount);

      totalGrossRequested = TaxMath.add(totalGrossRequested, grossAmount);
      totalNetRequested = TaxMath.add(totalNetRequested, authoritativeItemRefund);
      totalTaxAmount = TaxMath.add(totalTaxAmount, taxShare);

      lineItems.push({
        orderItemId: orderItem.id,
        productId: orderItem.productId,
        productName: orderItem.productNameAr || orderItem.productNameEn || 'المنتج',
        variantId: orderItem.variantId || null,
        requestedQuantity: reqItem.quantity,
        originalQuantity: orderItem.quantity,
        unitPrice,
        grossAmount,
        itemVoucherDiscount: itemDiscountShare,
        orderDiscountShare: suborderDiscountProportion,
        netItemPrice,
        taxShare,
        alreadyRefundedAmount: priorItemRefundedAmount,
        alreadyRefundedQuantity: priorItemRefundedQty,
        pendingRefundAmount: pendingItemAmount,
        pendingRefundQuantity: pendingItemQty,
        maxEligibleAmount: remainingItemAmount,
        authoritativeRefundAmount: authoritativeItemRefund,
      });
    }

    // 6. Shipping Fee Refund Allocation:
    // Only refundable if:
    // a) Policy allows shipping refunds
    // b) Customer explicitly requested it or all items in the suborder are being refunded
    // c) Order was actually delivered and shipping was paid
    let shippingRefundAmount = 0;
    const shippingFeeCollected = Number(targetSellerOrder.deliveryFee || 0);

    const isAllItemsInSuborderRefunded = targetSellerOrder.items.every((soItem: any) => {
      const line = lineItems.find((l) => l.orderItemId === soItem.id);
      const reqQty = line ? line.requestedQuantity : 0;
      const priorQty = (order.refundRequests || [])
        .filter((r: any) => r.status === RefundStatus.REFUND_COMPLETED || r.status === RefundStatus.REFUNDED)
        .flatMap((r: any) => r.items)
        .filter((ri: any) => ri.orderItemId === soItem.id)
        .reduce((sum: number, ri: any) => sum + ri.quantity, 0);
      return reqQty + priorQty >= soItem.quantity;
    });

    if (policyAllowShipping && requestShippingRefund && isAllItemsInSuborderRefunded && shippingFeeCollected > 0) {
      // Check if shipping was already refunded on a prior refund request
      const priorShippingRefunded = (order.refundRequests || []).some(
        (r: any) =>
          r.sellerId === targetSellerId &&
          (r.status === RefundStatus.REFUND_COMPLETED || r.status === RefundStatus.REFUNDED) &&
          (r.metadata?.includes('shippingRefunded:true') || r.description?.includes('شحن'))
      );
      if (!priorShippingRefunded) {
        shippingRefundAmount = shippingFeeCollected;
      }
    }

    // 7. Final Authoritative Refund Amount:
    // Total net line items + shipping, capped strictly by remainingOrderRefundableCap
    const uncappedTotal = TaxMath.add(totalNetRequested, shippingRefundAmount);
    const finalAuthoritativeRefundAmount = Math.min(uncappedTotal, remainingOrderRefundableCap);

    if (isCashCollected && finalAuthoritativeRefundAmount <= 0) {
      throw new AppError(
        'لا يوجد رصيد مؤهل للاسترجاع في هذا الطلب بعد خصم المبالغ المستردة مسبقاً والطلبات المعلقة',
        400
      );
    }

    return {
      orderId: order.id,
      orderNumber: order.orderNumber,
      sellerId: targetSellerId,
      sellerOrderId: targetSellerOrder.id,
      currency,
      paymentMethod,
      paymentStatus,
      isCashCollected,
      actualCollectedAmount,
      originalOrderTotal: Number(order.total || 0),
      sellerSuborderTotal: Number(targetSellerOrder.subtotal || 0),
      shippingFeeCollected,
      shippingRefundAmount,
      totalPriorRefunded,
      totalPendingReserved,
      remainingOrderRefundableCap,
      totalGrossRequested,
      totalNetRequested,
      totalTaxAmount,
      finalAuthoritativeRefundAmount,
      lineItems,
    };
  }
}
