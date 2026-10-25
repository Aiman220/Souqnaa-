import { Router, Request, Response, NextFunction } from 'express';
import { config } from '../../config';
import { prisma } from '../../database/prisma';
import { redis } from '../../database/redis';
import { authenticate } from '../../middleware/auth.middleware';
import { ResponseUtil } from '../../utils/response.util';
import { AppError } from '../../middleware/error.middleware';
import { checkoutLimiter } from '../../middleware/rate-limiter.middleware';
import {
  OrderStatus,
  SellerOrderStatus,
  PaymentMethodType,
  PaymentStatus,
  DisputeStatus,
  CancellationRequestStatus,
  ReturnRequestStatus,
  RefundStatus,
  RefundActorType,
  NotificationType,
} from '@prisma/client';
import { OrderStateMachine } from './order.state-machine';
import { SocketService } from '../../services/websocket/socket.service';
import { deliveryQuoteService } from '../../services/delivery/delivery-quote.service';
import { deliverySlotService } from '../../services/delivery/delivery-slot.service';
import { flashSaleService } from '../flash-sales/flash-sale.service';
import { VoucherCalculationService } from '../vouchers/services/voucher-calculation.service';
import { VoucherRedemptionService } from '../vouchers/services/voucher-redemption.service';
import { VoucherFundingService } from '../vouchers/services/voucher-funding.service';
import { CartEvaluationItem } from '../vouchers/voucher.types';
import { CustomerWalletService } from '../wallet/customer-wallet.service';
import { OrderNumberService } from '../../services/orders/order-number.service';
import { OrderInvoiceService } from '../../services/orders/order-invoice.service';
import { RewardsLedgerService } from '../rewards/services/rewards-ledger.service';
import { RewardsConfigService } from '../rewards/services/rewards-config.service';
import { TaxEngine } from '../tax/tax.service';
import { TaxMath } from '../tax/tax.math';
import { RewardTxType, RewardTxSource } from '../rewards/rewards.types';
import { remoteConfigService } from '../remote-config/remote-config.service';
import { SellerFinancialRiskService } from '../commission/seller-financial-risk.service';
import { notificationEventBus } from '../notifications/services/event-bus';
import { notificationDispatcher } from '../notifications/services/notification-dispatcher';
import { NotificationEventFactory } from '../notifications/events/domain-events';
import { FirstOrderFreeShippingEligibilityService } from '../promotions/services/first-order-eligibility.service';
import { FirstOrderPromotionReservationService } from '../promotions/services/first-order-reservation.service';
import { FirstOrderShippingCalculation } from '../promotions/first-order-shipping.types';
import { UniversalShippingPromotionService } from '../promotions/services/universal-shipping-promotion.service';
import { ShippingPromotionReservationEngine } from '../promotions/services/shipping-promotion-reservation.engine';
import { ShippingFundingBreakdown } from '../promotions/universal-shipping-promotion.types';
import { CartAbandonmentJob } from '../../services/jobs/cart-abandonment.job';

const router = Router();
router.use(authenticate);

// ==============================================================================
// 0. GET AUTHORITATIVE CHECKOUT PAYMENT METHODS (GET /api/v1/orders/checkout-payment-methods)
// ==============================================================================
router.get('/checkout-payment-methods', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const evaluationContext = { userId: req.user!.userId };
    const { sellerId, productId } = req.query;

    const sellerIds = new Set<string>();
    if (sellerId) {
      sellerIds.add(String(sellerId));
    } else if (productId) {
      const prod = await prisma.product.findUnique({
        where: { id: String(productId) },
        include: { store: { select: { sellerId: true } } },
      });
      if (prod?.store?.sellerId) sellerIds.add(prod.store.sellerId);
    } else {
      const cart = await prisma.cart.findUnique({
        where: { userId: req.user!.userId },
        include: {
          items: {
            include: {
              product: {
                include: {
                  store: { select: { id: true, sellerId: true, isActive: true } },
                },
              },
            },
          },
        },
      });

      if (cart?.items) {
        for (const item of cart.items) {
          const sId = item.product.store?.sellerId;
          if (sId) sellerIds.add(sId);
        }
      }
    }

    const isWalletsActive = await remoteConfigService.isFeatureActive('electronic_wallet_providers', evaluationContext);

    // Evaluate authoritative COD eligibility across all sellers in cart
    const codEval = await SellerFinancialRiskService.evaluateCodEligibility({
      sellerIds: Array.from(sellerIds),
      customerId: req.user!.userId,
    });

    const methods: Array<{
      code: string;
      nameAr: string;
      nameEn: string;
      isAvailable: boolean;
      badge?: string;
      reason?: string;
    }> = [
      {
        code: 'SOUQNAAPAY',
        nameAr: 'محفظة سوقناا باي (SOUQNApay)',
        nameEn: 'SOUQNApay Wallet',
        isAvailable: true,
        badge: 'دفع فوري ⚡',
      },
      {
        code: 'YEMENI_WALLET',
        nameAr: 'المحافظ الإلكترونية اليمنية (حاسب، جوالي، ون كاش...)',
        nameEn: 'Yemeni Electronic Wallets',
        isAvailable: isWalletsActive,
        badge: 'تحويل مباشر 🏦',
        reason: isWalletsActive ? undefined : 'خدمة المحافظ الإلكترونية معطلة مؤقتاً',
      },
      {
        code: 'COD',
        nameAr: 'الدفع عند الاستلام (COD)',
        nameEn: 'Cash on Delivery',
        isAvailable: codEval.isCodAvailable,
        badge: 'كاش 💵',
        reason: codEval.reason,
      },
    ];

    ResponseUtil.success(res, {
      paymentMethods: methods,
      isCodAvailable: codEval.isCodAvailable,
      codReason: codEval.reason,
      sellerStatus: codEval.sellerStatus,
    });
  } catch (error) {
    next(error);
  }
});

