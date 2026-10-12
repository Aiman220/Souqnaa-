import crypto from 'crypto';
import { prisma } from '../../database/prisma';
import { config } from '../../config';
import { AppError } from '../../middleware/error.middleware';
import {
  GuestSessionInfo,
  GuestCartValidationRequest,
  GuestCartValidationResponse,
  GuestCartItemOutput,
  GuestStoreGroup,
  GuestWishlistItemInput,
  GuestWishlistValidationResponse,
  GuestCheckoutPrepareRequest,
  GuestCheckoutPrepareResponse,
  GuestMergeRequest,
  GuestMergeResponse,
} from './guest.types';

// In-memory set of merged session IDs to prevent replay attacks
const mergedSessions = new Set<string>();

export class GuestService {
  /**
   * 1. Create or restore a secure guest session identifier.
   * Identifier is unique, random UUID v4, and has a 30-day expiration policy.
   */
  static createOrRestoreSession(clientSessionId?: string): GuestSessionInfo {
    const now = new Date();
    const expiresAt = new Date(now.getTime() + 30 * 24 * 60 * 60 * 1000); // 30 days

    let sessionId = clientSessionId?.trim();
    // Validate UUID format: 8-4-4-4-12 hex digits
    const uuidRegex = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
    if (!sessionId || !uuidRegex.test(sessionId) || mergedSessions.has(sessionId)) {
      sessionId = crypto.randomUUID();
    }

    return {
      guestSessionId: sessionId,
      createdAt: now.toISOString(),
      expiresAt: expiresAt.toISOString(),
    };
  }

