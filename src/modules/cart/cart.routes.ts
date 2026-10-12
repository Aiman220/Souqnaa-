import { Router, Request, Response, NextFunction } from 'express';
import { prisma } from '../../database/prisma';
import { authenticate } from '../../middleware/auth.middleware';
import { ResponseUtil } from '../../utils/response.util';
import { AppError } from '../../middleware/error.middleware';
import { TaxEngine } from '../tax/tax.service';
import { SellerFinancialRiskService } from '../commission/seller-financial-risk.service';
import { CartAbandonmentJob } from '../../services/jobs/cart-abandonment.job';
import { cartAbandonmentService } from './abandonment/cart-abandonment.service';
import { FlashSaleService } from '../flash-sales/flash-sale.service';

const router = Router();
router.use(authenticate);

// GET /api/v1/cart — Multi-vendor grouped cart
router.get('/', async (req: Request, res: Response, next: NextFunction) => {
  try {
    let cart = await prisma.cart.findUnique({
      where: { userId: req.user!.userId },
      include: {
        items: {
          include: {
            product: {
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
                    cashOnDeliveryEnabled: true,
                    createdAt: true,
                  },
                },
                images: { where: { isPrimary: true } },
              },
            },

            variant: true,
          },
        },
      },
    });

    if (!cart) {
      cart = await prisma.cart.create({
        data: { userId: req.user!.userId },
        include: { items: { include: { product: { include: { store: true, images: true } }, variant: true } } },
      });
    }

    // Revalidate and Group items by store for multi-vendor checkout
    const storeMap: Record<string, { store: any; items: any[]; subtotal: number }> = {};
    const now = new Date();

    let subtotal = 0;
    for (const item of cart.items) {
      const storeId = item.product.storeId;
      let unitPrice = item.variant?.price ?? item.product.price;
      let isFlashSaleActive = false;
      let reservationExpired = false;

      // Flash Sale revalidation
      if (item.isFlashSale && item.flashSaleReservationId) {
        const resRecord = await prisma.flashSaleReservation.findUnique({
          where: { id: item.flashSaleReservationId },
          include: { flashSaleItem: true },
        });

        if (
          resRecord &&
          resRecord.status === 'RESERVED' &&
          resRecord.expiresAt > now &&
          resRecord.flashSaleItem.status === 'ACTIVE'
        ) {
          unitPrice = item.flashSaleUnitPrice ?? resRecord.unitPrice;
          isFlashSaleActive = true;
        } else {
          reservationExpired = true;
          // Clean up expired flash sale reference from cart item
          await prisma.cartItem.update({
            where: { id: item.id },
            data: {
              isFlashSale: false,
              flashSaleReservationId: null,
              flashSaleItemId: null,
            },
          });
        }
      }

      const itemTotal = unitPrice * item.quantity;
      subtotal += itemTotal;

      if (!storeMap[storeId]) {
        storeMap[storeId] = {
          store: item.product.store,
          items: [],
          subtotal: 0,
        };
      }

      storeMap[storeId].items.push({
        ...item,
        unitPrice,
        itemTotal,
        isFlashSale: isFlashSaleActive,
        reservationExpired,
        reservationExpiresAt: isFlashSaleActive ? item.reservationExpiresAt : null,
      });
      storeMap[storeId].subtotal += itemTotal;
    }

    const stores = Object.values(storeMap);

    // Calculate authoritative tax preview for cart
    const taxCalculationItems = cart.items.map((ci) => {
      let unitPrice = ci.variant?.price ?? ci.product.price;
      if (ci.isFlashSale && ci.flashSaleUnitPrice) {
        unitPrice = ci.flashSaleUnitPrice;
      }
      return {
        id: ci.id,
        productId: ci.productId,
        variantId: ci.variantId || null,
        sellerId: ci.product.store?.sellerId || '',
        categoryId: ci.product.categoryId || null,
        productNameAr: ci.product.nameAr,
        productNameEn: ci.product.nameEn,
        unitPrice,
        quantity: ci.quantity,
      };
    });

    const taxResult = await TaxEngine.calculateCartTax({
      items: taxCalculationItems,
      customerId: req.user!.userId,
    });

    // Authoritative multi-vendor COD availability
    const sellerIds = Array.from(new Set(stores.map((s: any) => s.store.sellerId).filter(Boolean)));
    const codEval = await SellerFinancialRiskService.evaluateCodEligibility({
      sellerIds,
      customerId: req.user!.userId,
    });

    ResponseUtil.success(res, {
      cartId: cart.id,
      stores,
      itemCount: cart.items.reduce((acc, i) => acc + i.quantity, 0),
      subtotal,
      couponCode: cart.couponCode,
      taxAmount: taxResult.totalTax,
      taxableSubtotal: taxResult.taxableSubtotal,
      taxSummary: taxResult.tax,
      estimatedTotal: taxResult.grandTotal,
      isCodAvailable: codEval.isCodAvailable,
      codReason: codEval.reason,
    });

    // Notify Cart Abandonment Engine of cart activity
    cartAbandonmentService.onCartOpened(req.user!.userId).catch(console.error);
  } catch (error) {
    next(error);
  }
});