// ==============================================================================
// 1. CREATE MULTI-VENDOR ORDER (POST /api/v1/orders)
// ==============================================================================
router.post('/', checkoutLimiter, async (req: Request, res: Response, next: NextFunction) => {
  let universalReservationId: string | null = null;
  let firstOrderReservationId: string | null = null;
  try {
    const {
      addressId,
      deliveryMethodCode = 'standard',
      deliveryScheduleType = 'ASAP',
      deliveryDate,
      deliveryTimeSlotId,
      paymentMethod = 'CASH_ON_DELIVERY',
      notes,
      voucherCodes: rawVoucherCodes,
      walletProvider,
      walletSenderNumber,
      walletTransactionRef,
      walletReceiptUrl,
      // SOUQNAA Coins Integration
      useCoins = false,
      coinsToUse,
      coinsUsed,
      coinReservationId,
      coinQuoteId,
      // Purchase Mode & Cart Isolation
      purchaseMode = 'CART_CHECKOUT',
      buyNowItem,
      selectedCartItemIds,
    } = req.body;

    // Check Idempotency Key (prevent duplicate orders on double taps / network retries)
    const idempotencyKey = (
      (req.headers['x-idempotency-key'] as string) ||
      (req.headers['idempotency-key'] as string) ||
      req.body.idempotencyKey ||
      req.body.checkout_idempotency_key ||
      req.body.checkoutIdempotencyKey ||
      ''
    ).trim();

    if (idempotencyKey) {
      const existingOrder = await prisma.order.findFirst({
        where: {
          idempotencyKey,
          userId: req.user!.userId,
        },
        include: {
          sellerOrders: {
            include: {
              seller: { include: { stores: { select: { name: true, logo: true } } } },
              items: {
                include: {
                  product: {
                    select: {
                      id: true,
                      nameAr: true,
                      nameEn: true,
                      images: { select: { url: true }, orderBy: { sortOrder: 'asc' }, take: 1 },
                    },
                  },
                  variant: { select: { id: true, image: true } },
                },
              },
            },
          },
          addressSnapshot: true,
          payment: true,
          statusHistory: { orderBy: { createdAt: 'asc' } },
        },
      });

      if (existingOrder) {
        const enrichedExistingOrder = {
          ...existingOrder,
          sellerOrders: (existingOrder.sellerOrders || []).map((so) => ({
            ...so,
            items: (so.items || []).map((item: any) => ({
              ...item,
              productImage: item.variant?.image || item.product?.images?.[0]?.url || item.productImage || null,
            })),
          })),
        };
        return ResponseUtil.success(res, enrichedExistingOrder, 'تم استرجاع الطلب المنفذ مسبقاً بنجاح');
      }
    }

    // 1. Resolve Address with fallback
    let address = null;
    if (addressId) {
      address = await prisma.address.findFirst({
        where: { id: addressId, userId: req.user!.userId },
        include: { city: true, district: true },
      });
    }
    if (!address) {
      address = await prisma.address.findFirst({
        where: { userId: req.user!.userId },
        include: { city: true, district: true },
        orderBy: { isDefault: 'desc' },
      });
    }
    if (!address) {
      if (process.env.NODE_ENV === 'production') {
        throw new AppError('يرجى تحديد أو إضافة عنوان توصيل لإتمام الطلب.', 400, 'ADDRESS_REQUIRED');
      }
      let defaultCity = await prisma.city.findFirst();
      if (!defaultCity) {
        let defaultCountry = await prisma.country.findFirst();
        if (!defaultCountry) {
          defaultCountry = await prisma.country.create({
            data: { code: 'YE', nameAr: 'الجمهورية اليمنية', nameEn: 'Yemen' },
          });
        }
        defaultCity = await prisma.city.create({
          data: { nameAr: 'صنعاء', nameEn: 'Sanaa', countryId: defaultCountry.id },
        });
      }
      address = await prisma.address.create({
        data: {
          userId: req.user!.userId,
          recipientName: req.user!.email?.split('@')[0] || 'عميل سوقناا',
          recipientPhone: '770000000',
          street: 'شارع الزبيري',
          cityId: defaultCity.id,
          isDefault: true,
        },
        include: { city: true, district: true },
      });
    }

    const defaultCommissionSetting = await prisma.systemSetting.findUnique({
      where: { key: 'default_commission_rate' },
    });
    const defaultCommissionRate = defaultCommissionSetting
      ? parseFloat(defaultCommissionSetting.value)
      : 0.10;

    let cart: any = null;
    let orderCheckoutItems: any[] = [];
    const isBuyNowFlow = String(purchaseMode || '').toUpperCase() === 'BUY_NOW';

    if (isBuyNowFlow) {
      if (!buyNowItem || !buyNowItem.productId) {
        throw new AppError('تفاصيل منتج الشراء المباشر غير متوفرة', 400);
      }
      const buyQty = parseInt(String(buyNowItem.quantity), 10) || 1;
      if (buyQty <= 0) {
        throw new AppError('الكمية المطلوبة يجب أن تكون قطعة واحدة على الأقل', 400);
      }

      const product = await prisma.product.findUnique({
        where: { id: String(buyNowItem.productId) },
        include: {
          category: true,
          store: { include: { seller: true } },
          inventory: true,
          variants: true,
        },
      });

      if (!product || !product.isActive) {
        throw new AppError('المنتج المطلوب للشراء غير متاح حالياً', 400);
      }

      let variant = null;
      if (buyNowItem.variantId) {
        variant = product.variants.find((v) => v.id === String(buyNowItem.variantId));
        if (!variant) {
          throw new AppError('خيار المنتج المحدد غير متوفر', 400);
        }
      }

      const availableStock = variant
        ? variant.stockQuantity
        : (product.inventory ? Math.max(0, product.inventory.quantity - (product.inventory.reserved || 0)) : 0);

      if (availableStock < buyQty) {
        throw new AppError(`عذراً، الكمية المطلوبة غير متوفرة في المخزون (المتبقي: ${availableStock})`, 400);
      }

      orderCheckoutItems = [
        {
          id: `buynow_${product.id}_${Date.now()}`,
          cartId: 'direct_purchase',
          productId: product.id,
          variantId: variant ? variant.id : null,
          quantity: buyQty,
          product,
          variant,
          isFlashSale: false,
          flashSaleReservationId: null,
          flashSaleItemId: null,
          flashSaleUnitPrice: null,
        },
      ];
    } else {
      cart = await prisma.cart.findUnique({
        where: { userId: req.user!.userId },
        include: {
          items: {
            include: {
              product: {
                include: {
                  category: true,
                  store: { include: { seller: true } },
                  inventory: true,
                },
              },
              variant: true,
            },
          },
        },
      });

      if (!cart || cart.items.length === 0) {
        throw new AppError('سلة التسوق فارغة', 400);
      }

      if (Array.isArray(selectedCartItemIds) && selectedCartItemIds.length > 0) {
        const idSet = new Set(selectedCartItemIds.map(String));
        orderCheckoutItems = cart.items.filter((item: any) => idSet.has(item.id));
        if (orderCheckoutItems.length === 0) {
          throw new AppError('المنتجات المحددة في السلة لم تعد متوفرة', 400);
        }
      } else {
        orderCheckoutItems = cart.items;
      }
    }

    // Map PaymentMethod
    let mappedPaymentMethod: PaymentMethodType = PaymentMethodType.CASH_ON_DELIVERY;
    const pmUpper = String(paymentMethod || '').toUpperCase();
    if (
      pmUpper === 'WALLET' ||
      pmUpper === 'LOCAL_WALLET' ||
      pmUpper === 'CUSTOMER_WALLET' ||
      pmUpper === 'SOUQNAAPAY' ||
      pmUpper === 'SOUQNAA_PAY'
    ) {
      mappedPaymentMethod = PaymentMethodType.WALLET;
    }
    else if (pmUpper === 'MADA') mappedPaymentMethod = PaymentMethodType.MADA;
    else if (pmUpper === 'APPLE_PAY' || pmUpper === 'APPLEPAY') mappedPaymentMethod = PaymentMethodType.APPLE_PAY;
    else if (pmUpper === 'CREDIT_CARD' || pmUpper === 'CARD' || pmUpper === 'VISA' || pmUpper === 'MASTERCARD') mappedPaymentMethod = PaymentMethodType.CREDIT_CARD;
    else if (pmUpper === 'STC_PAY' || pmUpper === 'STCPAY') mappedPaymentMethod = PaymentMethodType.STC_PAY;
    else if (
      pmUpper === 'YEMENI_WALLET' ||
      pmUpper === 'KURAIMI' ||
      pmUpper === 'HASEB' ||
      pmUpper === 'CASHPAY' ||
      pmUpper === 'CASH' ||
      pmUpper === 'ONECASH' ||
      pmUpper === 'JAWALI' ||
      pmUpper === 'JAIB' ||
      pmUpper === 'FLOOSAK' ||
      pmUpper === 'SABA_CASH' ||
      pmUpper === 'PAYS' ||
      pmUpper === 'EASY_PAY' ||
      pmUpper === 'SHAMIL_MONEY' ||
      pmUpper === 'MOBILE_MONEY'
    ) {
      mappedPaymentMethod = PaymentMethodType.YEMENI_WALLET;
    }
    else mappedPaymentMethod = PaymentMethodType.CASH_ON_DELIVERY;

    // ==========================================
    // SERVER-SIDE FEATURE FLAG ENFORCEMENT
    // ==========================================
    const evaluationContext = { userId: req.user!.userId };

    // 1. Delivery Methods Guard
    if (deliveryMethodCode === 'scheduled' || deliveryScheduleType === 'SCHEDULED' || deliveryTimeSlotId) {
      const isScheduledActive = await remoteConfigService.isFeatureActive('scheduled_delivery', evaluationContext);
      if (!isScheduledActive) {
        throw new AppError('خدمة جدولة مواعيد التوصيل معطلة حالياً من قبل إدارة المنصة.', 400, 'FEATURE_DISABLED');
      }
    } else if (deliveryMethodCode === 'express') {
      const isExpressActive = await remoteConfigService.isFeatureActive('express_delivery', evaluationContext);
      if (!isExpressActive) {
        throw new AppError('خدمة التوصيل السريع (Express) معطلة حالياً من قبل إدارة المنصة.', 400, 'FEATURE_DISABLED');
      }
    }

    // 2. Payment Methods Guard
    if (mappedPaymentMethod === PaymentMethodType.CASH_ON_DELIVERY) {
      const isCodActive = await remoteConfigService.isFeatureActive('cash_on_delivery', evaluationContext);
      if (!isCodActive) {
        throw new AppError('طريقة الدفع عند الاستلام معطلة حالياً، يرجى اختيار طريقة دفع بديلة.', 400, 'FEATURE_DISABLED');
      }
    } else if (
      mappedPaymentMethod === PaymentMethodType.WALLET ||
      mappedPaymentMethod === PaymentMethodType.MADA ||
      mappedPaymentMethod === PaymentMethodType.APPLE_PAY ||
      mappedPaymentMethod === PaymentMethodType.CREDIT_CARD ||
      mappedPaymentMethod === PaymentMethodType.STC_PAY
    ) {
      const isOnlineActive = await remoteConfigService.isFeatureActive('online_payment', evaluationContext);
      if (!isOnlineActive) {
        throw new AppError('بوابات الدفع الإلكتروني معطلة حالياً على مستوى المنصة لأعمال الصيانة.', 400, 'FEATURE_DISABLED');
      }
    } else if (mappedPaymentMethod === PaymentMethodType.YEMENI_WALLET || walletProvider) {
      const isWalletsActive = await remoteConfigService.isFeatureActive('electronic_wallet_providers', evaluationContext);
      if (!isWalletsActive) {
        throw new AppError('الدفع عبر المحافظ الإلكترونية معطل حالياً من قبل إدارة المنصة.', 400, 'FEATURE_DISABLED');
      }
      if (walletProvider) {
        const isProvActive = await remoteConfigService.isWalletProviderActive(String(walletProvider));
        if (!isProvActive) {
          throw new AppError(`مزود المحفظة الإلكترونية [${walletProvider}] معطل حالياً من قبل إدارة المنصة.`, 400, 'PROVIDER_DISABLED');
        }
      }
    }

    // 3. Coins / Rewards Redemption Guard
    const effectiveCoinsReq = coinsToUse !== undefined ? coinsToUse : coinsUsed;
    const effectiveUseCoins = useCoins === true || (effectiveCoinsReq && Number(effectiveCoinsReq) > 0);

    if (effectiveUseCoins) {
      const isCoinsActive = await remoteConfigService.isFeatureActive('coins_rewards', evaluationContext);
      if (!isCoinsActive) {
        throw new AppError('برنامج مكافآت ونقاط سوقناا معطل حالياً.', 400, 'FEATURE_DISABLED');
      }
    }

    // Group items by seller
    const sellerGroups = new Map<string, typeof orderCheckoutItems>();
    let subtotal = 0;
    const fallbackSeller = await prisma.seller.findFirst();

    for (const item of orderCheckoutItems) {
      const sellerId = item.product.store?.sellerId || item.product.store?.seller?.id || fallbackSeller?.id || '';
      if (!sellerId) {
        throw new AppError(`تعذر تحديد المتجر التابع للمنتج: ${item.product.nameAr}`, 400);
      }

      let price = item.variant?.price ?? item.product.price;

      // Revalidate Flash Sale reservation at checkout
      if (item.isFlashSale && item.flashSaleReservationId) {
        const resRecord = await prisma.flashSaleReservation.findUnique({
          where: { id: item.flashSaleReservationId },
          include: { flashSaleItem: { include: { campaign: true } } },
        });

        if (
          !resRecord ||
          resRecord.customerId !== req.user!.userId ||
          resRecord.status !== 'RESERVED' ||
          resRecord.expiresAt < new Date() ||
          resRecord.flashSaleItem.campaign.status !== 'ACTIVE'
        ) {
          throw new AppError(
            `انتهت صلاحية حجز العرض السريع للمنتج: ${item.product.nameAr}. يرجى إعادة الحجز من صفحة العرض.`,
            400,
            'FLASH_SALE_RESERVATION_EXPIRED'
          );
        }
        price = resRecord.unitPrice;
      }

      subtotal += price * item.quantity;
      const group = sellerGroups.get(sellerId) || [];
      group.push(item);
      sellerGroups.set(sellerId, group);
    }

    const sellerOrdersInput = Array.from(sellerGroups.keys()).map((sellerId) => {
      const storeId = sellerGroups.get(sellerId)?.[0]?.product?.storeId || '';
      return { sellerId, storeId };
    });

    // Authoritative COD validation: Enforce that all sellers in order permit COD and are not financially restricted
    if (mappedPaymentMethod === PaymentMethodType.CASH_ON_DELIVERY) {
      const codEligibility = await SellerFinancialRiskService.evaluateCodEligibility({
        sellerIds: Array.from(sellerGroups.keys()),
        customerId: req.user!.userId,
      });

      if (!codEligibility.isCodAvailable) {
        throw new AppError(
          codEligibility.reason || 'خدمة الدفع عند الاستلام غير متاحة لهذا الطلب لوجود قيود على بعض المتاجر.',
          400,
          'COD_NOT_ELIGIBLE'
        );
      }
    }

    const isExpress = deliveryMethodCode === 'express' || deliveryScheduleType === 'EXPRESS';
    const finalScheduleType = isExpress ? 'EXPRESS' : (deliveryScheduleType === 'SCHEDULED' ? 'SCHEDULED' : 'ASAP');

    let quote;
    try {
      quote = await deliveryQuoteService.createQuote({
        customerAddressId: address.id,
        sellerOrders: sellerOrdersInput,
        isExpress,
        deliveryScheduleType: finalScheduleType as any,
        deliveryDate,
        deliveryTimeSlotId,
      });
    } catch (err: any) {
      throw new AppError(err.message || 'فشل في حساب رسوم التوصيل', err.statusCode || 400);
    }

    if (!quote.deliveryAvailable) {
      throw new AppError(
        quote.reason === 'OUTSIDE_DELIVERY_AREA'
          ? 'عنوان التوصيل خارج نطاق التوصيل المسموح به'
          : 'التوصيل غير متاح لهذا العنوان في الوقت الحالي',
        400
      );
    }

    // 1.1 Universal Shipping Promotions & First-Order Free Shipping Authoritative Evaluation & Reservation
    let universalCalculation: ShippingFundingBreakdown | null = null;
    let appliedUniversalPromotion: any = null;
    let firstOrderCalculation: FirstOrderShippingCalculation | null = null;
    let isShippingPromotionEligible = false;

    try {
      const userRecord = await prisma.user.findUnique({
        where: { id: req.user!.userId },
        select: { createdAt: true, phone: true, email: true, isVerified: true, isActive: true },
      });
      const completedOrderCount = await prisma.order.count({
        where: {
          userId: req.user!.userId,
          status: { in: ['CONFIRMED', 'PROCESSING', 'READY_TO_SHIP', 'SHIPPED', 'DELIVERED'] },
        },
      });

      const now = new Date();
      const accountAgeDays = userRecord
        ? Math.floor((now.getTime() - new Date(userRecord.createdAt).getTime()) / (1000 * 60 * 60 * 24))
        : 0;

      const sellerIdsList = Array.from(sellerGroups.keys());
      const sellerPreviousCounts = await Promise.all(
        sellerIdsList.map(async (sId) => {
          const count = await prisma.sellerOrder.count({
            where: {
              sellerId: sId,
              order: { userId: req.user!.userId, status: { in: ['CONFIRMED', 'PROCESSING', 'READY_TO_SHIP', 'SHIPPED', 'DELIVERED'] } },
            },
          });
          return { sellerId: sId, count };
        })
      );
      const sellerCountMap = new Map(sellerPreviousCounts.map((s) => [s.sellerId, s.count]));

      const rawSellerDeliveries = quote.sellerQuotes.map((sq) => ({
        sellerId: sq.sellerId,
        deliveryFee: sq.deliveryFee,
        deliveryZone: sq.zoneName || undefined,
      }));

      const productIdsInCart = orderCheckoutItems.map((it) => it.productId);
      const categoryIdsInCart = orderCheckoutItems.map((it) => it.product?.categoryId).filter(Boolean) as string[];

      const universalEvaluation = await UniversalShippingPromotionService.evaluateCheckout({
        context: {
          customer: {
            id: req.user!.userId,
            completedOrderCount,
            accountAgeDays,
            isPhoneVerified: Boolean(userRecord?.phone && userRecord?.isVerified),
            isEmailVerified: Boolean(userRecord?.email && userRecord?.isVerified),
            isRestricted: !userRecord?.isActive,
            ipAddress: req.ip,
          },
          order: {
            subtotal,
            itemCount: orderCheckoutItems.length,
            sellerCount: sellerIdsList.length,
            productIds: productIdsInCart,
            categoryIds: categoryIdsInCart,
          },
          delivery: {
            deliveryMethod: deliveryMethodCode || finalScheduleType,
            deliveryZone: quote.sellerQuotes[0]?.zoneName || undefined,
            originalShippingAmount: quote.totalDeliveryFee,
            sellerDeliveries: rawSellerDeliveries,
          },
          sellers: sellerIdsList.map((sId) => ({
            id: sId,
            previousOrderCountFromSeller: sellerCountMap.get(sId) ?? 0,
            isActive: true,
            isPromotionEnabled: true,
          })),
          time: { now },
        },
      });

      if (universalEvaluation.appliedPromotions.length > 0 && universalEvaluation.aggregateCalculation.shippingPromotionDiscount > 0) {
        appliedUniversalPromotion = universalEvaluation.appliedPromotions[0];
        universalCalculation = universalEvaluation.aggregateCalculation;
        isShippingPromotionEligible = true;

        const res = await ShippingPromotionReservationEngine.reserve({
          customerId: req.user!.userId,
          promotionId: appliedUniversalPromotion.promotionId,
          promotionType: appliedUniversalPromotion.promotionType,
          promotionCode: appliedUniversalPromotion.promotionCode,
          calculation: universalCalculation,
          cartId: cart.id,
          idempotencyKey: idempotencyKey ? `usp_${idempotencyKey}` : undefined,
        });
        universalReservationId = res.reservationId;
      } else {
        // Fallback: evaluate First-Order Free Shipping Config Engine
        const eligibility = await FirstOrderFreeShippingEligibilityService.evaluateEligibility({
          customerId: req.user!.userId,
          cartSubtotal: subtotal,
          deliveryMethod: deliveryMethodCode || finalScheduleType,
          deliveryZoneId: quote.sellerQuotes[0]?.zoneId || null,
          deliveryZoneName: quote.sellerQuotes[0]?.zoneName || null,
          sellerIds: sellerIdsList,
          ipAddress: req.ip,
          userAgent: req.headers['user-agent'],
          deviceId: (req.headers['x-device-id'] as string) || undefined,
        });

        if (eligibility.eligible && quote.totalDeliveryFee > 0) {
          isShippingPromotionEligible = true;
          const reservation = await FirstOrderPromotionReservationService.reservePromotion({
            customerId: req.user!.userId,
            cartId: cart.id,
            cartSubtotal: subtotal,
            originalShippingAmount: quote.totalDeliveryFee,
            deliveryMethod: deliveryMethodCode || finalScheduleType,
            deliveryZoneId: quote.sellerQuotes[0]?.zoneId || null,
            deliveryZoneName: quote.sellerQuotes[0]?.zoneName || null,
            sellerQuotes: quote.sellerQuotes.map((sq) => ({
              sellerId: sq.sellerId,
              deliveryFee: sq.deliveryFee,
            })),
            idempotencyKey: idempotencyKey ? `fos_${idempotencyKey}` : undefined,
          });
          firstOrderReservationId = reservation.reservationId;
          firstOrderCalculation = reservation.calculation;
        }
      }
    } catch (err: any) {
      if (err.statusCode === 409) throw err;
      console.warn('Shipping promotion check warning:', err.message);
    }

    // 2. Voucher Calculation & Authoritative Breakdown
    const requestedVoucherCodes: string[] = rawVoucherCodes
      ? (Array.isArray(rawVoucherCodes) ? rawVoucherCodes : [rawVoucherCodes])
      : cart?.appliedVouchers
      ? cart.appliedVouchers.split(',').map((c: string) => c.trim())
      : cart?.couponCode
      ? [cart.couponCode]
      : [];

    const cartEvalItems: CartEvaluationItem[] = orderCheckoutItems.map((it) => ({
      id: it.id,
      cartItemId: it.id,
      productId: it.productId,
      variantId: it.variantId,
      storeId: it.product.storeId,
      sellerId: it.product.store?.sellerId || it.product.store?.seller?.id || fallbackSeller?.id || '',
      categoryId: it.product.categoryId,
      productNameAr: it.product.nameAr,
      productNameEn: it.product.nameEn,
      unitPrice: it.variant?.price ?? it.product.price,
      quantity: it.quantity,
      totalPrice: (it.variant?.price ?? it.product.price) * it.quantity,
      isFlashSale: it.isFlashSale,
      flashSaleUnitPrice: it.flashSaleUnitPrice,
    }));

    let voucherCalcResult = null;
    let appliedVouchersList: any[] = [];
    if (requestedVoucherCodes.length > 0) {
      const normalizedCodes = requestedVoucherCodes.map((c: string) =>
        c.trim().toUpperCase().replace(/[\s\-_]+/g, '')
      );
      const activeVouchers = await prisma.voucher.findMany({
        where: {
          normalizedCode: { in: normalizedCodes },
        },
        include: { products: true, categories: true },
      });

      voucherCalcResult = await VoucherCalculationService.calculateCartDiscounts({
        customerId: req.user!.userId,
        items: cartEvalItems,
        shippingFee: quote.totalDeliveryFee,
        vouchers: activeVouchers,
        currency: config.marketplace.currency || 'YER',
      });
      appliedVouchersList = voucherCalcResult.appliedVouchers;
    }

    const platformDiscount = voucherCalcResult ? voucherCalcResult.platformDiscount : 0;
    const sellerDiscount = voucherCalcResult ? voucherCalcResult.sellerDiscount : 0;
    const rawVoucherShippingDiscount = voucherCalcResult ? voucherCalcResult.shippingDiscount : 0;
    const activeShippingDiscount = universalCalculation
      ? universalCalculation.shippingPromotionDiscount
      : (firstOrderCalculation?.shippingPromotionDiscount ?? 0);

    const promoPlatformSubsidy = universalCalculation
      ? universalCalculation.platformShippingSubsidy
      : (firstOrderCalculation?.platformShippingSubsidy ?? 0);

    const promoSellerContribution = universalCalculation
      ? universalCalculation.sellerShippingContribution
      : (firstOrderCalculation?.sellerShippingContribution ?? 0);

    const promoSellerReimbursement = universalCalculation
      ? universalCalculation.sellerDeliveryReimbursement
      : (firstOrderCalculation?.sellerDeliveryReimbursement ?? 0);

    const promoCostBearer = universalCalculation
      ? universalCalculation.fundingType
      : (firstOrderCalculation?.costBearer ?? (rawVoucherShippingDiscount > 0 ? 'PLATFORM' : null));

    const activePromotionId = universalReservationId || firstOrderReservationId;
    const activePromotionType = appliedUniversalPromotion
      ? appliedUniversalPromotion.promotionType
      : (isShippingPromotionEligible ? 'FIRST_ORDER_FREE_SHIPPING' : (rawVoucherShippingDiscount > 0 ? 'VOUCHER' : null));
    const activePromotionName = appliedUniversalPromotion
      ? (appliedUniversalPromotion.promotionNameAr || appliedUniversalPromotion.promotionName)
      : (isShippingPromotionEligible ? 'شحن مجاني على أول طلب' : null);

    // Total shipping discount combines promotional shipping discount and any voucher shipping discount (capped at total delivery fee)
    const effectiveShippingDiscount = Math.min(
      quote.totalDeliveryFee,
      activeShippingDiscount + rawVoucherShippingDiscount
    );
    const effectiveCustomerShippingCharge = Math.max(0, quote.totalDeliveryFee - effectiveShippingDiscount);

    const platformFunding = (voucherCalcResult?.platformFunding ?? 0) + promoPlatformSubsidy;
    const sellerFunding = (voucherCalcResult?.sellerFunding ?? 0) + promoSellerContribution;
    const deliveryFee = effectiveCustomerShippingCharge;

    // ── SOUQNAA Coins Authoritative Calculation (§13, §14, §16, §51, §52) ──
    let coinsAccepted = 0;
    let coinDiscount = 0;
    let coinConversionRate = 100.0;
    let rewardPolicyVersion = '1.0.0';
    let coinReservationRecord: any = null;

    const effectiveCoins = coinsToUse !== undefined ? coinsToUse : coinsUsed;
    const effectiveReservationId = coinReservationId || coinQuoteId;

    if (effectiveUseCoins || effectiveReservationId) {
      const isCoinsEnabled = await RewardsConfigService.isEnabled('rewards_coins.enabled');
      const isRedemptionEnabled = await RewardsConfigService.isEnabled('rewards_coin_redemption.enabled');

      if (isCoinsEnabled && isRedemptionEnabled) {
        const rules = await RewardsConfigService.getRules();
        coinConversionRate = rules.redemptionRatio || 100.0;
        rewardPolicyVersion = rules.version || '1.0.0';

        // Check if there is an active reservation
        if (effectiveReservationId) {
          const resRec = await prisma.coinReservation.findUnique({
            where: { id: effectiveReservationId },
          });
          if (
            resRec &&
            resRec.customerId === req.user!.userId &&
            resRec.status === 'RESERVED' &&
            resRec.expiresAt > new Date()
          ) {
            coinReservationRecord = resRec;
            coinsAccepted = resRec.coins;
            coinDiscount = resRec.discountAmount;
          }
        }

        // If no reservation or reservation expired, calculate dynamically on server
        if (!coinReservationRecord) {
          const availableCoins = await RewardsLedgerService.getAuthoritativeBalance(req.user!.userId);
          const eligibleSubtotal = Math.max(0, subtotal - (platformDiscount + sellerDiscount));

          if (
            eligibleSubtotal >= (rules.minOrderAmount || 200) &&
            availableCoins >= (rules.minCoinsRequired || 50)
          ) {
            const maxOrderDiscount = parseFloat((eligibleSubtotal * (rules.maxOrderPercentage || 0.20)).toFixed(2));
            const coinsForMaxDiscount = Math.floor(maxOrderDiscount * coinConversionRate);
            const maxUsable = Math.min(
              availableCoins,
              coinsForMaxDiscount,
              rules.maxCoinsPerOrder || 2000
            );

            const requested = effectiveCoins !== undefined ? Math.max(0, parseInt(String(effectiveCoins), 10)) : maxUsable;
            coinsAccepted = Math.min(requested, maxUsable);
            coinDiscount = parseFloat((coinsAccepted / coinConversionRate).toFixed(2));
          }
        }
      }
    }

    // ==========================================
    // SOUQNAA Centralized Production-Grade Tax Engine
    // ==========================================
    const taxCalculationItems = orderCheckoutItems.map((ci) => {
      let unitPrice = ci.variant?.price ?? ci.product.price;
      if (ci.isFlashSale && ci.flashSaleUnitPrice) {
        unitPrice = ci.flashSaleUnitPrice;
      }
      const itemAllocations = voucherCalcResult?.allocations.filter((a) => a.cartItemId === ci.id) || [];
      const itemVoucherDiscount = itemAllocations.reduce((sum, a) => sum + a.discountAmount, 0);
      const sellerId = ci.product.store?.sellerId || ci.product.store?.seller?.id || fallbackSeller?.id || '';

      return {
        id: ci.id,
        productId: ci.productId,
        variantId: ci.variantId || null,
        sellerId,
        categoryId: ci.product.categoryId || null,
        productNameAr: ci.product.nameAr,
        productNameEn: ci.product.nameEn,
        unitPrice,
        quantity: ci.quantity,
        discountAmount: itemVoucherDiscount,
      };
    });

    const taxResult = await TaxEngine.calculateCartTax({
      items: taxCalculationItems,
      shippingAmount: deliveryFee,
      customerId: req.user!.userId,
      currency: 'YER',
    });

    const taxAmount = taxResult.totalTax;
    const total = Math.max(
      0,
      subtotal - (platformDiscount + sellerDiscount) - coinDiscount + deliveryFee + (taxResult.priceIncludesTax ? 0 : taxAmount)
    );

    // Authoritative resolution of active Delivery Methods
    const activeDeliveryMethods = await prisma.deliveryMethod.findMany({
      where: { isActive: true },
    });
    const deliveryMethodCodeMap = new Map(
      activeDeliveryMethods.map((m) => [m.code.toLowerCase(), m])
    );
    const checkoutDeliveryMethodCode = String(deliveryMethodCode || (isExpress ? 'express' : 'standard')).toLowerCase();
    const defaultDeliveryMethod = deliveryMethodCodeMap.get(checkoutDeliveryMethodCode)
      || deliveryMethodCodeMap.get('standard')
      || activeDeliveryMethods[0]
      || null;

    // Resolve per-seller delivery methods with strict validation against active methods
    const rawSellerMethodOverrides = (req.body.sellerDeliveryMethods && typeof req.body.sellerDeliveryMethods === 'object')
      ? req.body.sellerDeliveryMethods
      : {};
    const resolvedSellerDeliveryMethods = new Map<string, typeof defaultDeliveryMethod>();
    for (const sellerId of sellerGroups.keys()) {
      const customCode = rawSellerMethodOverrides[sellerId];
      if (customCode && typeof customCode === 'string') {
        const validatedMethod = deliveryMethodCodeMap.get(customCode.trim().toLowerCase());
        if (validatedMethod) {
          resolvedSellerDeliveryMethods.set(sellerId, validatedMethod);
          continue;
        }
      }
      resolvedSellerDeliveryMethods.set(sellerId, defaultDeliveryMethod);
    }

    // Determine parent order deliveryMethodId: only populated if ALL sellers share the EXACT same delivery method
    const distinctMethodIds = new Set(
      Array.from(resolvedSellerDeliveryMethods.values())
        .map((m) => m?.id)
        .filter(Boolean)
    );
    const parentDeliveryMethodId = distinctMethodIds.size === 1 ? Array.from(distinctMethodIds)[0] : null;

    // 0. Atomically reserve sequence and generate public order numbers
    const orderNumberData = await OrderNumberService.generateNextOrderNumber();

    const { newOrder, createdSellerOrders } = await prisma.$transaction(async (tx) => {
      // Maps to associate immutable snapshots
      const sellerOrderMap = new Map<string, string>();
      const orderItemMap = new Map<string, string>();

      // 1. Create main parent order with coin snapshot (§82) and taxAmount
      const createdOrder = await tx.order.create({
        data: {
          orderNumber: orderNumberData.orderNumber,
          orderSequence: orderNumberData.orderSequence,
          displayOrderNumber: orderNumberData.displayOrderNumber,
          idempotencyKey: idempotencyKey || null,
          userId: req.user!.userId,
          deliveryAddressId: address.id,
          deliveryMethodId: parentDeliveryMethodId || null,
          status: OrderStatus.PENDING,
          subtotal,
          deliveryFee,
          discountAmount: platformDiscount + sellerDiscount + coinDiscount,
          taxAmount,
          total,
          notes,
          couponCode: appliedVouchersList.length > 0 ? appliedVouchersList.map((v) => v.code).join(',') : (cart?.couponCode || null),
          voucherId: appliedVouchersList[0]?.id || null,
          voucherCode: appliedVouchersList[0]?.code || null,
          platformDiscount,
          sellerDiscount,
          shippingDiscount: effectiveShippingDiscount,
          platformFunding,
          sellerFunding,
          originalShippingAmount: quote.totalDeliveryFee,
          shippingPromotionDiscount: effectiveShippingDiscount,
          customerShippingCharge: deliveryFee,
          platformShippingSubsidy: promoPlatformSubsidy,
          sellerShippingContribution: promoSellerContribution,
          sellerDeliveryReimbursement: promoSellerReimbursement,
          shippingCostBearer: promoCostBearer,
          shippingPromotionId: activePromotionId,
          shippingPromotionType: activePromotionType,
          shippingPromotionName: activePromotionName,
          shippingPromotionAppliedAt: isShippingPromotionEligible || effectiveShippingDiscount > 0 ? new Date() : null,
          deliveryScheduleType: finalScheduleType as any,
          deliveryDate: deliveryDate ? new Date(deliveryDate) : undefined,
          deliveryTimeSlotId: deliveryTimeSlotId || undefined,
          // SOUQNAA Coins Snapshot (§82)
          coinsUsed: coinsAccepted,
          coinDiscount,
          coinConversionRate,
          rewardPolicyVersion,
        },
      });

      const sellerOrdersList: Array<{ id: string; sellerId: string; sellerOrderNumber: string; sellerSubtotal: number }> = [];

      // 2. Create immutable Address Snapshot
      await tx.orderDeliveryAddress.create({
        data: {
          orderId: createdOrder.id,
          recipientName: address.recipientName,
          recipientPhone: address.recipientPhone,
          street: address.street,
          buildingNumber: address.buildingNumber,
          apartmentNumber: address.apartmentNumber,
          cityName: address.city?.nameAr ?? 'صنعاء',
          districtName: address.district?.nameAr ?? null,
          latitude: address.latitude,
          longitude: address.longitude,
        },
      });

      // 3. Create Status History
      await tx.orderStatusHistory.create({
        data: {
          orderId: createdOrder.id,
          fromStatus: null,
          toStatus: 'PENDING',
          status: OrderStatus.PENDING,
          changedBy: req.user!.userId,
          changedByRole: 'CUSTOMER',
          note: 'تم إنشاء الطلب بنجاح وهو بانتظار قبول المتجر',
        },
      });

      // 4. Create Seller Orders & reserve inventory
      let subOrderIndex = 0;
      for (const [sellerId, items] of sellerGroups.entries()) {
        subOrderIndex++;
        const sellerOrderNumber = OrderNumberService.generateSellerOrderNumber(
          orderNumberData.orderNumber,
          subOrderIndex
        );

        const sellerSubtotal = items.reduce(
          (sum, i) => sum + (i.variant?.price ?? i.product.price) * i.quantity,
          0
        );

        let totalCommissionAmount = 0;
        for (const i of items) {
          const itemTotal = (i.variant?.price ?? i.product.price) * i.quantity;
          let effectiveRate = defaultCommissionRate;

          if (i.product.commissionRate !== null && i.product.commissionRate !== undefined) {
            effectiveRate = i.product.commissionRate;
          } else if (
            i.product.store?.seller?.commissionRate !== null &&
            i.product.store?.seller?.commissionRate !== undefined
          ) {
            effectiveRate = i.product.store.seller.commissionRate;
          } else if (
            i.product.category?.commissionRate !== null &&
            i.product.category?.commissionRate !== undefined
          ) {
            effectiveRate = i.product.category.commissionRate;
          }

          totalCommissionAmount += itemTotal * effectiveRate;
        }

        const sellerAlloc = (universalCalculation?.sellerBreakdown?.find((b: any) => b.sellerId === sellerId)) ||
          (firstOrderCalculation?.sellerBreakdown?.find((b) => b.sellerId === sellerId));
        const sq = quote.sellerQuotes.find((q) => q.sellerId === sellerId);
        const origSellerDelivery = sellerAlloc?.originalDeliveryFee ?? (sq?.deliveryFee ?? 0.0);
        const sellerShipDiscount = sellerAlloc?.shippingPromotionDiscount ?? 0.0;
        const sellerCustCharge = sellerAlloc?.customerDeliveryCharge ?? (sq?.deliveryFee ?? 0.0);
        const sellerPlatSubsidy = sellerAlloc?.platformShippingSubsidy ?? 0.0;
        const sellerContrib = sellerAlloc?.sellerShippingContribution ?? 0.0;
        const sellerReimburse = sellerAlloc?.sellerDeliveryReimbursement ?? 0.0;

        // Seller delivery entitlement:
        // Sum of customer-paid delivery charge and platform delivery reimbursement (net of seller contribution).
        const effectiveSellerDeliveryEntitlement = TaxMath.add(sellerCustCharge, sellerReimburse);

        const sellerBreakdown = voucherCalcResult?.sellerBreakdowns?.[sellerId];
        const sellerVoucherDiscount = sellerBreakdown?.sellerDiscount || 0;
        const sellerPlatformDiscount = sellerBreakdown?.platformDiscount || 0;

        const sellerPayout = TaxMath.round(
          Math.max(
            0,
            sellerSubtotal - sellerVoucherDiscount - totalCommissionAmount + effectiveSellerDeliveryEntitlement
          )
        );

        const sellerTaxBreakdown = taxResult.sellerBreakdowns[sellerId];
        const sellerTaxAmount = sellerTaxBreakdown ? sellerTaxBreakdown.sellerTotalTax : 0;

        const sellerDeliveryMethod = resolvedSellerDeliveryMethods.get(sellerId) || defaultDeliveryMethod;

        const sellerOrder = await tx.sellerOrder.create({
          data: {
            orderId: createdOrder.id,
            sellerId,
            sellerOrderNumber,
            subOrderIndex,
            deliveryMethodId: sellerDeliveryMethod?.id || null,
            status: SellerOrderStatus.PENDING,
            subtotal: sellerSubtotal,
            deliveryFee: sellerCustCharge,
            originalDeliveryFee: origSellerDelivery,
            shippingPromotionDiscount: sellerShipDiscount,
            customerDeliveryCharge: sellerCustCharge,
            platformShippingSubsidy: sellerPlatSubsidy,
            sellerShippingContribution: sellerContrib,
            sellerDeliveryReimbursement: sellerReimburse,
            shippingCostBearer: promoCostBearer,
            taxAmount: sellerTaxAmount,
            commissionAmount: totalCommissionAmount,
            sellerPayout,
            voucherDiscountAmount: sellerVoucherDiscount + sellerPlatformDiscount,
            sellerFundedDiscount: sellerVoucherDiscount,
            platformFundedDiscount: sellerPlatformDiscount,
          },
        });
        sellerOrderMap.set(sellerId, sellerOrder.id);
        sellerOrdersList.push({ id: sellerOrder.id, sellerId, sellerOrderNumber, sellerSubtotal });

        // Create Seller Order status history
        await tx.orderStatusHistory.create({
          data: {
            orderId: createdOrder.id,
            sellerOrderId: sellerOrder.id,
            fromStatus: null,
            toStatus: 'PENDING',
            status: OrderStatus.PENDING,
            changedBy: req.user!.userId,
            changedByRole: 'CUSTOMER',
            note: 'تم إنشاء طلب المتجر الفرعي بنجاح',
          },
        });

        // Create Order Items & Reserve Inventory
        for (const i of items) {
          let unitPrice = i.variant?.price ?? i.product.price;
          let flashItemMeta: any = null;

          if (i.isFlashSale && i.flashSaleReservationId) {
            const resRecord = await prisma.flashSaleReservation.findUnique({
              where: { id: i.flashSaleReservationId },
              include: { flashSaleItem: true },
            });
            if (resRecord && resRecord.status === 'RESERVED') {
              unitPrice = resRecord.unitPrice;
              flashItemMeta = resRecord.flashSaleItem;
            }
          }

          const originalPrice = i.variant?.price ?? i.product.price;
          const itemAllocations = voucherCalcResult?.allocations.filter((a) => a.cartItemId === i.id) || [];
          const itemVoucherDiscount = itemAllocations.reduce((sum, a) => sum + a.discountAmount, 0);

          const itemTax = taxResult.breakdown.find((b) => b.itemId === i.id);
          const itemTaxAmount = itemTax ? itemTax.taxAmount : 0;

          const createdOrderItem = await tx.orderItem.create({
            data: {
              sellerOrderId: sellerOrder.id,
              productId: i.productId,
              variantId: i.variantId,
              productNameAr: i.product.nameAr,
              productNameEn: i.product.nameEn,
              unitPrice,
              quantity: i.quantity,
              totalPrice: unitPrice * i.quantity,
              taxAmount: itemTaxAmount,
              voucherDiscountAmount: itemVoucherDiscount,
              isFlashSale: i.isFlashSale ?? false,
              campaignId: flashItemMeta?.campaignId || null,
              flashSaleItemId: i.flashSaleItemId || null,
              originalPrice,
              flashSalePrice: i.isFlashSale ? unitPrice : null,
              discountType: flashItemMeta?.discountType || null,
              discountValue: flashItemMeta?.discountValue || null,
              discountAmount: i.isFlashSale ? Math.max(0, originalPrice - unitPrice) * i.quantity : 0,
              allocatedStock: flashItemMeta?.allocatedStock || null,
            },
          });
          orderItemMap.set(i.id, createdOrderItem.id);

          // Tag allocations with orderItemId
          for (const alloc of itemAllocations) {
            alloc.orderItemId = createdOrderItem.id;
          }

          // If Flash Sale: Convert reservation (increments soldStock and releases reservation)
          if (i.isFlashSale && i.flashSaleReservationId) {
            await flashSaleService.convertReservation(i.flashSaleReservationId, createdOrder.id);
          } else {
            // Standard inventory reservation
            if (i.variantId) {
              await tx.productVariant.update({
                where: { id: i.variantId },
                data: { stockQuantity: { decrement: i.quantity } },
              });
            } else {
              await tx.inventory.upsert({
                where: { productId: i.productId },
                update: { reserved: { increment: i.quantity } },
                create: {
                  productId: i.productId,
                  quantity: 100,
                  reserved: i.quantity,
                },
              });
            }
          }
        }

        // Add to seller pending balance (seller payout strictly excludes tax liability)
        await tx.sellerBalance.upsert({
          where: { sellerId },
          update: { pendingBalance: { increment: sellerPayout } },
          create: {
            sellerId,
            pendingBalance: sellerPayout,
            availableBalance: 0,
            withdrawnBalance: 0,
          },
        });
      }

      // 4.1 Save immutable Order Tax Snapshots (Section 9 & Section 10)
      await TaxEngine.createOrderTaxSnapshots(
        tx,
        createdOrder.id,
        taxResult,
        sellerOrderMap,
        orderItemMap
      );

      // 5. Record immutable Voucher Redemptions and item allocations
      if (voucherCalcResult && appliedVouchersList.length > 0) {
        await VoucherRedemptionService.redeemVouchersForOrder({
          tx,
          orderId: createdOrder.id,
          customerId: req.user!.userId,
          currency: config.marketplace.currency || 'YER',
          vouchers: appliedVouchersList,
          allocations: voucherCalcResult.allocations,
          idempotencyKey: (req.headers['idempotency-key'] as string) || undefined,
        });
      }

      // 5.2 Authoritatively Consume Shipping Promotion Reservation & Record Financial Ledger Entries
      if (universalReservationId && universalCalculation) {
        await ShippingPromotionReservationEngine.consume(tx, {
          reservationId: universalReservationId,
          orderId: createdOrder.id,
          calculation: universalCalculation,
        });

        // Record Platform Subsidy Debit in Financial Ledger
        if (universalCalculation.platformShippingSubsidy > 0) {
          await tx.financialTransaction.create({
            data: {
              transactionNumber: `FTX-SUB-${orderNumberData.orderNumber}`,
              type: 'SHIPPING_SUBSIDY_PLATFORM' as any,
              orderId: createdOrder.id,
              amount: universalCalculation.platformShippingSubsidy,
              direction: 'DEBIT',
              currency: 'YER',
              description: `دعم المنصة لرسوم التوصيل - عرض ${activePromotionName || 'شحن ترويجي'}`,
            },
          });
        }

        // Record Seller Delivery Reimbursements & Contributions per seller in Financial Ledger
        for (const alloc of universalCalculation.sellerBreakdown) {
          if (alloc.sellerDeliveryReimbursement > 0) {
            await tx.financialTransaction.create({
              data: {
                transactionNumber: `FTX-REIMB-${orderNumberData.orderNumber}-${alloc.sellerId.slice(0, 6)}`,
                type: 'SELLER_DELIVERY_REIMBURSEMENT' as any,
                orderId: createdOrder.id,
                sellerId: alloc.sellerId,
                amount: alloc.sellerDeliveryReimbursement,
                direction: 'CREDIT',
                currency: 'YER',
                description: `تعويض رسوم التوصيل للبائع - عرض ${activePromotionName || 'شحن ترويجي'}`,
              },
            });
          }
          if (alloc.sellerShippingContribution > 0) {
            await tx.financialTransaction.create({
              data: {
                transactionNumber: `FTX-CONTRIB-${orderNumberData.orderNumber}-${alloc.sellerId.slice(0, 6)}`,
                type: 'SELLER_SHIPPING_CONTRIBUTION' as any,
                orderId: createdOrder.id,
                sellerId: alloc.sellerId,
                amount: alloc.sellerShippingContribution,
                direction: 'DEBIT',
                currency: 'YER',
                description: `مساهمة البائع في رسوم التوصيل - عرض ${activePromotionName || 'شحن ترويجي'}`,
              },
            });
          }
        }
      } else if (firstOrderReservationId && firstOrderCalculation) {
        await FirstOrderPromotionReservationService.consumeReservation(tx, {
          reservationId: firstOrderReservationId,
          orderId: createdOrder.id,
          calculation: firstOrderCalculation,
        });

        // Record Platform Subsidy Debit in Financial Ledger
        if (firstOrderCalculation.platformShippingSubsidy > 0) {
          await tx.financialTransaction.create({
            data: {
              transactionNumber: `FTX-SUB-${orderNumberData.orderNumber}`,
              type: 'SHIPPING_SUBSIDY_PLATFORM' as any,
              orderId: createdOrder.id,
              amount: firstOrderCalculation.platformShippingSubsidy,
              direction: 'DEBIT',
              currency: 'YER',
              description: 'دعم المنصة لرسوم التوصيل - عرض الشحن المجاني للطلب الأول',
            },
          });
        }

        // Record Seller Delivery Reimbursements & Contributions per seller in Financial Ledger
        for (const alloc of firstOrderCalculation.sellerBreakdown) {
          if (alloc.sellerDeliveryReimbursement > 0) {
            await tx.financialTransaction.create({
              data: {
                transactionNumber: `FTX-REIMB-${orderNumberData.orderNumber}-${alloc.sellerId.slice(0, 6)}`,
                type: 'SELLER_DELIVERY_REIMBURSEMENT' as any,
                orderId: createdOrder.id,
                sellerId: alloc.sellerId,
                amount: alloc.sellerDeliveryReimbursement,
                direction: 'CREDIT',
                currency: 'YER',
                description: 'تعويض رسوم التوصيل للبائع - عرض الشحن المجاني للطلب الأول',
              },
            });
          }
          if (alloc.sellerShippingContribution > 0) {
            await tx.financialTransaction.create({
              data: {
                transactionNumber: `FTX-CONTRIB-${orderNumberData.orderNumber}-${alloc.sellerId.slice(0, 6)}`,
                type: 'SELLER_SHIPPING_CONTRIBUTION' as any,
                orderId: createdOrder.id,
                sellerId: alloc.sellerId,
                amount: alloc.sellerShippingContribution,
                direction: 'DEBIT',
                currency: 'YER',
                description: 'مساهمة البائع في رسوم التوصيل للطلب الأول',
              },
            });
          }
        }
      }

      // 5.1 Atomically Redeem SOUQNAA Coins via FIFO Ledger (§8, §16, §17, §18)
      if (coinsAccepted > 0) {
        const coinDebitResult = await RewardsLedgerService.debitCoinsFIFO(
          {
            customerId: req.user!.userId,
            coins: coinsAccepted,
            type: RewardTxType.REDEEM,
            source: RewardTxSource.PURCHASE,
            referenceType: 'ORDER',
            referenceId: createdOrder.id,
            idempotencyKey: `orderRedeem:${createdOrder.id}`,
            descriptionAr: `استخدام عملات سوقناا في الطلب #${orderNumberData.displayOrderNumber} (خصم ${coinDiscount} ر.ي)`,
            descriptionEn: `SOUQNAA Coins redeemed on order #${orderNumberData.displayOrderNumber} (${coinDiscount} YER discount)`,
          },
          tx
        );

        if (coinReservationRecord) {
          await tx.coinReservation.update({
            where: { id: coinReservationRecord.id },
            data: {
              status: 'CONFIRMED',
              orderId: createdOrder.id,
            },
          });
        }

        await tx.order.update({
          where: { id: createdOrder.id },
          data: { coinTransactionId: coinDebitResult.transaction.id },
        });
      }

      // 6. Handle Wallet Debit & Create Payment record
      // Security fix: Client-supplied instantPay is strictly eliminated.
      // Payment status is derived exclusively from committed wallet debit or gateway verification.
      const isWalletPayment = mappedPaymentMethod === PaymentMethodType.WALLET;
      const isYemeniWallet = mappedPaymentMethod === PaymentMethodType.YEMENI_WALLET;
      const effectiveProvider = walletProvider || (isWalletPayment ? 'SOUQNAAPAY' : (isYemeniWallet ? pmUpper : null));

      // Atomically debit customer wallet if paid using SOUQNApay / internal wallet
      if (isWalletPayment) {
        await CustomerWalletService.debitForOrder(
          {
            customerId: req.user!.userId,
            orderId: createdOrder.id,
            orderNumber: createdOrder.orderNumber,
            amount: total,
            currency: 'YER',
          },
          tx
        );
      }

      const createdPayment = await tx.payment.create({
        data: {
          orderId: createdOrder.id,
          method: mappedPaymentMethod,
          amount: total,
          status: isWalletPayment ? PaymentStatus.PAID : PaymentStatus.PENDING,
          paidAt: isWalletPayment ? new Date() : null,
          transactionId: isWalletPayment ? `WTX-SQP-${createdOrder.orderNumber}` : (walletTransactionRef || null),
          walletProvider: effectiveProvider,
          walletSenderNumber: walletSenderNumber || null,
          walletTransactionRef: walletTransactionRef || null,
          walletReceiptUrl: walletReceiptUrl || null,
        },
      });

      if (isWalletPayment) {
        // Add history record for SOUQNApay payment
        await tx.orderStatusHistory.create({
          data: {
            orderId: createdOrder.id,
            status: OrderStatus.PENDING,
            toStatus: OrderStatus.PENDING,
            changedBy: req.user!.userId,
            changedByRole: 'CUSTOMER',
            note: 'طريقة الدفع: SOUQNApay (سوقناا باي) - تم الدفع التلقائي الفوري وتأكيد العملية بدون انتظار موافقة الإدارة',
          },
        });
      } else if (isYemeniWallet || walletTransactionRef) {
        await tx.paymentTransaction.create({
          data: {
            paymentId: createdPayment.id,
            gateway: effectiveProvider || 'YEMENI_WALLET',
            referenceId: walletTransactionRef || null,
            amount: total,
            status: PaymentStatus.PENDING,
            rawResponse: JSON.stringify({
              walletProvider: effectiveProvider,
              walletSenderNumber,
              walletTransactionRef,
              walletReceiptUrl,
              channel: 'MANUAL_WALLET_TRANSFER',
              submittedAt: new Date(),
            }),
          },
        });

        // Add history record detailing manual wallet transfer
        await tx.orderStatusHistory.create({
          data: {
            orderId: createdOrder.id,
            status: OrderStatus.PENDING,
            toStatus: OrderStatus.PENDING,
            changedBy: req.user!.userId,
            changedByRole: 'CUSTOMER',
            note: `طريقة الدفع: محفظة يمنية (${effectiveProvider || 'عامة'}) - مرجع التحويل: ${walletTransactionRef || 'بانتظار الإشعار'}`,
          },
        });
      }

      // 7. Clear Cart
      if (isBuyNowFlow) {
        // Buy Now directly purchases without touching or clearing persistent cart
      } else if (Array.isArray(selectedCartItemIds) && selectedCartItemIds.length > 0 && cart) {
        await tx.cartItem.deleteMany({
          where: {
            id: { in: selectedCartItemIds.map(String) },
            cartId: cart.id,
          },
        });
      } else if (cart) {
        await tx.cartItem.deleteMany({ where: { cartId: cart.id } });
      }
      return { newOrder: createdOrder, createdSellerOrders: sellerOrdersList };
    });

    // Reserve scheduled slot atomically if scheduled
    if (finalScheduleType === 'SCHEDULED' && deliveryTimeSlotId && deliveryDate) {
      await deliverySlotService.reserveSlot(newOrder.id, deliveryTimeSlotId, deliveryDate);
    }

    // Save DeliveryQuoteSnapshots per seller order
    for (const so of createdSellerOrders) {
      const sq = quote.sellerQuotes.find((q) => q.sellerId === so.sellerId);
      if (sq) {
        await deliveryQuoteService.saveSnapshot(so.id, sq, {
          deliveryScheduleType: finalScheduleType,
          deliveryDate,
          timeSlotId: deliveryTimeSlotId,
          timeSlotNameAr: quote.timeSlotNameAr,
          timeSlotStart: quote.timeSlotStart,
          timeSlotEnd: quote.timeSlotEnd,
        });
      }
    }

    // Notify Cart Abandonment Engine of completed checkout
    if (!isBuyNowFlow) {
      CartAbandonmentJob.onCheckoutCompleted(req.user!.userId, newOrder.id).catch(console.error);
    }

    const order = newOrder;

    // Fetch full order for response
    const fullOrder = await prisma.order.findUnique({
      where: { id: order.id },
      include: {
        sellerOrders: {
          include: {
            seller: { include: { stores: { select: { name: true, logo: true } } } },
            items: {
              include: {
                product: {
                  select: {
                    id: true,
                    nameAr: true,
                    nameEn: true,
                    images: { select: { url: true }, orderBy: { sortOrder: 'asc' }, take: 1 },
                  },
                },
                variant: { select: { id: true, image: true } },
              },
            },
          },
        },
        addressSnapshot: true,
        payment: true,
        statusHistory: { orderBy: { createdAt: 'asc' } },
      },
    });

    if (fullOrder && fullOrder.sellerOrders) {
      for (const so of fullOrder.sellerOrders) {
        if (so.items) {
          so.items = so.items.map((item: any) => ({
            ...item,
            productImage: item.variant?.image || item.product?.images?.[0]?.url || item.productImage || null,
          }));
        }
      }
    }

    // Notify sellers and customer wallet
    try {
      const isPaidOrCod = fullOrder?.payment?.status === PaymentStatus.PAID ||
        fullOrder?.payment?.method === PaymentMethodType.CASH_ON_DELIVERY ||
        fullOrder?.payment?.method === ('COD' as any);

      if (isPaidOrCod) {
        SocketService.get()?.emitGlobal('new:order', {
          orderId: order.id,
          orderNumber: order.orderNumber,
          displayOrderNumber: order.displayOrderNumber,
          total: order.total,
        });
      } else {
        SocketService.get()?.emitGlobal('admin:payment_transfer_submitted', {
          orderId: order.id,
          orderNumber: order.orderNumber,
          displayOrderNumber: order.displayOrderNumber,
          total: order.total,
        });
      }

      for (const so of createdSellerOrders) {
        SocketService.get()?.emitToUser(so.sellerId, 'seller:new_order', {
          orderId: order.id,
          orderNumber: order.orderNumber,
          displayOrderNumber: order.displayOrderNumber,
          sellerOrderId: so.id,
          sellerOrderNumber: so.sellerOrderNumber,
        });
      }

      if (fullOrder?.payment?.method === PaymentMethodType.WALLET) {
        SocketService.get()?.emitToUser(req.user!.userId, 'customer:wallet_updated', {
          userId: req.user!.userId,
          action: 'ORDER_PAYMENT',
          orderId: order.id,
          orderNumber: order.orderNumber,
          displayOrderNumber: order.displayOrderNumber,
          amount: fullOrder.total,
        });
        SocketService.get()?.emitToUser(req.user!.userId, 'wallet:updated', {
          userId: req.user!.userId,
          action: 'ORDER_PAYMENT',
          orderId: order.id,
          orderNumber: order.orderNumber,
          displayOrderNumber: order.displayOrderNumber,
          amount: fullOrder.total,
        });
      }
    } catch (_) {}

    // Centralized Domain Notification Event Dispatches (§1 - SOUQNAA NOTIFICATION PLATFORM)
    const sellerUserIds: string[] = [];
    try {
      notificationEventBus.publish(
        NotificationEventFactory.orderEvent({
          eventType: 'ORDER_CREATED',
          recipientId: req.user!.userId,
          orderId: order.id,
          orderNumber: order.displayOrderNumber || order.orderNumber,
          totalAmount: order.total,
        })
      );

      for (const so of createdSellerOrders) {
        const sRecord = await prisma.seller.findUnique({
          where: { id: so.sellerId },
          select: { userId: true },
        });
        if (sRecord?.userId) {
          sellerUserIds.push(sRecord.userId);
          notificationEventBus.publish(
            NotificationEventFactory.sellerOrderEvent({
              eventType: 'SELLER_NEW_ORDER',
              recipientId: sRecord.userId,
              orderId: order.id,
              orderNumber: so.sellerOrderNumber,
              totalAmount: so.sellerSubtotal,
              sellerOrderId: so.id,
            })
          );
        }
      }
    } catch (notifErr) {
      console.error('[Orders] Notification event dispatch error:', notifErr);
    }

    try {
      const socket = SocketService.get();
      if (socket) {
        socket.emitOrderStatusUpdate({
          orderId: order.id,
          orderNumber: order.orderNumber,
          status: order.status,
          parentStatus: order.status,
          version: fullOrder?.updatedAt ? fullOrder.updatedAt.getTime() : Date.now(),
          timestamp: new Date().toISOString(),
          changedByRole: 'CUSTOMER',
          customerUserId: req.user!.userId,
          sellerUserIds,
        });
        if (fullOrder) {
          socket.emitToUser(req.user!.userId, 'order:created', fullOrder);
        }
        for (const so of createdSellerOrders) {
          const sRecord = await prisma.seller.findUnique({
            where: { id: so.sellerId },
            select: { userId: true },
          });
          if (sRecord?.userId) {
            socket.emitToUser(sRecord.userId, 'order:created', {
              ...(fullOrder || order),
              sellerOrderId: so.id,
              sellerOrderNumber: so.sellerOrderNumber,
            });
          }
        }
      }
    } catch (_) {}

    ResponseUtil.created(res, fullOrder, 'تم إنشاء الطلب بنجاح');
  } catch (error) {
    if (universalReservationId) {
      ShippingPromotionReservationEngine.release({ reservationId: universalReservationId }).catch(() => {});
    }
    if (firstOrderReservationId) {
      FirstOrderPromotionReservationService.releaseReservation(firstOrderReservationId).catch(() => {});
    }
    next(error);
  }
});

