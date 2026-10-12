import { prisma } from '../../database/prisma';
import { AppError } from '../../middleware/error.middleware';
import { NotificationType, WishlistAlertType, WishlistAlertStatus } from '@prisma/client';
import { NotificationEventFactory } from '../notifications/events/domain-events';
import { notificationDispatcher } from '../notifications/services/notification-dispatcher';

export interface WishlistQueryOptions {
  page?: number;
  limit?: number;
  cursor?: string;
  filter?: 'all' | 'in_stock' | 'out_of_stock' | 'price_dropped';
  sortBy?: 'recent' | 'price_asc' | 'price_desc' | 'price_drop';
}

export interface MoveAllToCartResult {
  moved: Array<{ itemId: string; productId: string; nameAr: string; nameEn: string; price: number }>;
  unavailable: Array<{ itemId: string; productId: string; nameAr: string; nameEn: string; reason: string }>;
  failed: Array<{ itemId: string; productId: string; nameAr: string; nameEn: string; error: string }>;
}

export class WishlistService {
  /**
   * Get or create customer's wishlist container
   */
  static async getOrCreateWishlist(userId: string) {
    let wishlist = await prisma.wishlist.findUnique({
      where: { userId },
    });

    if (!wishlist) {
      wishlist = await prisma.wishlist.create({
        data: { userId },
      });
    }

    return wishlist;
  }

  /**
   * Get lightweight wishlist item count for badges and navigation
   */
  static async getWishlistCount(userId: string): Promise<number> {
    const wishlist = await prisma.wishlist.findUnique({
      where: { userId },
      select: { id: true },
    });

    if (!wishlist) return 0;

    return prisma.wishlistItem.count({
      where: { wishlistId: wishlist.id },
    });
  }

  /**
   * Check membership for a single product (and optional variant)
   */
  static async isWishlisted(userId: string, productId: string, variantId?: string | null): Promise<boolean> {
    const wishlist = await prisma.wishlist.findUnique({
      where: { userId },
      select: { id: true },
    });

    if (!wishlist) return false;

    const count = await prisma.wishlistItem.count({
      where: {
        wishlistId: wishlist.id,
        productId,
        variantId: variantId || null,
      },
    });

    return count > 0;
  }

  /**
   * Bulk check membership for multiple product IDs (e.g. For product grids)
   */
  static async checkManyWishlist(userId: string, productIds: string[]): Promise<Record<string, boolean>> {
    const result: Record<string, boolean> = {};
    for (const pid of productIds) {
      result[pid] = false;
    }

    if (productIds.length === 0) return result;

    const wishlist = await prisma.wishlist.findUnique({
      where: { userId },
      select: { id: true },
    });

    if (!wishlist) return result;

    const items = await prisma.wishlistItem.findMany({
      where: {
        wishlistId: wishlist.id,
        productId: { in: productIds },
      },
      select: { productId: true },
    });

    for (const item of items) {
      result[item.productId] = true;
    }

    return result;
  }