// POST /api/v1/cart/items — Add item to cart
router.post('/items', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const {
      productId,
      variantId,
      quantity = 1,
      isFlashSale = false,
      flashSaleItemId,
      flashSaleReservationId,
    } = req.body;

    const reqQty = parseInt(String(quantity), 10) || 1;

    // Validate product and stock
    const product = await prisma.product.findUnique({
      where: { id: productId },
      include: { variants: true, inventory: true },
    });
    if (!product) {
      throw new AppError('المنتج غير موجود', 404);
    }

    const variant = variantId ? product.variants.find(v => v.id === variantId) : null;
    const availableStock = variant
      ? variant.stockQuantity
      : (product.inventory ? Math.max(0, product.inventory.quantity - (product.inventory.reserved || 0)) : 0);

    if (availableStock <= 0) {
      throw new AppError('عذراً، هذا المنتج نفد من المخزون', 400);
    }

    let cart = await prisma.cart.findUnique({ where: { userId: req.user!.userId } });
    if (!cart) {
      cart = await prisma.cart.create({ data: { userId: req.user!.userId } });
    }

    let validFlashSale = false;
    let unitPriceFlashSale: number | null = null;
    let expiresAtFlashSale: Date | null = null;
    let resolvedFlashSaleItemId = flashSaleItemId ? String(flashSaleItemId) : null;
    let resolvedReservationId = flashSaleReservationId ? String(flashSaleReservationId) : null;

    if (isFlashSale && flashSaleReservationId && flashSaleItemId) {
      const resRecord = await prisma.flashSaleReservation.findUnique({
        where: { id: String(flashSaleReservationId) },
        include: { flashSaleItem: true },
      });

      if (
        resRecord &&
        resRecord.customerId === req.user!.userId &&
        resRecord.flashSaleItemId === flashSaleItemId &&
        resRecord.status === 'RESERVED' &&
        resRecord.expiresAt > new Date()
      ) {
        validFlashSale = true;
        unitPriceFlashSale = resRecord.unitPrice;
        expiresAtFlashSale = resRecord.expiresAt;
        resolvedReservationId = resRecord.id;
        resolvedFlashSaleItemId = resRecord.flashSaleItemId;
      }
    }

    // Anti-overselling auto-reservation fallback: if flash sale requested or product in flash sale without active reservation
    if ((isFlashSale || flashSaleItemId) && !validFlashSale) {
      const now = new Date();
      let targetFlashItem = null;

      if (resolvedFlashSaleItemId) {
        targetFlashItem = await prisma.flashSaleItem.findFirst({
          where: {
            id: resolvedFlashSaleItemId,
            status: 'ACTIVE',
            campaign: {
              status: 'ACTIVE',
              startAt: { lte: now },
              endAt: { gte: now },
            },
          },
        });
      } else {
        targetFlashItem = await prisma.flashSaleItem.findFirst({
          where: {
            productId,
            variantId: variantId || null,
            status: 'ACTIVE',
            campaign: {
              status: 'ACTIVE',
              startAt: { lte: now },
              endAt: { gte: now },
            },
          },
        });
      }

      if (targetFlashItem) {
        try {
          const autoReservation = await FlashSaleService.getInstance().reserveStock({
            flashSaleItemId: targetFlashItem.id,
            customerId: req.user!.userId,
            quantity: reqQty,
            cartId: cart.id,
          });

          validFlashSale = true;
          resolvedFlashSaleItemId = targetFlashItem.id;
          resolvedReservationId = autoReservation.id;
          unitPriceFlashSale = autoReservation.unitPrice;
          expiresAtFlashSale = autoReservation.expiresAt;
        } catch (resErr: any) {
          if (resErr?.code === 'FLASH_SALE_STOCK_UNAVAILABLE' || resErr?.message?.includes('unavailable')) {
            throw new AppError('عذراً، نفدت كمية العرض الخاطف المتوفرة لهذا المنتج', 400);
          }
          if (resErr?.code === 'FLASH_SALE_CUSTOMER_LIMIT_REACHED' || resErr?.message?.includes('limit')) {
            throw new AppError('عذراً، لقد تجاوزت الحد الأقصى المسموح لشرائه من هذا العرض الخاطف', 400);
          }
          throw resErr;
        }
      } else if (isFlashSale || flashSaleItemId) {
        throw new AppError('عذراً، انتهى العرض الخاطف لهذا المنتج أو غير متاح حالياً', 400);
      }
    }

    const existing = await prisma.cartItem.findFirst({
      where: {
        cartId: cart.id,
        productId,
        variantId: variantId || null,
      },
    });

    const targetQuantity = existing ? existing.quantity + reqQty : reqQty;
    if (availableStock !== null && availableStock !== undefined && targetQuantity > availableStock) {
      throw new AppError(`عذراً، لا يمكن إضافة أكثر من ${availableStock} قطع المتوفرة في المخزون`, 400);
    }

    let item;
    if (existing) {
      item = await prisma.cartItem.update({
        where: { id: existing.id },
        data: {
          quantity: targetQuantity,
          isFlashSale: validFlashSale,
          flashSaleItemId: validFlashSale ? resolvedFlashSaleItemId : null,
          flashSaleReservationId: validFlashSale ? resolvedReservationId : null,
          flashSaleUnitPrice: validFlashSale ? unitPriceFlashSale : null,
          reservationExpiresAt: validFlashSale ? expiresAtFlashSale : null,
        },
      });
    } else {
      item = await prisma.cartItem.create({
        data: {
          cartId: cart.id,
          productId,
          variantId: variantId || null,
          quantity: targetQuantity,
          isFlashSale: validFlashSale,
          flashSaleItemId: validFlashSale ? resolvedFlashSaleItemId : null,
          flashSaleReservationId: validFlashSale ? resolvedReservationId : null,
          flashSaleUnitPrice: validFlashSale ? unitPriceFlashSale : null,
          reservationExpiresAt: validFlashSale ? expiresAtFlashSale : null,
        },
      });
    }

    // Notify Cart Abandonment Engine of cart update
    CartAbandonmentJob.onCartUpdated(cart.id, req.user!.userId).catch(console.error);

    ResponseUtil.success(res, item, 'Item added to cart');
  } catch (error) {
    next(error);
  }
});