// ==============================================================================
// 1.5 HELPER: BUILD AUTHORITATIVE PRISMA FILTER FOR CUSTOMER PURCHASE HISTORY
// ==============================================================================
function buildCustomerPurchaseFilterWhere(userId: string, filter: string): any {
  const f = filter.toUpperCase().trim().replace('-', '_');
  const baseWhere: any = { userId };

  switch (f) {
    case 'TO_PAY':
      return {
        ...baseWhere,
        status: {
          notIn: [
            OrderStatus.DELIVERED,
            OrderStatus.CANCELLED_BY_CUSTOMER,
            OrderStatus.CANCELLED_BY_SELLER,
            OrderStatus.REJECTED_BY_SELLER,
            OrderStatus.CANCELLED_BY_ADMIN,
          ],
        },
        OR: [
          { payment: { is: null } },
          {
            payment: {
              paidAt: null,
              method: { not: PaymentMethodType.CASH_ON_DELIVERY },
              status: { in: [PaymentStatus.PENDING, PaymentStatus.FAILED] },
            },
          },
        ],
      };

    case 'PENDING':
      return {
        ...baseWhere,
        status: OrderStatus.PENDING,
        NOT: {
          OR: [
            { payment: { is: null } },
            {
              payment: {
                paidAt: null,
                method: { not: PaymentMethodType.CASH_ON_DELIVERY },
                status: { in: [PaymentStatus.PENDING, PaymentStatus.FAILED] },
              },
            },
          ],
        },
      };

    case 'TO_SHIP':
      return {
        ...baseWhere,
        status: {
          in: [
            OrderStatus.CONFIRMED,
            OrderStatus.PROCESSING,
            OrderStatus.READY_TO_SHIP,
          ],
        },
      };

    case 'SHIPPED':
      return {
        ...baseWhere,
        status: OrderStatus.SHIPPED,
      };

    case 'TO_RECEIVE':
      return {
        ...baseWhere,
        status: OrderStatus.SHIPPED,
      };

    case 'COMPLETED':
      return {
        ...baseWhere,
        status: OrderStatus.DELIVERED,
        returnRequests: { none: {} },
        refundRequests: { none: {} },
        sellerOrders: {
          none: {
            OR: [
              { returnRequests: { some: {} } },
              { refundRequests: { some: {} } },
            ],
          },
        },
      };

    case 'REFUND':
      return {
        ...baseWhere,
        OR: [
          { status: { in: [OrderStatus.REFUND_PENDING, OrderStatus.REFUNDED] } },
          { refundRequests: { some: {} } },
          { sellerOrders: { some: { refundRequests: { some: {} } } } },
        ],
      };

    case 'RETURN':
      return {
        ...baseWhere,
        OR: [
          { status: { in: [OrderStatus.RETURN_REQUESTED, OrderStatus.RETURN_APPROVED, OrderStatus.RETURNED] } },
          { returnRequests: { some: {} } },
          { sellerOrders: { some: { returnRequests: { some: {} } } } },
        ],
      };

    case 'CANCELED':
    case 'CANCELLED':
      return {
        ...baseWhere,
        OR: [
          {
            status: {
              in: [
                OrderStatus.CANCELLED_BY_CUSTOMER,
                OrderStatus.CANCELLED_BY_SELLER,
                OrderStatus.REJECTED_BY_SELLER,
                OrderStatus.CANCELLED_BY_ADMIN,
                OrderStatus.CANCELLATION_REQUESTED,
              ],
            },
          },
          { cancellationRequests: { some: {} } },
          { sellerOrders: { some: { cancellationRequests: { some: {} } } } },
        ],
      };

    case 'TO_REVIEW':
      return {
        ...baseWhere,
        status: OrderStatus.DELIVERED,
        sellerOrders: {
          some: {
            items: {
              some: {
                productReviews: { none: {} },
              },
            },
          },
        },
      };

    case 'ALL':
    default:
      return baseWhere;
  }
}