  /**
   * 2. Authoritative Server-side Guest Cart Validation (§7)
   * Never trusts local prices, stock, or eligibility.
   * Validates product, variant, store, active stock, flash sale, coupon, and groupings.
   */
  static async validateCart(request: GuestCartValidationRequest): Promise<GuestCartValidationResponse> {
    const { items = [], couponCode } = request;
    const warnings: string[] = [];
    let priceChanged = false;
    let quantityAdjusted = false;
    let outOfStock = false;

    const storeMap: Record<string, GuestStoreGroup> = {};
    let subtotal = 0;
    let totalItemCount = 0;
    const now = new Date();

    for (const item of items) {
      if (!item.productId) continue;

      const product = await prisma.product.findUnique({
        where: { id: item.productId },
        include: {
          store: {
            select: {
              id: true,
              sellerId: true,
              name: true,
              slug: true,
              logo: true,
              latitude: true,
              longitude: true,
              isActive: true,
              isVerified: true,
            },
          },
          variants: true,
          inventory: true,
          images: { where: { isPrimary: true }, take: 1 },
        },
      });

      if (!product) {
        warnings.push('المنتج غير متوفر أو تم حذفه');
        outOfStock = true;
        continue;
      }

      if (!product.store.isActive) {
        warnings.push(`متجر "${product.store.name}" غير متاح حالياً`);
        continue;
      }

      // Resolve variant
      const variant = item.variantId ? product.variants.find(v => v.id === item.variantId) : null;

      // Authoritative Stock Check
      const availableStock = variant
        ? variant.stockQuantity
        : (product.inventory ? Math.max(0, product.inventory.quantity - (product.inventory.reserved || 0)) : 0);

      if (availableStock <= 0) {
        const pName = product.nameAr || product.nameEn;
        warnings.push(`نفد مخزون المنتج "${pName}"`);
        outOfStock = true;
        continue;
      }

      // Quantity adjustment
      let effectiveQuantity = Math.max(1, item.quantity);
      if (effectiveQuantity > availableStock) {
        const pName = product.nameAr || product.nameEn;
        warnings.push(`تم تعديل كمية "${pName}" من ${effectiveQuantity} إلى ${availableStock} (الحد الأقصى المتاح)`);
        effectiveQuantity = availableStock;
        quantityAdjusted = true;
      }

      // Authoritative Price Check
      let unitPrice = variant ? variant.price : product.price;
      let compareAtPrice = variant ? variant.compareAtPrice : product.compareAtPrice;
      let isFlashSaleActive = false;

      // Check for active Flash Sale on this product/variant
      const activeFlashSaleItem = await prisma.flashSaleItem.findFirst({
        where: {
          productId: product.id,
          variantId: variant?.id || null,
          status: 'ACTIVE',
          campaign: {
            status: 'ACTIVE',
            startAt: { lte: now },
            endAt: { gte: now },
          },
          remainingStock: { gt: 0 },
        },
      });

      if (activeFlashSaleItem) {
        unitPrice = activeFlashSaleItem.flashSalePrice;
        compareAtPrice = activeFlashSaleItem.originalPrice;
        isFlashSaleActive = true;
      }

      // Check if price changed from last known local price
      if (item.lastKnownPrice !== undefined && item.lastKnownPrice !== null && Math.abs(item.lastKnownPrice - unitPrice) > 0.01) {
        const pName = product.nameAr || product.nameEn;
        warnings.push(`تغير سعر المنتج "${pName}" من ${item.lastKnownPrice} إلى ${unitPrice} ${config.marketplace.currency}`);
        priceChanged = true;
      }

      const itemTotal = unitPrice * effectiveQuantity;
      subtotal += itemTotal;
      totalItemCount += effectiveQuantity;

      const storeId = product.storeId;
      if (!storeMap[storeId]) {
        storeMap[storeId] = {
          store: {
            id: product.store.id,
            sellerId: product.store.sellerId,
            name: product.store.name,
            slug: product.store.slug,
            logo: product.store.logo,
            isActive: product.store.isActive,
            isVerified: product.store.isVerified,
          },
          items: [],
          subtotal: 0,
        };
      }

      const primaryImg = product.images.length > 0 ? product.images[0].url : item.lastKnownImage || null;

      const itemOutput: GuestCartItemOutput = {
        id: item.id || (variant ? `${product.id}_${variant.id}` : product.id),
        productId: product.id,
        variantId: variant?.id || null,
        storeId: product.store.id,
        storeName: product.store.name,
        productName: product.nameEn,
        productNameAr: product.nameAr,
        image: primaryImg,
        unitPrice,
        compareAtPrice,
        quantity: effectiveQuantity,
        itemTotal,
        isAvailable: true,
        stock: availableStock,
        isFlashSale: isFlashSaleActive,
        flashSaleReservationId: isFlashSaleActive ? activeFlashSaleItem?.id : null,
      };

      storeMap[storeId].items.push(itemOutput);
      storeMap[storeId].subtotal += itemTotal;
    }

    // Coupon / Voucher evaluation
    let discountAmount = 0;
    let appliedCoupon: string | null = null;

    if (couponCode && couponCode.trim().length > 0) {
      const codeUpper = couponCode.trim().toUpperCase();
      const coupon = await prisma.coupon.findUnique({
        where: { code: codeUpper },
      });

      if (!coupon || !coupon.isActive || coupon.validUntil < now) {
        warnings.push(`كوبون الخصم "${codeUpper}" غير صالح أو منتهي الصلاحية`);
      } else if (coupon.minOrderValue && subtotal < coupon.minOrderValue) {
        warnings.push(`كوبون الخصم يتطلب حداً أدنى للطلب ${coupon.minOrderValue} ${config.marketplace.currency}`);
      } else {
        appliedCoupon = coupon.code;
        if (coupon.discountType === 'PERCENTAGE') {
          discountAmount = (subtotal * coupon.discountValue) / 100;
          if (coupon.maxDiscount && discountAmount > coupon.maxDiscount) {
            discountAmount = coupon.maxDiscount;
          }
        } else {
          discountAmount = Math.min(coupon.discountValue, subtotal);
        }
      }
    }

    return {
      valid: warnings.length === 0,
      cartId: 'guest-cart',
      stores: Object.values(storeMap),
      itemCount: totalItemCount,
      subtotal,
      couponCode: appliedCoupon,
      discountAmount,
      currency: config.marketplace.currency,
      warnings,
      priceChanged,
      quantityAdjusted,
      outOfStock,
    };
  }