// PUT /api/v1/cart/items/:id — Update quantity
router.put('/items/:id', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const id = String(req.params.id);
    const { quantity } = req.body;
    const qty = parseInt(String(quantity), 10);

    if (qty <= 0) {
      const itemRecord = await prisma.cartItem.findUnique({
        where: { id },
        select: { cartId: true, flashSaleReservationId: true },
      });
      if (itemRecord?.flashSaleReservationId) {
        await FlashSaleService.getInstance()
          .releaseReservation(itemRecord.flashSaleReservationId, req.user!.userId, 'CART_REMOVED')
          .catch(console.error);
      }
      await prisma.cartItem.delete({ where: { id } });
      if (itemRecord) {
        CartAbandonmentJob.onCartUpdated(itemRecord.cartId, req.user!.userId).catch(console.error);
      }
      return ResponseUtil.success(res, null, 'Item removed from cart');
    }

    const cartItem = await prisma.cartItem.findUnique({
      where: { id },
      include: { product: { include: { inventory: true } }, variant: true },
    });

    if (!cartItem) {
      throw new AppError('عنصر السلة غير موجود', 404);
    }

    const availableStock = cartItem.variant
      ? cartItem.variant.stockQuantity
      : (cartItem.product.inventory ? Math.max(0, cartItem.product.inventory.quantity - (cartItem.product.inventory.reserved || 0)) : 0);

    if (availableStock <= 0) {
      throw new AppError('عذراً، هذا المنتج نفد من المخزون', 400);
    }
    if (qty > availableStock) {
      throw new AppError(`عذراً، الكمية المتاحة في المخزون هي ${availableStock} فقط`, 400);
    }

    const item = await prisma.cartItem.update({
      where: { id },
      data: { quantity: qty },
    });

    // Notify Cart Abandonment Engine of cart update
    CartAbandonmentJob.onCartUpdated(cartItem.cartId, req.user!.userId).catch(console.error);

    ResponseUtil.success(res, item, 'Cart updated');
  } catch (error) {
    next(error);
  }
});