// ==============================================================================
// 1.8 CUSTOMER PURCHASE SUMMARY (GET /api/v1/orders/summary)
// ==============================================================================
router.get('/summary', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const userId = req.user!.userId;
    const cacheKey = `order_summary:${userId}`;

    // Fast-path: Check Redis cache first (sub-millisecond return)
    const cached = await redis.get(cacheKey);
    if (cached) {
      try {
        const parsed = JSON.parse(cached);
        return ResponseUtil.success(res, parsed);
      } catch (_) {}
    }

    // 1. Fetch unread notifications referencing customer's orders
    const unreadNotifs = await prisma.notification.findMany({
      where: {
        userId,
        isRead: false,
        OR: [
          { entityType: 'order' },
          { entityType: 'ORDER' },
          { category: 'ORDER' },
        ],
      },
      select: { entityId: true },
    });
    const unreadEntityIds = new Set(unreadNotifs.map((n) => n.entityId).filter(Boolean) as string[]);

    // 2. Fetch customer's orders with selective columns to minimize payload & query duration
    const orders = await prisma.order.findMany({
      where: { userId },
      select: {
        id: true,
        orderNumber: true,
        displayOrderNumber: true,
        status: true,
        payment: { select: { status: true, method: true, paidAt: true } },
        returnRequests: { select: { id: true, status: true } },
        refundRequests: { select: { id: true, status: true } },
        cancellationRequests: { select: { id: true, status: true } },
        sellerOrders: {
          select: {
            id: true,
            sellerOrderNumber: true,
            returnRequests: { select: { id: true, status: true } },
            refundRequests: { select: { id: true, status: true } },
            cancellationRequests: { select: { id: true, status: true } },
            items: {
              select: {
                id: true,
                productReviews: { select: { id: true } },
              },
            },
          },
        },
      },
      orderBy: { createdAt: 'desc' },
    });

    const filterKeys = [
      'ALL',
      'TO_PAY',
      'PENDING',
      'TO_SHIP',
      'SHIPPED',
      'TO_RECEIVE',
      'COMPLETED',
      'REFUND',
      'RETURN',
      'CANCELED',
      'TO_REVIEW',
    ];

    const totals: Record<string, number> = {};
    const unreads: Record<string, number> = {};
    const actionables: Record<string, number> = {};

    for (const k of filterKeys) {
      totals[k] = 0;
      unreads[k] = 0;
      actionables[k] = 0;
    }

    for (const o of orders) {
      const isOrderUnread =
        unreadEntityIds.has(o.id) ||
        (o.orderNumber && unreadEntityIds.has(o.orderNumber)) ||
        (o.displayOrderNumber && unreadEntityIds.has(o.displayOrderNumber)) ||
        o.sellerOrders.some(
          (so: any) =>
            unreadEntityIds.has(so.id) ||
            (so.sellerOrderNumber && unreadEntityIds.has(so.sellerOrderNumber))
        );

      const isTerminal = (
        [
          OrderStatus.DELIVERED,
          OrderStatus.CANCELLED_BY_CUSTOMER,
          OrderStatus.CANCELLED_BY_SELLER,
          OrderStatus.REJECTED_BY_SELLER,
          OrderStatus.CANCELLED_BY_ADMIN,
        ] as OrderStatus[]
      ).includes(o.status);

      const isCod = o.payment?.method === PaymentMethodType.CASH_ON_DELIVERY;
      const isPaid = o.payment?.paidAt != null || o.payment?.status === PaymentStatus.PAID;
      const isToPay = !isTerminal && !isCod && !isPaid;

      const isPending = o.status === OrderStatus.PENDING && !isToPay;
      const isToShip = (
        [OrderStatus.CONFIRMED, OrderStatus.PROCESSING, OrderStatus.READY_TO_SHIP] as OrderStatus[]
      ).includes(o.status);
      const isShipped = o.status === OrderStatus.SHIPPED;
      const isToReceive = o.status === OrderStatus.SHIPPED;

      const hasReturns =
        (
          [OrderStatus.RETURN_REQUESTED, OrderStatus.RETURN_APPROVED, OrderStatus.RETURNED] as OrderStatus[]
        ).includes(o.status) ||
        (o.returnRequests && o.returnRequests.length > 0) ||
        o.sellerOrders.some((so: any) => so.returnRequests && so.returnRequests.length > 0);

      const hasRefunds =
        ([OrderStatus.REFUND_PENDING, OrderStatus.REFUNDED] as OrderStatus[]).includes(o.status) ||
        (o.refundRequests && o.refundRequests.length > 0) ||
        o.sellerOrders.some((so: any) => so.refundRequests && so.refundRequests.length > 0);

      const isCompleted = o.status === OrderStatus.DELIVERED && !hasReturns && !hasRefunds;

      const isCanceled =
        (
          [
            OrderStatus.CANCELLED_BY_CUSTOMER,
            OrderStatus.CANCELLED_BY_SELLER,
            OrderStatus.REJECTED_BY_SELLER,
            OrderStatus.CANCELLED_BY_ADMIN,
            OrderStatus.CANCELLATION_REQUESTED,
          ] as OrderStatus[]
        ).includes(o.status) ||
        (o.cancellationRequests && o.cancellationRequests.length > 0) ||
        o.sellerOrders.some((so: any) => so.cancellationRequests && so.cancellationRequests.length > 0);

      const isToReview =
        o.status === OrderStatus.DELIVERED &&
        o.sellerOrders.some((so: any) =>
          so.items.some((item: any) => !item.productReviews || item.productReviews.length === 0)
        );

      // ALL
      totals['ALL']++;
      if (isOrderUnread) unreads['ALL']++;

      // TO_PAY
      if (isToPay) {
        totals['TO_PAY']++;
        if (isOrderUnread) unreads['TO_PAY']++;
        actionables['TO_PAY']++;
      }

      // PENDING
      if (isPending) {
        totals['PENDING']++;
        if (isOrderUnread) unreads['PENDING']++;
      }

      // TO_SHIP
      if (isToShip) {
        totals['TO_SHIP']++;
        if (isOrderUnread) unreads['TO_SHIP']++;
      }

      // SHIPPED
      if (isShipped) {
        totals['SHIPPED']++;
        if (isOrderUnread) unreads['SHIPPED']++;
      }

      // TO_RECEIVE
      if (isToReceive) {
        totals['TO_RECEIVE']++;
        if (isOrderUnread) unreads['TO_RECEIVE']++;
        actionables['TO_RECEIVE']++;
      }

      // COMPLETED
      if (isCompleted) {
        totals['COMPLETED']++;
        if (isOrderUnread) unreads['COMPLETED']++;
      }

      // REFUND
      if (hasRefunds) {
        totals['REFUND']++;
        if (isOrderUnread) unreads['REFUND']++;
        actionables['REFUND']++;
      }

      // RETURN
      if (hasReturns) {
        totals['RETURN']++;
        if (isOrderUnread) unreads['RETURN']++;
        actionables['RETURN']++;
      }

      // CANCELED
      if (isCanceled) {
        totals['CANCELED']++;
        if (isOrderUnread) unreads['CANCELED']++;
      }

      // TO_REVIEW
      if (isToReview) {
        totals['TO_REVIEW']++;
        if (isOrderUnread) unreads['TO_REVIEW']++;
        actionables['TO_REVIEW']++;
      }
    }

    const nowIso = new Date().toISOString();
    const summaries: Record<string, any> = {};

    for (const k of filterKeys) {
      summaries[k] = {
        filter: k,
        totalCount: totals[k],
        unreadCount: unreads[k],
        actionableCount: actionables[k],
        lastUpdatedAt: nowIso,
      };
    }

    const payload = { summaries, lastUpdatedAt: nowIso };
    try {
      await redis.set(cacheKey, JSON.stringify(payload), 30);
    } catch (_) {}

    ResponseUtil.success(res, payload);
  } catch (error) {
    next(error);
  }
});