  /**
   * 3. Authoritative Guest Wishlist Validation (§11, §12)
   * Returns live pricing, stock availability, and price-drop calculations.
   */
  static async validateWishlist(items: GuestWishlistItemInput[]): Promise<GuestWishlistValidationResponse> {
    const validatedItems: GuestWishlistValidationResponse['items'] = [];

    for (const item of items) {
      if (!item.productId) continue;

      const product = await prisma.product.findUnique({
        where: { id: item.productId },
        include: {
          store: { select: { id: true, name: true } },
          variants: true,
          inventory: true,
          images: { where: { isPrimary: true }, take: 1 },
        },
      });

      if (!product) continue;

      const variant = item.variantId ? product.variants.find(v => v.id === item.variantId) : null;
      const currentPrice = variant ? variant.price : product.price;
      const compareAtPrice = variant ? variant.compareAtPrice : product.compareAtPrice;
      const addedPrice = item.addedPrice && item.addedPrice > 0 ? item.addedPrice : currentPrice;

      const availableStock = variant
        ? variant.stockQuantity
        : (product.inventory ? Math.max(0, product.inventory.quantity - (product.inventory.reserved || 0)) : 0);

      const isPriceDropped = addedPrice > currentPrice;
      const priceDropAmount = isPriceDropped ? addedPrice - currentPrice : 0;
      const priceDropPercentage = isPriceDropped && addedPrice > 0 ? Math.round((priceDropAmount / addedPrice) * 100) : 0;

      validatedItems.push({
        productId: product.id,
        variantId: variant?.id || null,
        productName: product.nameEn,
        productNameAr: product.nameAr,
        storeId: product.store.id,
        storeName: product.store.name,
        image: product.images.length > 0 ? product.images[0].url : null,
        currentPrice,
        compareAtPrice,
        isInStock: availableStock > 0,
        availableStock,
        isPriceDropped,
        priceDropAmount,
        priceDropPercentage,
        currency: config.marketplace.currency,
      });
    }

    return {
      items: validatedItems,
      totalCount: validatedItems.length,
    };
  }