  /**
   * Get paginated wishlist with authoritative current pricing, real-time inventory, and price-drop metadata
   */
  static async getWishlist(userId: string, options: WishlistQueryOptions = {}) {
    const { page = 1, limit = 20, cursor, filter = 'all', sortBy = 'recent' } = options;

    const wishlist = await this.getOrCreateWishlist(userId);

    // Fetch raw items with product, variant, inventory, images, and store
    const rawItems = await prisma.wishlistItem.findMany({
      where: { wishlistId: wishlist.id },
      include: {
        product: {
          include: {
            images: { orderBy: { isPrimary: 'desc' } },
            store: {
              select: {
                id: true,
                sellerId: true,
                name: true,
                slug: true,
                logo: true,
                isActive: true,
                isVerified: true,
              },
            },
            inventory: true,
            variants: true,
          },
        },
        variant: true,
      },
      orderBy: { createdAt: 'desc' },
    });

    const now = new Date();
    const productIds = rawItems.map((i) => i.productId);
    const activeFlashSales = productIds.length > 0
      ? await prisma.flashSaleItem.findMany({
          where: {
            productId: { in: productIds },
            status: 'ACTIVE',
            campaign: {
              status: 'ACTIVE',
              startAt: { lte: now },
              endAt: { gt: now },
            },
          },
          include: {
            campaign: {
              select: { id: true, name: true, endAt: true },
            },
          },
        })
      : [];
    const flashSaleMap = new Map(activeFlashSales.map((fs) => [fs.productId, fs]));

    // Compute authoritative state for each item
    let enrichedItems = rawItems.map((item) => {
      const product = item.product;
      const variant = item.variant;

      // Active Flash Sale check
      const flashSale = flashSaleMap.get(item.productId);
      const isFlashSaleActive = !!flashSale;
      const flashSalePrice = flashSale ? flashSale.flashSalePrice : null;
      const flashSaleEndsAt = flashSale ? flashSale.campaign.endAt : null;
      const isFlashSaleExpiringSoon = !!(
        flashSaleEndsAt &&
        flashSaleEndsAt.getTime() > now.getTime() &&
        flashSaleEndsAt.getTime() - now.getTime() <= 4 * 60 * 60 * 1000
      );
      const flashSaleDiscountPercentage = flashSale
        ? Math.round(flashSale.discountValue || ((flashSale.originalPrice - flashSale.flashSalePrice) / flashSale.originalPrice) * 100)
        : null;

      // Authoritative current price (taking active flash sale price into account if available)
      const standardPrice = variant ? variant.price : (product ? product.price : item.addedPrice);
      const effectivePrice = flashSalePrice !== null && flashSalePrice < standardPrice
        ? flashSalePrice
        : standardPrice;
      const originalPrice = item.addedPrice > 0 ? item.addedPrice : standardPrice;
      const compareAtPrice = variant?.compareAtPrice ?? product?.compareAtPrice ?? (flashSale ? flashSale.originalPrice : null);

      // Stock status
      let isInStock = false;
      let availableQuantity = 0;
      let isProductAvailable = false;

      if (product && product.isActive && !product.isSuspended) {
        isProductAvailable = true;
        if (variant) {
          availableQuantity = variant.stockQuantity;
          isInStock = variant.stockQuantity > 0;
        } else if (product.inventory) {
          availableQuantity = Math.max(0, product.inventory.quantity - product.inventory.reserved);
          isInStock = availableQuantity > 0;
        } else {
          isInStock = true;
          availableQuantity = 999;
        }
      }

      // Price-drop calculation
      const isPriceDropped = (originalPrice > 0 && effectivePrice < originalPrice) || isFlashSaleActive;
      const priceDropAmount = isPriceDropped ? Math.max(0, originalPrice - effectivePrice) : 0;
      const priceDropPercentage = isPriceDropped && originalPrice > 0
        ? Math.round(((originalPrice - effectivePrice) / originalPrice) * 100)
        : (flashSaleDiscountPercentage ?? 0);

      return {
        id: item.id,
        wishlistId: item.wishlistId,
        productId: item.productId,
        variantId: item.variantId,
        addedPrice: item.addedPrice,
        currentPrice: effectivePrice,
        priceCurrency: item.priceCurrency,
        priceDropAlertEnabled: item.priceDropAlertEnabled,
        backInStockAlertEnabled: item.backInStockAlertEnabled,
        lastNotifiedPrice: item.lastNotifiedPrice,
        createdAt: item.createdAt,
        updatedAt: item.updatedAt,
        // Computed dynamic fields
        isPriceDropped,
        priceDropAmount,
        priceDropPercentage,
        isInStock,
        availableQuantity,
        isProductAvailable,
        compareAtPrice,
        // Flash sale dynamic enrichment
        isFlashSaleActive,
        isFlashSaleExpiringSoon,
        flashSalePrice,
        flashSaleEndsAt: flashSaleEndsAt ? flashSaleEndsAt.toISOString() : null,
        flashSaleDiscountPercentage,
        product,
        variant,
      };
    });

    // Apply Filters
    if (filter === 'in_stock') {
      enrichedItems = enrichedItems.filter((i) => i.isInStock && i.isProductAvailable);
    } else if (filter === 'out_of_stock') {
      enrichedItems = enrichedItems.filter((i) => !i.isInStock || !i.isProductAvailable);
    } else if (filter === 'price_dropped') {
      enrichedItems = enrichedItems.filter((i) => i.isPriceDropped);
    }

    // Apply Sorting
    if (sortBy === 'price_asc') {
      enrichedItems.sort((a, b) => a.currentPrice - b.currentPrice);
    } else if (sortBy === 'price_desc') {
      enrichedItems.sort((a, b) => b.currentPrice - a.currentPrice);
    } else if (sortBy === 'price_drop') {
      enrichedItems.sort((a, b) => b.priceDropPercentage - a.priceDropPercentage);
    } else {
      // 'recent'
      enrichedItems.sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime());
    }

    // Pagination
    const total = enrichedItems.length;
    let paginatedItems = enrichedItems;
    let nextCursor: string | null = null;

    if (cursor) {
      const cursorIndex = enrichedItems.findIndex((i) => i.id === cursor);
      if (cursorIndex >= 0) {
        paginatedItems = enrichedItems.slice(cursorIndex + 1, cursorIndex + 1 + limit);
      }
    } else {
      const skip = (page - 1) * limit;
      paginatedItems = enrichedItems.slice(skip, skip + limit);
    }