// ==============================================================================
// 1.85 MARK FILTER ORDERS AS READ (POST /api/v1/orders/mark-filter-read)
// ==============================================================================
router.post('/mark-filter-read', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const userId = req.user!.userId;
    const filter = (req.body?.filter || req.query?.filter) as string | undefined;

    const targetOrderIds: string[] = [];

    if (!filter || filter === 'ALL') {
      const orders = await prisma.order.findMany({
        where: { userId },
        select: {
          id: true,
          orderNumber: true,
          displayOrderNumber: true,
          sellerOrders: { select: { id: true, sellerOrderNumber: true } },
        },
      });
      for (const o of orders) {
        targetOrderIds.push(o.id);
        if (o.orderNumber) targetOrderIds.push(o.orderNumber);
        if (o.displayOrderNumber) targetOrderIds.push(o.displayOrderNumber);
        if (o.sellerOrders) {
          for (const so of o.sellerOrders) {
            if (so.id) targetOrderIds.push(so.id);
            if (so.sellerOrderNumber) targetOrderIds.push(so.sellerOrderNumber);
          }
        }
      }
    } else {
      const orders = await prisma.order.findMany({
        where: { userId },
        include: {
          payment: { select: { status: true, method: true, paidAt: true } },
          returnRequests: { select: { id: true, status: true } },
          refundRequests: { select: { id: true, status: true } },
          cancellationRequests: { select: { id: true, status: true } },
          sellerOrders: {
            include: {
              returnRequests: { select: { id: true, status: true } },
              refundRequests: { select: { id: true, status: true } },
              cancellationRequests: { select: { id: true, status: true } },
              items: {
                include: {
                  productReviews: { select: { id: true } },
                },
              },
            },
          },
        },
      });

      for (const o of orders) {
        const isTerminal = (
          [
            OrderStatus.DELIVERED,
            OrderStatus.CANCELLED_BY_CUSTOMER,
            OrderStatus.CANCELLED_BY_SELLER,
            OrderStatus.REJECTED_BY_SELLER,
            OrderStatus.CANCELLED_BY_ADMIN,
          ] as OrderStatus[]
        ).includes(o.status);

        const isCod = o.payment?.method === PaymentMethodType.CASH_ON_DELIVERY;
        const isPaid = o.payment?.paidAt != null || o.payment?.status === PaymentStatus.PAID;
        const isToPay = !isTerminal && !isCod && !isPaid;
        const isPending = o.status === OrderStatus.PENDING && !isToPay;
        const isToShip = (
          [OrderStatus.CONFIRMED, OrderStatus.PROCESSING, OrderStatus.READY_TO_SHIP] as OrderStatus[]
        ).includes(o.status);
        const isShipped = o.status === OrderStatus.SHIPPED;
        const isToReceive = o.status === OrderStatus.SHIPPED;

        const hasReturns =
          (
            [OrderStatus.RETURN_REQUESTED, OrderStatus.RETURN_APPROVED, OrderStatus.RETURNED] as OrderStatus[]
          ).includes(o.status) ||
          (o.returnRequests && o.returnRequests.length > 0) ||
          o.sellerOrders.some((so: any) => so.returnRequests && so.returnRequests.length > 0);

        const hasRefunds =
          ([OrderStatus.REFUND_PENDING, OrderStatus.REFUNDED] as OrderStatus[]).includes(o.status) ||
          (o.refundRequests && o.refundRequests.length > 0) ||
          o.sellerOrders.some((so: any) => so.refundRequests && so.refundRequests.length > 0);

        const isCompleted = o.status === OrderStatus.DELIVERED && !hasReturns && !hasRefunds;
        const isCanceled =
          (
            [
              OrderStatus.CANCELLED_BY_CUSTOMER,
              OrderStatus.CANCELLED_BY_SELLER,
              OrderStatus.REJECTED_BY_SELLER,
              OrderStatus.CANCELLED_BY_ADMIN,
              OrderStatus.CANCELLATION_REQUESTED,
            ] as OrderStatus[]
          ).includes(o.status) ||
          (o.cancellationRequests && o.cancellationRequests.length > 0) ||
          o.sellerOrders.some((so: any) => so.cancellationRequests && so.cancellationRequests.length > 0);

        const isToReview =
          o.status === OrderStatus.DELIVERED &&
          o.sellerOrders.some((so: any) =>
            so.items.some((item: any) => !item.productReviews || item.productReviews.length === 0)
          );

        let matches = false;
        switch (filter) {
          case 'TO_PAY': matches = isToPay; break;
          case 'PENDING': matches = isPending; break;
          case 'TO_SHIP': matches = isToShip; break;
          case 'SHIPPED': matches = isShipped; break;
          case 'TO_RECEIVE': matches = isToReceive; break;
          case 'COMPLETED': matches = isCompleted; break;
          case 'REFUND': matches = hasRefunds; break;
          case 'RETURN': matches = hasReturns; break;
          case 'CANCELED': matches = isCanceled; break;
          case 'TO_REVIEW': matches = isToReview; break;
        }

        if (matches) {
          targetOrderIds.push(o.id);
          if (o.orderNumber) targetOrderIds.push(o.orderNumber);
          if (o.displayOrderNumber) targetOrderIds.push(o.displayOrderNumber);
          if (o.sellerOrders) {
            for (const so of o.sellerOrders) {
              if (so.id) targetOrderIds.push(so.id);
              if (so.sellerOrderNumber) targetOrderIds.push(so.sellerOrderNumber);
            }
          }
        }
      }
    }

    let markedCount = 0;
    if (targetOrderIds.length > 0) {
      const updateRes = await prisma.notification.updateMany({
        where: {
          userId,
          isRead: false,
          entityId: { in: targetOrderIds },
        },
        data: {
          isRead: true,
          readAt: new Date(),
        },
      });
      markedCount = updateRes.count;
    }

    try {
      await redis.del(`order_summary:${userId}`);
      const remainingUnreadNotifs = await prisma.notification.count({
        where: { userId, isRead: false },
      });
      SocketService.get()?.emitNotificationBadge(userId, remainingUnreadNotifs);
      SocketService.get()?.emitToUser(userId, 'order:summary_updated', {
        userId,
        filter,
        markedCount,
        timestamp: new Date().toISOString(),
      });
    } catch (_) {}

    ResponseUtil.success(res, { markedCount }, 'تم تحديث حالة القراءة بنجاح');
  } catch (error) {
    next(error);
  }
});