// DELETE /api/v1/cart/items/:id — Remove item
router.delete('/items/:id', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const id = String(req.params.id);
    const itemRecord = await prisma.cartItem.findUnique({
      where: { id },
      select: { cartId: true, flashSaleReservationId: true },
    });

    if (itemRecord?.flashSaleReservationId) {
      await FlashSaleService.getInstance()
        .releaseReservation(itemRecord.flashSaleReservationId, req.user!.userId, 'CART_REMOVED')
        .catch(console.error);
    }

    await prisma.cartItem.delete({ where: { id } });

    if (itemRecord) {
      CartAbandonmentJob.onCartUpdated(itemRecord.cartId, req.user!.userId).catch(console.error);
    }

    ResponseUtil.success(res, null, 'Item removed from cart');
  } catch (error) {
    next(error);
  }
});

// DELETE /api/v1/cart/clear — Clear cart
router.delete('/clear', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const cart = await prisma.cart.findUnique({ where: { userId: req.user!.userId } });
    if (cart) {
      await prisma.cartItem.deleteMany({ where: { cartId: cart.id } });
      await cartAbandonmentService.onCartCleared(req.user!.userId).catch(console.error);
    }
    ResponseUtil.success(res, null, 'Cart cleared');
  } catch (error) {
    next(error);
  }
});

// POST /api/v1/cart/coupon — Apply coupon
router.post('/coupon', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const { code } = req.body;
    const coupon = await prisma.coupon.findUnique({
      where: { code: code.toUpperCase() },
    });

    if (!coupon || !coupon.isActive || coupon.validUntil < new Date()) {
      throw new AppError('Invalid or expired coupon code', 400);
    }

    await prisma.cart.update({
      where: { userId: req.user!.userId },
      data: { couponCode: coupon.code },
    });

    ResponseUtil.success(res, {
      code: coupon.code,
      discountType: coupon.discountType,
      discountValue: coupon.discountValue,
    }, 'Coupon applied successfully');
  } catch (error) {
    next(error);
  }
});

export const cartRoutes = router;