  /**
   * 4. Guest Checkout Preparation (§14, §15, §16, §17, §18, §19, §20)
   * Resolves contact, address, delivery fees, campaign subsidies, and recalculates authoritative totals.
   */
  static async prepareCheckout(request: GuestCheckoutPrepareRequest): Promise<GuestCheckoutPrepareResponse> {
    const {
      guestSessionId,
      items,
      contact,
      address,
      deliveryMethodCode = 'standard',
      isExpress = false,
      deliveryScheduleType = 'ASAP',
      deliveryDate,
      deliveryTimeSlotId,
      couponCode,
      paymentMethod = 'CASH_ON_DELIVERY',
    } = request;

    const warnings: string[] = [];

    // 1. Contact validation
    if (!contact.fullName || contact.fullName.trim().length < 2) {
      warnings.push('يرجى إدخال اسم المستلم بالكامل');
    }
    const cleanPhone = (contact.phoneNumber || '').replace(/\s+/g, '');
    if (!cleanPhone || cleanPhone.length < 7) {
      warnings.push('يرجى إدخال رقم هاتف صحيح للتواصل');
    }

    // 2. Address validation
    if (!address.city || address.city.trim().length === 0) {
      warnings.push('يرجى تحديد المدينة');
    }
    if (!address.street || address.street.trim().length === 0) {
      warnings.push('يرجى إدخال عنوان الشارع والحي');
    }

    // 3. Cart Validation
    const cartValidation = await this.validateCart({ items, couponCode });
    warnings.push(...cartValidation.warnings);

    if (cartValidation.stores.length === 0) {
      throw new AppError('سلة المشتريات فارغة أو تحتوي على منتجات غير متاحة', 400);
    }

    // 4. Delivery Calculation via SOUQNAA delivery rules
    const baseDeliveryPerStore = config.marketplace.baseDeliveryFee;
    const expressSurcharge = isExpress ? config.marketplace.expressFeeFixed : 0;
    let totalCalculatedFee = (baseDeliveryPerStore * cartValidation.stores.length) + expressSurcharge;

    // Slot fee if scheduled
    let slotFee = 0;
    if (deliveryScheduleType === 'SCHEDULED' && deliveryTimeSlotId) {
      const slot = await prisma.deliveryTimeSlot.findUnique({
        where: { id: deliveryTimeSlotId },
      });
      if (slot) slotFee = slot.slotFee;
    }
    totalCalculatedFee += slotFee;

    // Check Mega Campaign / Free Delivery threshold & platform subsidy (§18)
    let deliverySubsidy = 0;
    let deliveryDiscount = 0;
    let fundingSource: 'PLATFORM' | 'SELLER' | 'CUSTOMER' = 'CUSTOMER';

    if (cartValidation.subtotal >= config.marketplace.freeDeliveryThreshold) {
      deliverySubsidy = totalCalculatedFee;
      deliveryDiscount = totalCalculatedFee;
      fundingSource = 'PLATFORM';
    }

    const customerDeliveryCharge = Math.max(0, totalCalculatedFee - deliverySubsidy);
    const finalTotal = Math.max(0, cartValidation.subtotal - cartValidation.discountAmount + customerDeliveryCharge);

    // Available Payment methods
    const availablePaymentMethods = [
      {
        code: 'CASH_ON_DELIVERY',
        nameAr: 'الدفع عند الاستلام',
        nameEn: 'Cash on Delivery',
        requiresAccount: false,
        descriptionAr: 'ادفع نقداً عند وصول مندوب التوصيل إلى باب منزلك.',
      },
      {
        code: 'YEMENI_WALLET',
        nameAr: 'المحافظ الإلكترونية اليمنية',
        nameEn: 'Yemeni Digital Wallets',
        requiresAccount: true,
        descriptionAr: 'الكريمي (حاسب)، جوالي، ون كاش، جيب، فلوسك.',
      },
      {
        code: 'SOUQNAAPAY',
        nameAr: 'محفظة سوقناا Pay',
        nameEn: 'Souqnaa Pay Wallet',
        requiresAccount: true,
        descriptionAr: 'الدفع الفوري من رصيد محفظتك الرقمية في سوقناا.',
      },
    ];

    return {
      valid: warnings.length === 0,
      guestSessionId,
      contact,
      address,
      deliverySelection: {
        deliveryMethodCode,
        isExpress,
        deliveryScheduleType,
        deliveryDate,
        deliveryTimeSlotId,
      },
      stores: cartValidation.stores,
      financials: {
        subtotal: cartValidation.subtotal,
        discountAmount: cartValidation.discountAmount,
        calculatedDeliveryFee: totalCalculatedFee,
        deliveryDiscount,
        deliverySubsidy,
        customerDeliveryCharge,
        fundingSource,
        total: finalTotal,
        currency: config.marketplace.currency,
      },
      warnings,
      requiresAuthToFinalize: true, // Final order placement requires registered account
      availablePaymentMethods,
    };
  }