// ==============================================================================
// 1.9 MARK ORDER AS READ (POST /api/v1/orders/:id/read)
// ==============================================================================
router.post('/:id/read', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const id = String(req.params.id);
    const userId = req.user!.userId;

    // Security & BOLA Check: verify order belongs to this customer
    const order = await prisma.order.findFirst({
      where: {
        OR: [
          { id },
          { orderNumber: id },
          { displayOrderNumber: id },
          { sellerOrders: { some: { sellerOrderNumber: id } } },
        ],
        userId,
      },
      select: {
        id: true,
        orderNumber: true,
        displayOrderNumber: true,
        sellerOrders: { select: { id: true, sellerOrderNumber: true } },
      },
    });

    if (!order) {
      return ResponseUtil.notFound(res, 'الطلب غير موجود أو غير مصرح بالوصول إليه');
    }

    const entityIds = [order.id];
    if (order.orderNumber) entityIds.push(order.orderNumber);
    if (order.displayOrderNumber) entityIds.push(order.displayOrderNumber);
    for (const so of order.sellerOrders || []) {
      if (so.id) entityIds.push(so.id);
      if (so.sellerOrderNumber) entityIds.push(so.sellerOrderNumber);
    }

    // Idempotently mark unread notifications for this order as read
    const updateRes = await prisma.notification.updateMany({
      where: {
        userId,
        isRead: false,
        entityId: { in: entityIds },
      },
      data: {
        isRead: true,
        readAt: new Date(),
      },
    });

    try {
      await redis.del(`order_summary:${userId}`);
      const remainingUnreadNotifs = await prisma.notification.count({
        where: { userId, isRead: false },
      });
      SocketService.get()?.emitNotificationBadge(userId, remainingUnreadNotifs);
      SocketService.get()?.emitToUser(userId, 'order:read', {
        orderId: order.id,
        readCount: updateRes.count,
      });
      SocketService.get()?.emitToUser(userId, 'order:summary_updated', {
        userId,
        orderId: order.id,
        timestamp: new Date().toISOString(),
      });
    } catch (_) {}

    ResponseUtil.success(
      res,
      {
        orderId: order.id,
        isRead: true,
        markedCount: updateRes.count,
      },
      'تم تحديث حالة القراءة بنجاح'
    );
  } catch (error) {
    next(error);
  }
});

// ==============================================================================
// 2. LIST CUSTOMER ORDERS (GET /api/v1/orders)
// ==============================================================================
router.get('/', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const page = req.query.page ? Math.max(1, parseInt(req.query.page as string, 10) || 1) : undefined;
    const limit = req.query.limit ? Math.min(100, Math.max(1, parseInt(req.query.limit as string, 10) || 20)) : undefined;
    const skip = page && limit ? (page - 1) * limit : undefined;
    const status = req.query.status as string | undefined;
    const filter = req.query.filter as string | undefined;

    let where: any;
    if (filter && filter !== 'ALL') {
      where = buildCustomerPurchaseFilterWhere(req.user!.userId, filter);
    } else if (status && status !== 'ALL') {
      where = { userId: req.user!.userId, status: status as OrderStatus };
    } else {
      where = { userId: req.user!.userId };
    }

    const [orders, total] = await Promise.all([
      prisma.order.findMany({
        where,
        include: {
          sellerOrders: {
            include: {
              seller: { include: { stores: { select: { name: true, logo: true } } } },
              items: {
                include: {
                  productReviews: {
                    where: { userId: req.user!.userId },
                    select: { id: true, rating: true },
                  },
                  product: {
                    select: {
                      id: true,
                      nameAr: true,
                      nameEn: true,
                      images: { select: { url: true }, orderBy: { sortOrder: 'asc' }, take: 1 },
                    },
                  },
                  variant: { select: { id: true, image: true } },
                },
              },
              returnRequests: { orderBy: { createdAt: 'desc' } },
              refundRequests: {
                include: { evidence: true, items: true, reason: true },
                orderBy: { createdAt: 'desc' },
              },
            },
          },
          addressSnapshot: true,
          payment: true,
          statusHistory: { orderBy: { createdAt: 'desc' } },
          cancellationRequests: { orderBy: { createdAt: 'desc' } },
          returnRequests: { orderBy: { createdAt: 'desc' } },
          refundRequests: {
            include: { evidence: true, items: true, reason: true },
            orderBy: { createdAt: 'desc' },
          },
        },
        orderBy: { createdAt: 'desc' },
        ...(skip !== undefined ? { skip } : {}),
        ...(limit !== undefined ? { take: limit } : {}),
      }),
      prisma.order.count({ where }),
    ]);

    const orderIds = orders.map((o) => o.id);
    const orderNumbers = orders.map((o) => o.orderNumber);
    const displayOrderNumbers = orders.map((o) => o.displayOrderNumber).filter(Boolean) as string[];
    const sellerOrderIds: string[] = [];
    const sellerOrderNumbers: string[] = [];
    for (const o of orders) {
      for (const so of o.sellerOrders || []) {
        if (so.id) sellerOrderIds.push(so.id);
        if (so.sellerOrderNumber) sellerOrderNumbers.push(so.sellerOrderNumber);
      }
    }

    const allEntityIds = [
      ...orderIds,
      ...orderNumbers,
      ...displayOrderNumbers,
      ...sellerOrderIds,
      ...sellerOrderNumbers,
    ];

    const [disputes, unreadNotifs] = await Promise.all([
      prisma.dispute.findMany({
        where: {
          orderId: { in: allEntityIds },
        },
        orderBy: { createdAt: 'desc' },
      }),
      prisma.notification.findMany({
        where: {
          userId: req.user!.userId,
          isRead: false,
          entityId: { in: allEntityIds },
        },
        select: { entityId: true },
      }),
    ]);

    const unreadSet = new Set(unreadNotifs.map((n) => n.entityId).filter(Boolean) as string[]);

    const enrichedOrders = orders.map((order) => {
      const matchIds = [order.id, order.orderNumber, order.displayOrderNumber].filter(Boolean) as string[];
      for (const so of order.sellerOrders || []) {
        if (so.id) matchIds.push(so.id);
        if (so.sellerOrderNumber) matchIds.push(so.sellerOrderNumber);
      }
      const sellerOrdersEnriched = (order.sellerOrders || []).map((so) => ({
        ...so,
        items: (so.items || []).map((item: any) => ({
          ...item,
          productImage: item.variant?.image || item.product?.images?.[0]?.url || item.productImage || null,
        })),
      }));
      return {
        ...order,
        sellerOrders: sellerOrdersEnriched,
        disputes: disputes.filter((d) => matchIds.includes(d.orderId)),
        isUnread: matchIds.some((id) => unreadSet.has(id)),
      };
    });

    const meta = page && limit ? {
      page,
      limit,
      total,
      totalPages: Math.ceil(total / limit),
    } : undefined;

    ResponseUtil.success(res, enrichedOrders, undefined, 200, meta);
  } catch (error) {
    next(error);
  }
});