    if (paginatedItems.length > 0 && paginatedItems.length === limit) {
      const last = paginatedItems[paginatedItems.length - 1];
      nextCursor = last.id;
    }

    return {
      id: wishlist.id,
      userId: wishlist.userId,
      items: paginatedItems,
      pagination: {
        total,
        page,
        limit,
        totalPages: Math.ceil(total / limit),
        nextCursor,
      },
      createdAt: wishlist.createdAt,
      updatedAt: wishlist.updatedAt,
    };
  }

  /**
   * Add item to wishlist (authoritative pricing snapshot + duplicate protection)
   */
  static async addItem(userId: string, data: { productId: string; variantId?: string | null; alertPreferences?: { priceDrop?: boolean; backInStock?: boolean } }) {
    const { productId, variantId, alertPreferences } = data;

    if (!productId) {
      throw new AppError('معرف المنتج مطلوب (Product ID is required)', 400);
    }

    // 1. Authoritative product validation
    const product = await prisma.product.findUnique({
      where: { id: productId },
      include: {
        images: { where: { isPrimary: true } },
        store: true,
        variants: true,
      },
    });

    if (!product || !product.isActive || product.isSuspended) {
      throw new AppError('المنتج غير متوفر أو غير متاح حالياً', 404);
    }

    // 2. Validate variant if specified
    let authoritativePrice = product.price;
    let targetVariant = null;

    if (variantId) {
      targetVariant = product.variants.find((v) => v.id === variantId);
      if (!targetVariant) {
        throw new AppError('نوع/خيار المنتج المحدد غير موجود', 400);
      }
      authoritativePrice = targetVariant.price;
    }

    // 3. Find or create wishlist
    const wishlist = await this.getOrCreateWishlist(userId);

    // 4. Safe find or create with authoritative initial price
    const existing = await prisma.wishlistItem.findFirst({
      where: {
        wishlistId: wishlist.id,
        productId,
        variantId: variantId || null,
      },
    });

    let item;
    if (existing) {
      item = await prisma.wishlistItem.update({
        where: { id: existing.id },
        data: {
          currentPrice: authoritativePrice,
          priceCurrency: product.currency || 'SAR',
          priceDropAlertEnabled: alertPreferences?.priceDrop ?? existing.priceDropAlertEnabled,
          backInStockAlertEnabled: alertPreferences?.backInStock ?? existing.backInStockAlertEnabled,
        },
        include: {
          product: {
            include: { images: true, store: true },
          },
          variant: true,
        },
      });
    } else {
      item = await prisma.wishlistItem.create({
        data: {
          wishlistId: wishlist.id,
          productId,
          variantId: variantId || null,
          addedPrice: authoritativePrice,
          currentPrice: authoritativePrice,
          priceCurrency: product.currency || 'SAR',
          priceDropAlertEnabled: alertPreferences?.priceDrop ?? true,
          backInStockAlertEnabled: alertPreferences?.backInStock ?? true,
        },
        include: {
          product: {
            include: { images: true, store: true },
          },
          variant: true,
        },
      });
    }

    return item;
  }

  /**
   * Remove item from wishlist with IDOR protection
   */
  static async removeItem(userId: string, itemIdOrProductId: string) {
    const wishlist = await prisma.wishlist.findUnique({
      where: { userId },
    });

    if (!wishlist) {
      return { removed: true };
    }

    // Try deleting by WishlistItem ID first
    const deletedById = await prisma.wishlistItem.deleteMany({
      where: {
        id: itemIdOrProductId,
        wishlistId: wishlist.id,
      },
    });

    if (deletedById.count === 0) {
      // Fallback: Delete by productId
      await prisma.wishlistItem.deleteMany({
        where: {
          productId: itemIdOrProductId,
          wishlistId: wishlist.id,
        },
      });
    }

    return { removed: true };
  }

  /**
   * Toggle item in wishlist (authoritative status)
   */
  static async toggleItem(userId: string, data: { productId: string; variantId?: string | null }) {
    const { productId, variantId } = data;
    const isPresent = await this.isWishlisted(userId, productId, variantId);

    if (isPresent) {
      const wishlist = await prisma.wishlist.findUnique({ where: { userId } });
      if (wishlist) {
        await prisma.wishlistItem.deleteMany({
          where: {
            wishlistId: wishlist.id,
            productId,
            variantId: variantId || null,
          },
        });
      }
      return { wishlisted: false, productId, variantId };
    } else {
      const item = await this.addItem(userId, { productId, variantId });
      return { wishlisted: true, productId, variantId, item };
    }
  }

  /**
   * Move a single wishlist item to cart atomically
   */
  static async moveToCart(userId: string, itemIdOrProductId: string, quantity = 1) {
    const wishlist = await prisma.wishlist.findUnique({ where: { userId } });
    if (!wishlist) {
      throw new AppError('قائمة المفضلة غير موجودة', 404);
    }

    // Find wishlist item
    const item = await prisma.wishlistItem.findFirst({
      where: {
        wishlistId: wishlist.id,
        OR: [{ id: itemIdOrProductId }, { productId: itemIdOrProductId }],
      },
      include: {
        product: { include: { inventory: true } },
        variant: true,
      },
    });

    if (!item || !item.product) {
      throw new AppError('عنصر المفضلة غير موجود', 404);
    }

    const product = item.product;
    const variant = item.variant;

    // Check availability
    if (!product.isActive || product.isSuspended) {
      throw new AppError('هذا المنتج غير متاح للشراء حالياً', 400);
    }

    if (variant) {
      if (variant.stockQuantity < quantity) {
        throw new AppError('الكمية المطلوبة غير متوفرة في المخزون لهذا الخيار', 400);
      }
    } else if (product.inventory) {
      const available = product.inventory.quantity - product.inventory.reserved;
      if (available < quantity) {
        throw new AppError('الكمية المطلوبة غير متوفرة في المخزون', 400);
      }
    }

    // Atomic Move: Add to cart then remove from wishlist
    return await prisma.$transaction(async (tx) => {
      let cart = await tx.cart.findUnique({ where: { userId } });
      if (!cart) {
        cart = await tx.cart.create({ data: { userId } });
      }

      const existingCartItem = await tx.cartItem.findFirst({
        where: {
          cartId: cart.id,
          productId: product.id,
          variantId: item.variantId || null,
        },
      });

      let cartItem;
      if (existingCartItem) {
        cartItem = await tx.cartItem.update({
          where: { id: existingCartItem.id },
          data: { quantity: existingCartItem.quantity + quantity },
        });
      } else {
        cartItem = await tx.cartItem.create({
          data: {
            cartId: cart.id,
            productId: product.id,
            variantId: item.variantId || null,
            quantity,
          },
        });
      }

      // Remove from wishlist
      await tx.wishlistItem.delete({
        where: { id: item.id },
      });

      return {
        success: true,
        cartItem,
        movedItem: {
          id: item.id,
          productId: product.id,
          nameAr: product.nameAr,
          nameEn: product.nameEn,
          unitPrice: variant?.price ?? product.price,
        },
      };
    });
  }

  /**
   * Move all eligible (in-stock, active) wishlist items to cart
   */
  static async moveAllToCart(userId: string): Promise<MoveAllToCartResult> {
    const wishlist = await prisma.wishlist.findUnique({
      where: { userId },
      include: {
        items: {
          include: {
            product: { include: { inventory: true } },
            variant: true,
          },
        },
      },
    });

    const result: MoveAllToCartResult = {
      moved: [],
      unavailable: [],
      failed: [],
    };

    if (!wishlist || wishlist.items.length === 0) {
      return result;
    }

    let cart = await prisma.cart.findUnique({ where: { userId } });
    if (!cart) {
      cart = await prisma.cart.create({ data: { userId } });
    }

    for (const item of wishlist.items) {
      const product = item.product;
      const variant = item.variant;

      if (!product) {
        result.failed.push({
          itemId: item.id,
          productId: item.productId,
          nameAr: 'منتج غير معروف',
          nameEn: 'Unknown Product',
          error: 'المنتج لم يعد موجوداً',
        });
        continue;
      }

      if (!product.isActive || product.isSuspended) {
        result.unavailable.push({
          itemId: item.id,
          productId: product.id,
          nameAr: product.nameAr,
          nameEn: product.nameEn,
          reason: 'المنتج غير متاح حالياً',
        });
        continue;
      }

      // Check stock
      let inStock = false;
      if (variant) {
        inStock = variant.stockQuantity > 0;
      } else if (product.inventory) {
        inStock = (product.inventory.quantity - product.inventory.reserved) > 0;
      } else {
        inStock = true;
      }

      if (!inStock) {
        result.unavailable.push({
          itemId: item.id,
          productId: product.id,
          nameAr: product.nameAr,
          nameEn: product.nameEn,
          reason: 'نفد من المخزون',
        });
        continue;
      }

      // Try adding to cart
      try {
        await prisma.$transaction(async (tx) => {
          const existing = await tx.cartItem.findFirst({
            where: {
              cartId: cart.id,
              productId: product.id,
              variantId: item.variantId || null,
            },
          });

          if (existing) {
            await tx.cartItem.update({
              where: { id: existing.id },
              data: { quantity: existing.quantity + 1 },
            });
          } else {
            await tx.cartItem.create({
              data: {
                cartId: cart.id,
                productId: product.id,
                variantId: item.variantId || null,
                quantity: 1,
              },
            });
          }

          // Remove item from wishlist
          await tx.wishlistItem.delete({
            where: { id: item.id },
          });
        });

        result.moved.push({
          itemId: item.id,
          productId: product.id,
          nameAr: product.nameAr,
          nameEn: product.nameEn,
          price: variant?.price ?? product.price,
        });
      } catch (err: any) {
        result.failed.push({
          itemId: item.id,
          productId: product.id,
          nameAr: product.nameAr,
          nameEn: product.nameEn,
          error: err.message || 'فشلت إضافة العنصر للسلة',
        });
      }
    }

    return result;
  }

  /**
   * Update individual wishlist item alert preferences (price-drop & back-in-stock)
   */
  static async updateAlertPreferences(
    userId: string,
    itemId: string,
    prefs: { priceDropAlertEnabled?: boolean; backInStockAlertEnabled?: boolean }
  ) {
    const wishlist = await prisma.wishlist.findUnique({ where: { userId } });
    if (!wishlist) throw new AppError('قائمة المفضلة غير موجودة', 404);

    const item = await prisma.wishlistItem.findFirst({
      where: { id: itemId, wishlistId: wishlist.id },
    });

    if (!item) throw new AppError('عنصر المفضلة غير موجود', 404);

    const updated = await prisma.wishlistItem.update({
      where: { id: itemId },
      data: {
        priceDropAlertEnabled: prefs.priceDropAlertEnabled !== undefined ? prefs.priceDropAlertEnabled : item.priceDropAlertEnabled,
        backInStockAlertEnabled: prefs.backInStockAlertEnabled !== undefined ? prefs.backInStockAlertEnabled : item.backInStockAlertEnabled,
      },
    });

    return updated;
  }

  // ==============================================================================
  // BACKGROUND ALERT MONITORING ENGINE (Price-Drop & Back-in-Stock)
  // ==============================================================================

  /**
   * Scan wishlist items, detect price drops, apply cooldown & threshold rules, create alerts & notifications
   */
  static async evaluatePriceDrops(options: { defaultThresholdPercent?: number; cooldownHours?: number } = {}) {
    const thresholdPercent = options.defaultThresholdPercent ?? 5.0; // minimum 5% drop
    const cooldownHours = options.cooldownHours ?? 24; // 24 hours cooldown for identical notifications

    const candidateItems = await prisma.wishlistItem.findMany({
      where: {
        priceDropAlertEnabled: true,
      },
      include: {
        wishlist: { select: { userId: true } },
        product: { select: { id: true, nameAr: true, nameEn: true, price: true, currency: true, isActive: true } },
        variant: { select: { id: true, nameAr: true, nameEn: true, price: true } },
      },
      take: 500,
    });

    let detectedDrops = 0;
    let notificationsSent = 0;
    const cooldownCutoff = new Date(Date.now() - cooldownHours * 60 * 60 * 1000);

    for (const item of candidateItems) {
      if (!item.product || !item.product.isActive) continue;

      const currentPrice = item.variant ? item.variant.price : item.product.price;
      const basePrice = item.addedPrice > 0 ? item.addedPrice : currentPrice;

      if (currentPrice >= basePrice) {
        // Price didn't drop
        continue;
      }

      const dropAmount = basePrice - currentPrice;
      const dropPercentage = (dropAmount / basePrice) * 100;

      if (dropPercentage < thresholdPercent) {
        // Did not meet configured threshold
        continue;
      }

      // Check if already notified recently at this price or lower
      if (item.lastNotifiedPrice !== null && currentPrice >= item.lastNotifiedPrice) {
        continue;
      }

      const recentAlert = await prisma.wishlistAlert.findFirst({
        where: {
          wishlistItemId: item.id,
          alertType: WishlistAlertType.PRICE_DROP,
          triggeredAt: { gte: cooldownCutoff },
        },
      });

      if (recentAlert && Math.abs((recentAlert.newPrice || 0) - currentPrice) < 0.01) {
        // Deduplicated: identical price alert within cooldown
        continue;
      }

      detectedDrops++;
      const userId = item.wishlist.userId;
      const productName = item.product.nameAr || item.product.nameEn;
      const currency = item.priceCurrency || 'SAR';

      // Create WishlistAlert record
      const alert = await prisma.wishlistAlert.create({
        data: {
          wishlistItemId: item.id,
          userId,
          alertType: WishlistAlertType.PRICE_DROP,
          oldPrice: basePrice,
          newPrice: currentPrice,
          currency,
          threshold: dropPercentage,
          status: WishlistAlertStatus.NOTIFIED,
          triggeredAt: new Date(),
          notifiedAt: new Date(),
        },
      });

      // Update item's last notified price
      await prisma.wishlistItem.update({
        where: { id: item.id },
        data: {
          currentPrice,
          lastNotifiedPrice: currentPrice,
        },
      });

      // Centralized SOUQNAA Notification Platform Dispatch (§31 Price Drop Alert)
      notificationDispatcher.dispatch(
        NotificationEventFactory.alertEvent({
          eventType: 'PRICE_DROPPED',
          recipientId: userId,
          productId: item.productId,
          productNameAr: productName,
          productNameEn: item.product.nameEn || undefined,
          oldPrice: basePrice,
          newPrice: currentPrice,
        })
      ).catch(() => {});

      notificationsSent++;
    }

    return { candidateCount: candidateItems.length, detectedDrops, notificationsSent };
  }

  /**
   * Scan wishlist items and notify when an out-of-stock product returns to stock
   */
  static async evaluateStockAlerts(productId?: string, variantId?: string) {
    const whereClause: any = {
      backInStockAlertEnabled: true,
    };

    if (productId) whereClause.productId = productId;
    if (variantId) whereClause.variantId = variantId;

    const items = await prisma.wishlistItem.findMany({
      where: whereClause,
      include: {
        wishlist: { select: { userId: true } },
        product: { select: { id: true, nameAr: true, nameEn: true, isActive: true, inventory: true } },
        variant: { select: { id: true, nameAr: true, nameEn: true, stockQuantity: true } },
      },
      take: 200,
    });

    let stockNotificationsSent = 0;

    for (const item of items) {
      if (!item.product || !item.product.isActive) continue;

      let inStock = false;
      if (item.variant) {
        inStock = item.variant.stockQuantity > 0;
      } else if (item.product.inventory) {
        inStock = (item.product.inventory.quantity - item.product.inventory.reserved) > 0;
      }

      if (!inStock) continue;

      // Check if we already sent a BACK_IN_STOCK alert in the last 48 hours
      const recentAlert = await prisma.wishlistAlert.findFirst({
        where: {
          wishlistItemId: item.id,
          alertType: WishlistAlertType.BACK_IN_STOCK,
          triggeredAt: { gte: new Date(Date.now() - 48 * 60 * 60 * 1000) },
        },
      });

      if (recentAlert) continue;

      const userId = item.wishlist.userId;
      const productName = item.product.nameAr || item.product.nameEn;

      // Create alert record
      const alert = await prisma.wishlistAlert.create({
        data: {
          wishlistItemId: item.id,
          userId,
          alertType: WishlistAlertType.BACK_IN_STOCK,
          status: WishlistAlertStatus.NOTIFIED,
          triggeredAt: new Date(),
          notifiedAt: new Date(),
        },
      });

      // Centralized SOUQNAA Notification Platform Dispatch (§32 Stock Alert)
      notificationDispatcher.dispatch(
        NotificationEventFactory.alertEvent({
          eventType: 'BACK_IN_STOCK',
          recipientId: userId,
          productId: item.productId,
          productNameAr: productName,
          productNameEn: item.product.nameEn || undefined,
        })
      ).catch(() => {});

      stockNotificationsSent++;
    }

    return { evaluatedItems: items.length, stockNotificationsSent };
  }

  /**
   * Scan active flash sales that expire within the next few hours (e.g. 2-4 hours)
   * and notify customers who have saved those flash sale products in their wishlist.
   */
  static async evaluateFlashSaleExpiringAlerts(hoursAhead = 4) {
    const now = new Date();
    const expirationThreshold = new Date(now.getTime() + hoursAhead * 60 * 60 * 1000);

    const expiringCampaigns = await prisma.flashSaleCampaign.findMany({
      where: {
        status: 'ACTIVE',
        startAt: { lte: now },
        endAt: {
          gt: now,
          lte: expirationThreshold,
        },
      },
      include: {
        items: {
          where: {
            status: 'ACTIVE',
            remainingStock: { gt: 0 },
          },
          include: {
            product: {
              select: {
                id: true,
                nameAr: true,
                nameEn: true,
                price: true,
                currency: true,
              },
            },
          },
        },
      },
    });

    let notificationsSent = 0;
    const cooldownCutoff = new Date(now.getTime() - 12 * 60 * 60 * 1000); // 12h cooldown

    for (const campaign of expiringCampaigns) {
      for (const fsItem of campaign.items) {
        if (!fsItem.product) continue;

        const wishlistItems = await prisma.wishlistItem.findMany({
          where: {
            productId: fsItem.productId,
            priceDropAlertEnabled: true,
          },
          include: {
            wishlist: { select: { userId: true } },
          },
        });

        for (const wItem of wishlistItems) {
          const userId = wItem.wishlist.userId;

          const existingNotification = await prisma.notification.findFirst({
            where: {
              userId,
              category: 'FLASH_SALE',
              createdAt: { gte: cooldownCutoff },
              data: {
                contains: fsItem.productId,
              },
            },
          });

          if (existingNotification) continue;

          const productName = fsItem.product.nameAr || fsItem.product.nameEn;
          const remainingMinutes = Math.max(1, Math.round((campaign.endAt.getTime() - now.getTime()) / 60000));
          const hoursRemaining = Math.floor(remainingMinutes / 60);
          const minsRemaining = remainingMinutes % 60;
          const timeText = hoursRemaining > 0
            ? `${hoursRemaining} ساعة و ${minsRemaining} دقيقة`
            : `${minsRemaining} دقيقة`;

          notificationDispatcher.dispatch(
            NotificationEventFactory.campaignEvent({
              eventType: 'FLASH_SALE_ENDING',
              recipientId: userId,
              campaignId: campaign.id,
              campaignTitleAr: `عروض التخفيض السريع تنتهي قريباً (${timeText}) على منتج في مفضلتك: ${productName}`,
              campaignTitleEn: `Flash sale ending soon (${timeText}) on wishlisted product: ${productName}`,
              discountPercentage: fsItem.discountValue || Math.round(((fsItem.originalPrice - fsItem.flashSalePrice) / fsItem.originalPrice) * 100),
            })
          ).catch(() => {});

          notificationsSent++;
        }
      }
    }

    return {
      expiringCampaignsCount: expiringCampaigns.length,
      notificationsSent,
    };
  }

  /**
   * Get customer's alerts history for wishlist items
   */
  static async getCustomerWishlistAlerts(userId: string) {
    const alerts = await prisma.wishlistAlert.findMany({
      where: { userId },
      orderBy: { triggeredAt: 'desc' },
      take: 40,
      include: {
        wishlistItem: {
          include: {
            product: {
              select: {
                id: true,
                nameAr: true,
                nameEn: true,
                price: true,
                currency: true,
                images: { where: { isPrimary: true }, take: 1 },
              },
            },
          },
        },
      },
    });

    return alerts.map((a) => {
      const prod = a.wishlistItem?.product;
      return {
        id: a.id,
        alertType: a.alertType,
        oldPrice: a.oldPrice,
        newPrice: a.newPrice,
        currency: a.currency,
        threshold: a.threshold,
        status: a.status,
        triggeredAt: a.triggeredAt,
        productId: prod?.id || a.wishlistItem?.productId,
        productName: prod?.nameAr || prod?.nameEn || 'منتج',
        imageUrl: prod?.images[0]?.url || null,
      };
    });
  }

  // ==============================================================================
  // ADMIN ANALYTICS & SETTINGS
  // ==============================================================================

  static async getAdminWishlistAnalytics() {
    const [
      totalWishlists,
      totalWishlistItems,
      totalAlertsTriggered,
      priceDropAlertsCount,
      stockAlertsCount,
      topWishlistedProducts,
    ] = await Promise.all([
      prisma.wishlist.count(),
      prisma.wishlistItem.count(),
      prisma.wishlistAlert.count(),
      prisma.wishlistAlert.count({ where: { alertType: WishlistAlertType.PRICE_DROP } }),
      prisma.wishlistAlert.count({ where: { alertType: WishlistAlertType.BACK_IN_STOCK } }),
      prisma.wishlistItem.groupBy({
        by: ['productId'],
        _count: { id: true },
        orderBy: { _count: { id: 'desc' } },
        take: 10,
      }),
    ]);

    // Fetch product details for top wishlisted
    const productIds = topWishlistedProducts.map((p) => p.productId);
    const products = await prisma.product.findMany({
      where: { id: { in: productIds } },
      select: {
        id: true,
        nameAr: true,
        nameEn: true,
        price: true,
        currency: true,
        store: { select: { name: true } },
        images: { where: { isPrimary: true }, take: 1 },
      },
    });

    const productMap = new Map(products.map((p) => [p.id, p]));

    const enrichedTopProducts = topWishlistedProducts.map((p) => {
      const prod = productMap.get(p.productId);
      return {
        productId: p.productId,
        nameAr: prod?.nameAr || 'منتج',
        nameEn: prod?.nameEn || 'Product',
        price: prod?.price || 0,
        currency: prod?.currency || 'SAR',
        storeName: prod?.store?.name || 'متجر',
        imageUrl: prod?.images[0]?.url || null,
        wishlistCount: p._count.id,
      };
    });

    return {
      kpis: {
        totalWishlists,
        totalWishlistItems,
        totalAlertsTriggered,
        priceDropAlertsCount,
        stockAlertsCount,
        averageItemsPerWishlist: totalWishlists > 0 ? parseFloat((totalWishlistItems / totalWishlists).toFixed(2)) : 0,
      },
      topWishlistedProducts: enrichedTopProducts,
    };
  }

  static async getWishlistSettings() {
    const keys = [
      'wishlist_enabled',
      'wishlist_price_drop_alerts_enabled',
      'wishlist_stock_alerts_enabled',
      'wishlist_price_drop_threshold',
      'wishlist_price_drop_cooldown_hours',
      'wishlist_max_items_per_customer',
    ];

    const settings = await prisma.systemSetting.findMany({
      where: { key: { in: keys } },
    });

    const settingsMap = new Map(settings.map((s) => [s.key, s.value]));

    return {
      wishlistEnabled: settingsMap.get('wishlist_enabled') !== 'false',
      priceDropAlertsEnabled: settingsMap.get('wishlist_price_drop_alerts_enabled') !== 'false',
      stockAlertsEnabled: settingsMap.get('wishlist_stock_alerts_enabled') !== 'false',
      priceDropThreshold: parseFloat(settingsMap.get('wishlist_price_drop_threshold') || '5.0'),
      priceDropCooldownHours: parseInt(settingsMap.get('wishlist_price_drop_cooldown_hours') || '24', 10),
      maxWishlistItems: parseInt(settingsMap.get('wishlist_max_items_per_customer') || '200', 10),
    };
  }

  static async updateWishlistSettings(settings: {
    wishlistEnabled?: boolean;
    priceDropAlertsEnabled?: boolean;
    stockAlertsEnabled?: boolean;
    priceDropThreshold?: number;
    priceDropCooldownHours?: number;
    maxWishlistItems?: number;
  }) {
    const updates: Array<{ key: string; value: string }> = [];

    if (settings.wishlistEnabled !== undefined) {
      updates.push({ key: 'wishlist_enabled', value: String(settings.wishlistEnabled) });
    }
    if (settings.priceDropAlertsEnabled !== undefined) {
      updates.push({ key: 'wishlist_price_drop_alerts_enabled', value: String(settings.priceDropAlertsEnabled) });
    }
    if (settings.stockAlertsEnabled !== undefined) {
      updates.push({ key: 'wishlist_stock_alerts_enabled', value: String(settings.stockAlertsEnabled) });
    }
    if (settings.priceDropThreshold !== undefined) {
      updates.push({ key: 'wishlist_price_drop_threshold', value: String(settings.priceDropThreshold) });
    }
    if (settings.priceDropCooldownHours !== undefined) {
      updates.push({ key: 'wishlist_price_drop_cooldown_hours', value: String(settings.priceDropCooldownHours) });
    }
    if (settings.maxWishlistItems !== undefined) {
      updates.push({ key: 'wishlist_max_items_per_customer', value: String(settings.maxWishlistItems) });
    }

    for (const u of updates) {
      await prisma.systemSetting.upsert({
        where: { key: u.key },
        update: { value: u.value, updatedAt: new Date() },
        create: { key: u.key, value: u.value, group: 'wishlist' },
      });
    }

    return this.getWishlistSettings();
  }

  // ==============================================================================
  // SELLER AGGREGATE ANALYTICS (Anonymized)
  // ==============================================================================

  static async getSellerWishlistAnalytics(sellerId: string) {
    const stores = await prisma.store.findMany({
      where: { sellerId },
      select: { id: true },
    });
    const storeIds = stores.map((s) => s.id);

    const products = await prisma.product.findMany({
      where: { storeId: { in: storeIds } },
      select: { id: true, nameAr: true, nameEn: true, price: true },
    });
    const productIds = products.map((p) => p.id);

    const [totalWishlistAdds, topProducts] = await Promise.all([
      prisma.wishlistItem.count({
        where: { productId: { in: productIds } },
      }),
      prisma.wishlistItem.groupBy({
        by: ['productId'],
        where: { productId: { in: productIds } },
        _count: { id: true },
        orderBy: { _count: { id: 'desc' } },
        take: 5,
      }),
    ]);

    const productMap = new Map(products.map((p) => [p.id, p]));

    return {
      totalWishlistAdds,
      topWishlisted: topProducts.map((tp) => {
        const prod = productMap.get(tp.productId);
        return {
          productId: tp.productId,
          nameAr: prod?.nameAr || 'منتج',
          nameEn: prod?.nameEn || 'Product',
          price: prod?.price || 0,
          wishlistCount: tp._count.id,
        };
      }),
    };
  }
}