  /**
   * 5. Deterministic Cart & Wishlist Merge on Authentication (§21, §22, §23, §24)
   * Safely migrates guest cart and wishlist into authenticated customer account.
   */
  static async mergeSession(
    userId: string,
    request: GuestMergeRequest
  ): Promise<GuestMergeResponse> {
    const { guestSessionId, cartItems = [], wishlistItems = [] } = request;

    if (mergedSessions.has(guestSessionId)) {
      // Prevent duplicate merge replay
      const existingCart = await prisma.cart.findUnique({
        where: { userId },
        include: { items: { include: { product: { include: { store: true } }, variant: true } } },
      });
      return {
        success: true,
        mergedCartItemCount: 0,
        mergedWishlistItemCount: 0,
        adjustments: ['الجلسة مدمجة مسبقاً.'],
        cart: existingCart,
      };
    }

    const adjustments: string[] = [];
    let mergedCartCount = 0;
    let mergedWishlistCount = 0;

    // 1. Cart Merge
    let userCart = await prisma.cart.findUnique({ where: { userId } });
    if (!userCart) {
      userCart = await prisma.cart.create({ data: { userId } });
    }

    for (const item of cartItems) {
      if (!item.productId) continue;

      const product = await prisma.product.findUnique({
        where: { id: item.productId },
        include: { variants: true, inventory: true },
      });

      if (!product) continue;

      const variant = item.variantId ? product.variants.find(v => v.id === item.variantId) : null;
      const availableStock = variant
        ? variant.stockQuantity
        : (product.inventory ? Math.max(0, product.inventory.quantity - (product.inventory.reserved || 0)) : 0);

      if (availableStock <= 0) {
        adjustments.push(`المنتج "${product.nameAr || product.nameEn}" نفد من المخزون ولم تتم إضافته إلى السلة.`);
        continue;
      }

      // Check if user already has this product + variant in DB cart
      const existingDbItem = await prisma.cartItem.findFirst({
        where: {
          cartId: userCart.id,
          productId: product.id,
          variantId: variant?.id || null,
        },
      });

      const requestedQty = Math.max(1, item.quantity);

      if (existingDbItem) {
        const combinedQty = existingDbItem.quantity + requestedQty;
        const finalQty = Math.min(combinedQty, availableStock);
        if (finalQty < combinedQty) {
          adjustments.push(`تم تقليص كمية "${product.nameAr || product.nameEn}" إلى ${finalQty} المتوفرة في المخزون.`);
        }
        await prisma.cartItem.update({
          where: { id: existingDbItem.id },
          data: { quantity: finalQty },
        });
        mergedCartCount++;
      } else {
        const finalQty = Math.min(requestedQty, availableStock);
        if (finalQty < requestedQty) {
          adjustments.push(`تم تقليص كمية "${product.nameAr || product.nameEn}" إلى ${finalQty} المتوفرة في المخزون.`);
        }
        await prisma.cartItem.create({
          data: {
            cartId: userCart.id,
            productId: product.id,
            variantId: variant?.id || null,
            quantity: finalQty,
          },
        });
        mergedCartCount++;
      }
    }

    // 2. Wishlist Merge (Deduplicated)
    let userWishlist = await prisma.wishlist.findUnique({ where: { userId } });
    if (!userWishlist) {
      userWishlist = await prisma.wishlist.create({ data: { userId } });
    }

    for (const wItem of wishlistItems) {
      if (!wItem.productId) continue;

      const product = await prisma.product.findUnique({
        where: { id: wItem.productId },
        include: { variants: true },
      });

      if (!product) continue;

      const variant = wItem.variantId ? product.variants.find(v => v.id === wItem.variantId) : null;

      const existingWishlistItem = await prisma.wishlistItem.findFirst({
        where: {
          wishlistId: userWishlist.id,
          productId: product.id,
          variantId: variant?.id || null,
        },
      });

      if (!existingWishlistItem) {
        const currentPrice = variant ? variant.price : product.price;
        await prisma.wishlistItem.create({
          data: {
            wishlistId: userWishlist.id,
            productId: product.id,
            variantId: variant?.id || null,
            addedPrice: wItem.addedPrice || currentPrice,
            currentPrice,
            priceCurrency: config.marketplace.currency,
          },
        });
        mergedWishlistCount++;
      }
    }

    // Mark guest session as merged to prevent replay
    mergedSessions.add(guestSessionId);

    // Fetch full updated user cart
    const finalCart = await prisma.cart.findUnique({
      where: { userId },
      include: {
        items: {
          include: {
            product: {
              include: {
                store: true,
                images: { where: { isPrimary: true } },
              },
            },
            variant: true,
          },
        },
      },
    });

    return {
      success: true,
      mergedCartItemCount: mergedCartCount,
      mergedWishlistItemCount: mergedWishlistCount,
      adjustments,
      cart: finalCart,
    };
  }
}