// ==============================================================================
// 3. GET ORDER DETAILS (GET /api/v1/orders/:id)
// ==============================================================================
router.get('/:id', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const id = String(req.params.id);
    const order = await prisma.order.findFirst({
      where: {
        OR: [
          { id },
          { orderNumber: id },
          { displayOrderNumber: id },
          { sellerOrders: { some: { sellerOrderNumber: id } } },
        ],
        userId: req.user!.userId,
      },
      include: {
        sellerOrders: {
          include: {
            seller: { include: { stores: true } },
            items: {
              include: {
                product: {
                  select: {
                    id: true,
                    nameAr: true,
                    nameEn: true,
                    images: { select: { url: true }, orderBy: { sortOrder: 'asc' }, take: 1 },
                  },
                },
                variant: { select: { id: true, image: true } },
              },
            },
            cancellationRequests: true,
            returnRequests: { orderBy: { createdAt: 'desc' } },
            refundRequests: {
              include: { evidence: true, items: true, reason: true },
              orderBy: { createdAt: 'desc' },
            },
            statusHistory: { orderBy: { createdAt: 'asc' } },
          },
        },
        addressSnapshot: true,
        payment: true,
        statusHistory: { orderBy: { createdAt: 'asc' } },
        cancellationRequests: { orderBy: { createdAt: 'desc' } },
        returnRequests: { orderBy: { createdAt: 'desc' } },
        refundRequests: {
          include: { evidence: true, items: true, reason: true },
          orderBy: { createdAt: 'desc' },
        },
        taxSnapshots: true,
      },
    });

    if (!order) throw new AppError('الطلب غير موجود', 404);

    const orderAliases = [order.id, order.orderNumber, order.displayOrderNumber].filter(Boolean) as string[];
    for (const so of order.sellerOrders || []) {
      if (so.id) orderAliases.push(so.id);
      if (so.sellerOrderNumber) orderAliases.push(so.sellerOrderNumber);
    }

    const [disputes, unreadNotif] = await Promise.all([
      prisma.dispute.findMany({
        where: {
          orderId: { in: orderAliases },
        },
        orderBy: { createdAt: 'desc' },
      }),
      prisma.notification.findFirst({
        where: {
          userId: req.user!.userId,
          isRead: false,
          entityId: { in: orderAliases },
        },
        select: { id: true },
      }),
    ]);

    const sellerOrdersWithDisputes = order.sellerOrders.map(so => ({
      ...so,
      items: (so.items || []).map((item: any) => ({
        ...item,
        productImage: item.variant?.image || item.product?.images?.[0]?.url || item.productImage || null,
      })),
      disputes: disputes.filter(d => d.sellerId === so.sellerId || !d.sellerId),
    }));

    ResponseUtil.success(res, {
      ...order,
      sellerOrders: sellerOrdersWithDisputes,
      disputes,
      isUnread: Boolean(unreadNotif),
    });
  } catch (error) {
    next(error);
  }
});

// ==============================================================================
// 3.1 DIGITAL INVOICE / RECEIPT (GET /api/v1/orders/:id/invoice)
// ==============================================================================
router.get(['/:id/invoice', '/:id/receipt'], async (req: Request, res: Response, next: NextFunction) => {
  try {
    const id = String(req.params.id);
    const order = await prisma.order.findFirst({
      where: {
        OR: [
          { id },
          { orderNumber: id },
          { displayOrderNumber: id },
          { sellerOrders: { some: { sellerOrderNumber: id } } },
        ],
        userId: req.user!.userId,
      },
      include: {
        sellerOrders: {
          include: {
            seller: { include: { stores: true } },
            items: true,
          },
        },
        addressSnapshot: true,
        payment: true,
        user: { select: { firstName: true, lastName: true, phone: true } },
      },
    });

    if (!order) throw new AppError('الطلب غير موجود', 404);

    const invoiceData = OrderInvoiceService.buildInvoiceData(order);

    if (req.query.format === 'html' || req.headers.accept?.includes('text/html')) {
      res.setHeader('Content-Type', 'text/html; charset=utf-8');
      return res.send(OrderInvoiceService.renderHtmlReceipt(invoiceData));
    }

    ResponseUtil.success(res, invoiceData, 'تم استرجاع بيانات الفاتورة بنجاح');
  } catch (error) {
    next(error);
  }
});

// POST /api/v1/orders/:id/invoice/email — Send invoice directly via email
router.post('/:id/invoice/email', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const id = String(req.params.id);
    const { email } = req.body;
    const locale = (req.headers['accept-language']?.includes('en') ? 'en' : 'ar') as 'ar' | 'en';

    const order = await prisma.order.findFirst({
      where: {
        OR: [{ id }, { orderNumber: id }],
        ...(req.user?.role !== 'ADMIN' ? { userId: req.user!.userId } : {}),
      },
      include: {
        sellerOrders: {
          include: {
            seller: { include: { stores: true } },
            items: true,
          },
        },
        addressSnapshot: true,
        payment: true,
        user: { select: { firstName: true, lastName: true, phone: true, email: true } },
      },
    });

    if (!order) throw new AppError('الطلب غير موجود', 404);

    const result = await OrderInvoiceService.sendInvoiceEmail(order, email, locale);
    ResponseUtil.success(res, result, 'تم إرسال الفاتورة عبر البريد الإلكتروني بنجاح');
  } catch (error) {
    next(error);
  }
});

// ==============================================================================
// 4. CUSTOMER CANCEL ORDER IMMEDIATELY (POST /api/v1/orders/:id/cancel)
// Only valid when status === 'PENDING'
// ==============================================================================
router.post('/:id/cancel', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const id = String(req.params.id);
    const { reason, note } = req.body;

    const order = await prisma.order.findFirst({
      where: {
        OR: [{ id }, { orderNumber: id }],
        userId: req.user!.userId,
      },
    });

    if (!order) throw new AppError('الطلب غير موجود', 404);

    if (order.status !== OrderStatus.PENDING) {
      throw new AppError(
        'لا يمكن إلغاء الطلب فورياً في حالته الحالية. يرجى تقديم طلب إلغاء ليتم مراجعته من قبل المتجر.',
        400
      );
    }

    const updated = await OrderStateMachine.transitionOrder({
      orderId: order.id,
      targetStatus: OrderStatus.CANCELLED_BY_CUSTOMER,
      changedBy: req.user!.userId,
      changedByRole: 'CUSTOMER',
      reason: reason || 'CUSTOMER_CHANGED_MIND',
      note: note || 'إلغاء فوري للطلب من قبل العميل',
    });

    // Release slot booking if any
    await deliverySlotService.releaseSlot(order.id);

    ResponseUtil.success(res, updated, 'تم إلغاء الطلب بنجاح وتحرير المخزون');
  } catch (error) {
    next(error);
  }
});

// ==============================================================================
// 5. CUSTOMER REQUEST CANCELLATION (POST /api/v1/orders/:id/cancellation-request)
// Valid when status is CONFIRMED, PROCESSING, READY_TO_SHIP
// ==============================================================================
router.post('/:id/cancellation-request', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const id = String(req.params.id);
    const { reason, description, sellerOrderId } = req.body;

    if (!reason) throw new AppError('سبب طلب الإلغاء مطلوب', 400);

    const order = await prisma.order.findFirst({
      where: {
        OR: [{ id }, { orderNumber: id }],
        userId: req.user!.userId,
      },
      include: {
        sellerOrders: {
          include: {
            seller: { select: { id: true, userId: true } },
          },
        },
      },
    });

    if (!order) throw new AppError('الطلب غير موجود', 404);

    const validStatuses = [
      OrderStatus.CONFIRMED,
      OrderStatus.PROCESSING,
    ];

    if (!validStatuses.includes(order.status as any)) {
      if (order.status === OrderStatus.READY_TO_SHIP) {
        throw new AppError('تم تجهيز الطلب للشحن ولا يمكن إلغاؤه في هذه المرحلة وفقاً لسياسة المنصة.', 400);
      }
      if (order.status === OrderStatus.SHIPPED) {
        throw new AppError('الطلب قيد التوصيل والشحن حالياً ولا يمكن إلغاؤه.', 400);
      }
      if (order.status === OrderStatus.DELIVERED) {
        throw new AppError('تم تسليم الطلب بالفعل، لا يمكن الإلغاء. يرجى استخدام طلب الاسترجاع (Return/Refund).', 400);
      }
      throw new AppError(
        `لا يمكن طلب إلغاء طلب في حالة: [${order.status}].`,
        400
      );
    }

    const effectiveSellerOrderId = sellerOrderId || (order.sellerOrders.length === 1 ? order.sellerOrders[0].id : null);

    const cancellationRequest = await prisma.$transaction(async (tx) => {
      // 1. Create cancellation request
      const reqRecord = await tx.cancellationRequest.create({
        data: {
          orderId: order.id,
          sellerOrderId: effectiveSellerOrderId,
          requestedBy: req.user!.userId,
          requestedByRole: 'CUSTOMER',
          reason,
          description: description || null,
          status: CancellationRequestStatus.PENDING,
        },
      });

      // 2. Mark order and target seller order status
      await tx.order.update({
        where: { id: order.id },
        data: { status: OrderStatus.CANCELLATION_REQUESTED },
      });

      if (effectiveSellerOrderId) {
        await tx.sellerOrder.update({
          where: { id: effectiveSellerOrderId },
          data: { status: SellerOrderStatus.CANCELLATION_REQUESTED },
        });
      } else {
        await tx.sellerOrder.updateMany({
          where: { orderId: order.id },
          data: { status: SellerOrderStatus.CANCELLATION_REQUESTED },
        });
      }

      // 3. Log status history
      await tx.orderStatusHistory.create({
        data: {
          orderId: order.id,
          sellerOrderId: sellerOrderId || null,
          fromStatus: order.status,
          toStatus: 'CANCELLATION_REQUESTED',
          status: OrderStatus.CANCELLATION_REQUESTED,
          changedBy: req.user!.userId,
          changedByRole: 'CUSTOMER',
          reason,
          note: `طلب العميل إلغاء الطلب: ${reason}`,
        },
      });

      return reqRecord;
    });

    // Notify sellers via Push, In-App Notifications and Sockets
    try {
      const targetSellerOrders = effectiveSellerOrderId
        ? order.sellerOrders.filter((s) => s.id === effectiveSellerOrderId)
        : order.sellerOrders;

      for (const so of targetSellerOrders) {
        const sellerUserId = so.seller?.userId;
        if (sellerUserId) {
          // 1. In-App Notification in DB
          await prisma.notification.create({
            data: {
              userId: sellerUserId,
              recipientType: 'SELLER',
              category: 'ORDER',
              priority: 'HIGH',
              titleAr: 'طلب إلغاء من العميل ⚠️',
              titleEn: 'Customer Cancellation Request ⚠️',
              bodyAr: `طلب العميل إلغاء الطلب #${order.orderNumber}. السبب: ${reason}`,
              bodyEn: `Customer requested cancellation for order #${order.orderNumber}. Reason: ${reason}`,
              type: NotificationType.ORDER_STATUS,
              data: JSON.stringify({
                orderId: order.id,
                orderNumber: order.orderNumber,
                sellerOrderId: so.id,
                requestId: cancellationRequest.id,
                reason,
              }),
              deepLink: `souqnaa://seller/orders/${order.id}`,
              status: 'SENT',
              isRead: false,
            },
          });

          // 2. Push Notification via Dispatcher
          notificationDispatcher.dispatch(
            NotificationEventFactory.sellerCancellationRequestedEvent({
              recipientId: sellerUserId,
              orderId: order.id,
              orderNumber: order.orderNumber,
              sellerOrderId: so.id,
              reason,
            })
          ).catch(() => {});
        }
      }

      SocketService.get()?.emitGlobal('order:cancellation_requested', {
        orderId: order.id,
        orderNumber: order.orderNumber,
        requestId: cancellationRequest.id,
        reason,
      });
      SocketService.get()?.emitOrderStatusUpdate({
        orderId: order.id,
        orderNumber: order.orderNumber,
        displayOrderNumber: order.displayOrderNumber || undefined,
        sellerOrderId: sellerOrderId || undefined,
        customerUserId: order.userId,
        sellerUserIds: targetSellerOrders.map((s) => s.seller?.userId).filter(Boolean) as string[],
        status: OrderStatus.CANCELLATION_REQUESTED,
        changedByRole: 'CUSTOMER',
        extra: { previousStatus: order.status },
      });
    } catch (_) {}

    ResponseUtil.created(
      res,
      cancellationRequest,
      'تم إرسال طلب الإلغاء بنجاح وسيتم مراجعته من قبل المتجر'
    );
  } catch (error) {
    next(error);
  }
});

// ==============================================================================
// 6. CUSTOMER CONFIRM DELIVERY (POST /api/v1/orders/:id/confirm-delivery)
// Valid when status === 'SHIPPED'
// ==============================================================================
router.post(['/:id/confirm-delivery', '/:id/confirm-received', '/:id/received'], async (req: Request, res: Response, next: NextFunction) => {
  try {
    const id = String(req.params.id);

    const order = await prisma.order.findFirst({
      where: {
        OR: [{ id }, { orderNumber: id }],
        userId: req.user!.userId,
      },
    });

    if (!order) throw new AppError('الطلب غير موجود', 404);

    if (order.status !== OrderStatus.SHIPPED) {
      throw new AppError('لا يمكن تأكيد الاستلام إلا للطلبات المشحونة', 400);
    }

    const updated = await OrderStateMachine.transitionOrder({
      orderId: order.id,
      targetStatus: OrderStatus.DELIVERED,
      changedBy: req.user!.userId,
      changedByRole: 'CUSTOMER',
      note: 'تم تأكيد استلام الشحنة من قبل العميل بنجاح',
    });

    const fullUpdatedOrder = await prisma.order.findUnique({
      where: { id: order.id },
      include: {
        sellerOrders: {
          include: {
            items: true,
            seller: { select: { id: true, userId: true } },
          },
        },
        statusHistory: { orderBy: { createdAt: 'desc' } },
        payment: true,
        deliveryAddress: true,
      },
    });

    ResponseUtil.success(res, fullUpdatedOrder || updated, 'تم تأكيد استلام الطلب بنجاح، شكراً لتسوقك معنا!');
  } catch (error) {
    next(error);
  }
});

// ==============================================================================
// 6.5. MOCK / REAL PAYMENT CONFIRMATION (POST /api/v1/orders/:id/mock-pay)
// ==============================================================================
router.post(['/:id/mock-pay', '/:id/pay'], async (req: Request, res: Response, next: NextFunction) => {
  try {
    if (process.env.NODE_ENV === 'production') {
      throw new AppError('عمليات الدفع التجريبية معطلة في بيئة الإنتاج. يرجى استخدام بوابات الدفع الرسمية.', 403, 'MOCK_PAY_FORBIDDEN_IN_PRODUCTION');
    }

    const id = String(req.params.id);
    const { gateway = 'Mada (Mock)' } = req.body;

    const order = await prisma.order.findFirst({
      where: {
        OR: [{ id }, { orderNumber: id }],
        userId: req.user!.userId,
      },
      include: { payment: true },
    });

    if (!order) throw new AppError('الطلب غير موجود', 404);

    if (order.status !== OrderStatus.PENDING) {
      throw new AppError(`لا يمكن الدفع لطلب بحالة: ${order.status}`, 400);
    }

    const txnId = `TXN-MOCK-${Date.now()}`;
    await prisma.$transaction(async (tx) => {
      let paymentRecord = await tx.payment.findUnique({ where: { orderId: order.id } });

      if (paymentRecord) {
        paymentRecord = await tx.payment.update({
          where: { id: paymentRecord.id },
          data: {
            status: PaymentStatus.PAID, // MOCK-PAY DEV ONLY (guarded by NODE_ENV !== 'production')
            transactionId: txnId,
            paidAt: new Date(),
          },
        });
      } else {
        paymentRecord = await tx.payment.create({
          data: {
            orderId: order.id,
            method: PaymentMethodType.MADA,
            amount: order.total,
            status: PaymentStatus.PAID, // MOCK-PAY DEV ONLY (guarded by NODE_ENV !== 'production')
            transactionId: txnId,
            paidAt: new Date(),
          },
        });
      }

      await tx.paymentTransaction.create({
        data: {
          paymentId: paymentRecord.id,
          gateway,
          referenceId: txnId,
          amount: order.total,
          status: PaymentStatus.PAID, // MOCK-PAY DEV ONLY (guarded by NODE_ENV !== 'production')
        },
      });
    });

    // Fetch order with updated payment info - Order stays PENDING until seller accepts!
    const updatedOrder = await prisma.order.findUnique({
      where: { id: order.id },
      include: {
        sellerOrders: {
          include: {
            seller: { include: { stores: { select: { name: true, logo: true } } } },
            items: true,
            statusHistory: { orderBy: { createdAt: 'desc' } },
            cancellationRequests: true,
          },
        },
        addressSnapshot: true,
        payment: true,
        statusHistory: { orderBy: { createdAt: 'asc' } },
      },
    });

    try {
      SocketService.get()?.emitGlobal('order:paid', {
        orderId: order.id,
        orderNumber: order.orderNumber,
        amount: order.total,
      });
    } catch (_) {}

    ResponseUtil.success(res, updatedOrder, 'تم تسجيل الدفع بنجاح. الطلب الآن بانتظار قبول المتجر');
  } catch (error) {
    next(error);
  }
});

// ==============================================================================
// 7. CUSTOMER REQUEST RETURN (POST /api/v1/orders/:id/return-request or /return)
// Valid when status is SHIPPED or DELIVERED
// ==============================================================================
router.post(['/:id/return-request', '/:id/return'], async (req: Request, res: Response, next: NextFunction) => {
  try {
    const id = String(req.params.id);
    const { reason, description, sellerOrderId, images, evidence } = req.body;

    if (!reason) throw new AppError('سبب طلب الإرجاع مطلوب', 400);

    const order = await prisma.order.findFirst({
      where: {
        OR: [{ id }, { orderNumber: id }],
        userId: req.user!.userId,
      },
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

    if (order.status !== OrderStatus.SHIPPED && order.status !== OrderStatus.DELIVERED) {
      throw new AppError('طلب الإرجاع متاح فقط للطلبات المشحونة أو المستلمة', 400);
    }
    const targetSellerOrderId = sellerOrderId || (order.sellerOrders.length > 0 ? order.sellerOrders[0].id : null);

    const returnRequest = await prisma.$transaction(async (tx) => {
      const targetSellerOrder = targetSellerOrderId
        ? order.sellerOrders.find((s) => s.id === targetSellerOrderId)
        : order.sellerOrders[0];
      const targetSellerId = targetSellerOrder?.sellerId || order.sellerOrders[0]?.sellerId;
      const requestedAmt = targetSellerOrder
        ? Math.max(
            0,
            parseFloat(
              (
                targetSellerOrder.subtotal +
                (targetSellerOrder.customerDeliveryCharge ?? targetSellerOrder.deliveryFee ?? 0) +
                (targetSellerOrder.taxAmount ?? 0) -
                (targetSellerOrder.voucherDiscountAmount ?? 0)
              ).toFixed(2)
            )
          )
        : Number(order.total || order.subtotal);

      // Create ReturnRequest with PENDING status for seller review
      const retRecord = await tx.returnRequest.create({
        data: {
          orderId: order.id,
          sellerOrderId: targetSellerOrderId,
          customerId: req.user!.userId,
          reason,
          description: description || null,
          status: ReturnRequestStatus.PENDING,
          refundAmount: requestedAmt,
        },
      });

      // Prepare evidence URLs
      let evidenceList: { fileUrl: string; mimeType?: string }[] = [];
      if (Array.isArray(images)) {
        evidenceList = images
          .filter((img) => img && (typeof img === 'string' ? img.trim().length > 0 : img.fileUrl))
          .map((img) => (typeof img === 'string' ? { fileUrl: img } : img));
      } else if (Array.isArray(evidence)) {
        evidenceList = evidence
          .filter((ev) => ev && (typeof ev === 'string' ? ev.trim().length > 0 : ev.fileUrl))
          .map((ev) => (typeof ev === 'string' ? { fileUrl: ev } : ev));
      }

      // Also create authoritative RefundRequest with UNDER_SELLER_REVIEW status for seller dashboard
      if (targetSellerId) {
        const refundNumber = `RF-${Date.now().toString(36).toUpperCase()}-${Math.floor(100 + Math.random() * 900)}`;

        await tx.refundRequest.create({
          data: {
            refundNumber,
            orderId: order.id,
            sellerOrderId: targetSellerOrderId,
            customerId: req.user!.userId,
            sellerId: targetSellerId,
            status: RefundStatus.UNDER_SELLER_REVIEW,
            reasonText: reason,
            description: description || null,
            customerNote: description || null,
            requestedAmount: requestedAmt,
            currency: order.currency || 'YER',
            items: targetSellerOrder?.items && targetSellerOrder.items.length > 0
              ? {
                  create: targetSellerOrder.items.map((it) => ({
                    orderItemId: it.id,
                    productId: it.productId,
                    variantId: it.variantId || null,
                    quantity: it.quantity,
                    requestedAmount: it.totalPrice,
                  })),
                }
              : undefined,
            evidence: evidenceList.length > 0
              ? {
                  create: evidenceList.map((ev) => ({
                    uploadedBy: req.user!.userId,
                    uploadedByRole: 'CUSTOMER' as any,
                    fileUrl: ev.fileUrl,
                    fileType: 'image/jpeg',
                    mimeType: ev.mimeType || 'image/jpeg',
                  })),
                }
              : undefined,
            statusHistory: {
              create: [
                {
                  fromStatus: null,
                  toStatus: RefundStatus.UNDER_SELLER_REVIEW,
                  changedBy: req.user!.userId,
                  actorType: 'CUSTOMER' as any,
                  reason: 'تقديم طلب الإرجاع من قبل العميل للمراجعة من قبل المتجر',
                },
              ],
            },
          },
        });
      }

      await tx.order.update({
        where: { id: order.id },
        data: { status: OrderStatus.RETURN_REQUESTED },
      });

      if (targetSellerOrderId) {
        await tx.sellerOrder.update({
          where: { id: targetSellerOrderId },
          data: { status: SellerOrderStatus.RETURN_REQUESTED },
        });
      } else {
        await tx.sellerOrder.updateMany({
          where: { orderId: order.id },
          data: { status: SellerOrderStatus.RETURN_REQUESTED },
        });
      }

      await tx.orderStatusHistory.create({
        data: {
          orderId: order.id,
          sellerOrderId: targetSellerOrderId,
          fromStatus: order.status,
          toStatus: 'RETURN_REQUESTED',
          status: OrderStatus.RETURN_REQUESTED,
          changedBy: req.user!.userId,
          changedByRole: 'CUSTOMER',
          reason,
          note: `تم تقديم طلب الإرجاع وهو قيد مراجعة المتجر: ${reason}${description ? ` - ${description}` : ''}`,
        },
      });

      return retRecord;
    });

    try {
      SocketService.get()?.emitGlobal('order:return_requested', {
        orderId: order.id,
        orderNumber: order.orderNumber,
        reason,
        description,
      });
      SocketService.get()?.emitOrderStatusUpdate({
        orderId: order.id,
        orderNumber: order.orderNumber,
        displayOrderNumber: order.displayOrderNumber || undefined,
        sellerOrderId: targetSellerOrderId || undefined,
        customerUserId: order.userId,
        status: OrderStatus.RETURN_REQUESTED,
        changedByRole: 'CUSTOMER',
        extra: { previousStatus: order.status },
      });
      SocketService.get()?.emitGlobal('REFUND_CREATED', {
        orderId: order.id,
        orderNumber: order.orderNumber,
        reason,
      });
      SocketService.get()?.emitGlobal('order:refund_updated', {
        orderId: order.id,
        status: 'RETURN_REQUESTED',
      });
    } catch (_) {}

    ResponseUtil.created(res, returnRequest, 'تم تقديم طلب الإرجاع بنجاح وجارٍ مراجعته من قبل المتجر');
  } catch (error) {
    next(error);
  }
});

// ==============================================================================
// 8. DISPUTES (POST /api/v1/orders/:id/disputes)
// ==============================================================================
router.post(['/:id/disputes', '/:id/dispute'], async (req: Request, res: Response, next: NextFunction) => {
  try {
    const orderId = String(req.params.id);
    const { sellerId, reason, description } = req.body;
    if (!reason || !description) throw new AppError('سبب وتفاصيل النزاع مطلوبة', 400);

    const order = await prisma.order.findFirst({
      where: {
        OR: [{ id: orderId }, { orderNumber: orderId }],
        userId: req.user!.userId,
      },
      include: { sellerOrders: true },
    });

    if (!order) throw new AppError('الطلب غير موجود', 404);

    const targetSellerId = sellerId || order.sellerOrders[0]?.sellerId;
    if (!targetSellerId) throw new AppError('التاجر المعني بالنزاع غير محدد', 400);

    // Validate that the customer has not already accepted the seller rejection / closed the case
    const closedRefund = await prisma.refundRequest.findFirst({
      where: {
        orderId: order.id,
        status: RefundStatus.CLOSED,
      },
    });
    if (closedRefund) {
      throw new AppError('لا يمكن تصعيد النزاع للإدارة بعد قبول قرار المتجر وإغلاق القضية نهائياً', 400);
    }

    const closedReturn = await prisma.returnRequest.findFirst({
      where: {
        orderId: order.id,
        status: ReturnRequestStatus.COMPLETED,
      },
    });
    if (closedReturn) {
      throw new AppError('لا يمكن تصعيد النزاع للإدارة بعد قبول قرار المتجر وإغلاق القضية نهائياً', 400);
    }

    const closedHistory = await prisma.orderStatusHistory.findFirst({
      where: {
        orderId: order.id,
        OR: [
          { note: 'CLOSED_BY_CUSTOMER' },
          { reason: { contains: 'قبول العميل لقرار المتجر' } },
        ],
      },
    });
    if (closedHistory) {
      throw new AppError('لا يمكن تصعيد النزاع للإدارة بعد قبول قرار المتجر وإغلاق القضية نهائياً', 400);
    }

    // Validate if dispute was already resolved or rejected
    const resolvedDispute = await prisma.dispute.findFirst({
      where: {
        OR: [{ orderId: order.id }, { orderId: order.orderNumber }],
        status: { in: [DisputeStatus.RESOLVED, DisputeStatus.REJECTED] },
      },
    });
    if (resolvedDispute) {
      throw new AppError('تم البت في النزاع مسبقاً من قبل الإدارة ولا يمكن فتح نزاع جديد لهذا الطلب', 400);
    }

    // Validate that only ONE report to admin is allowed
    const existingOpenDispute = await prisma.dispute.findFirst({
      where: {
        OR: [{ orderId: order.id }, { orderId: order.orderNumber }],
        status: { in: [DisputeStatus.OPEN, DisputeStatus.UNDER_REVIEW] },
      },
    });
    if (existingOpenDispute) {
      throw new AppError('تم تصعيد هذا النزاع للإدارة مسبقاً وهو قيد المراجعة حالياً، ولا يمكن تقديم أكثر من بلاغ واحد', 400);
    }

    const existingAdminRefund = await prisma.refundRequest.findFirst({
      where: {
        orderId: order.id,
        status: { in: [RefundStatus.ADMIN_REVIEW, RefundStatus.DISPUTED] },
      },
    });
    if (existingAdminRefund) {
      throw new AppError('تم تصعيد هذا الطلب للإدارة مسبقاً وهو قيد التحكيم حالياً، ولا يمكن تقديم أكثر من بلاغ واحد', 400);
    }

    // Create the dispute
    const dispute = await prisma.dispute.create({
      data: {
        customerId: req.user!.userId,
        sellerId: targetSellerId,
        orderId: order.id,
        reason,
        description,
        status: DisputeStatus.OPEN,
        refundAmount: order.total,
        adminNotes: `تم فتح النزاع من قبل العميل على الطلب #${order.orderNumber}`,
      },
    });

    // Ensure a related RefundRequest exists with status ADMIN_REVIEW so it appears in Seller Disputes
    let refundReq = await prisma.refundRequest.findFirst({
      where: { orderId: order.id },
      orderBy: { createdAt: 'desc' },
    });

    if (!refundReq) {
      refundReq = await prisma.refundRequest.create({
        data: {
          refundNumber: `REF-DSP-${dispute.id.substring(0, 8)}`,
          orderId: order.id,
          customerId: req.user!.userId,
          sellerId: targetSellerId,
          status: RefundStatus.ADMIN_REVIEW,
          reasonText: reason,
          description,
          requestedAmount: order.total,
        },
      });
    } else {
      await prisma.refundRequest.update({
        where: { id: refundReq.id },
        data: {
          status: RefundStatus.ADMIN_REVIEW,
        },
      });
    }

    // Record Status History
    await prisma.refundStatusHistory.create({
      data: {
        refundRequestId: refundReq.id,
        fromStatus: refundReq.status,
        toStatus: RefundStatus.ADMIN_REVIEW,
        changedBy: req.user!.userId,
        actorType: RefundActorType.CUSTOMER,
        reason: `تصعيد نزاع #${dispute.id}: ${reason}`,
      },
    });

    // Notify Seller, Admins and Customer via Unified Notification Dispatcher (In-App + Push + Realtime)
    try {
      const targetSeller = await prisma.seller.findUnique({
        where: { id: targetSellerId },
        select: { userId: true },
      });

      if (targetSeller?.userId) {
        // Dispatches canonical In-App DB record, FCM Push notification, and WebSocket alerts
        await notificationDispatcher.dispatch(
          NotificationEventFactory.disputeEvent({
            eventType: 'DISPUTE_SELLER_NOTIFIED',
            recipientId: targetSeller.userId,
            disputeId: dispute.id,
            orderId: order.id,
            orderNumber: order.orderNumber,
            refundId: refundReq.id,
            reason,
            deadline: '48h',
            recipientRole: 'SELLER',
          })
        );

        // Targeted socket alerts for seller
        const socketSvc = SocketService.get();
        if (socketSvc) {
          socketSvc.emitToUser(targetSeller.userId, 'dispute:created', {
            disputeId: dispute.id,
            orderId: order.id,
            orderNumber: order.orderNumber,
            refundId: refundReq.id,
            reason,
            status: dispute.status,
            createdAt: dispute.createdAt,
          });
          socketSvc.emitToUser(targetSeller.userId, 'refund:disputed', {
            disputeId: dispute.id,
            refundId: refundReq.id,
            orderId: order.id,
            status: 'ADMIN_REVIEW',
          });
        }
      }

      // Notify Customer of successful dispute submission
      notificationDispatcher.dispatch(
        NotificationEventFactory.disputeEvent({
          eventType: 'DISPUTE_CREATED',
          recipientId: req.user!.userId,
          disputeId: dispute.id,
          orderId: order.id,
          orderNumber: order.orderNumber,
          refundId: refundReq.id,
          reason,
          recipientRole: 'CUSTOMER',
        })
      ).catch(() => {});

      SocketService.get()?.emitGlobal('admin:new_dispute', {
        disputeId: dispute.id,
        refundId: refundReq.id,
        orderId: order.id,
        orderNumber: order.orderNumber,
        customerId: req.user!.userId,
        sellerId: targetSellerId,
        reason,
      });
      SocketService.get()?.emitGlobal('dispute:created', {
        orderId: order.id,
        disputeId: dispute.id,
        refundId: refundReq.id,
      });
      SocketService.get()?.emitGlobal('refund:disputed', {
        orderId: order.id,
        refundId: refundReq.id,
        status: 'ADMIN_REVIEW',
      });
    } catch (_) {}

    ResponseUtil.created(res, dispute, 'تم فتح تذكرة النزاع بنجاح وسيقوم فريق الدعم بمراجعتها');
  } catch (error) {
    next(error);
  }
});

export const orderRoutes = router;
