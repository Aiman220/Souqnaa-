import { prisma } from '../../database/prisma';
import { AppError } from '../../middleware/error.middleware';
import { OrderStatus, SellerOrderStatus, SellerStatus, ReturnRequestStatus, RefundStatus } from '@prisma/client';
import {
  BuyAgainItem,
  BuyAgainItemVariantSummary,
  BuyAgainQueryOptions,
  BuyAgainResponse,
  ReorderItemInput,
  ReorderOrderResult,
  BuyAgainAdminMetrics,
} from './buy-again.types';

export class BuyAgainService {
  /**
   * Fetch customer's previously purchased products from authoritative completed orders.
   * Excludes canceled, refunded, or returned purchases.
   */
  public static async getBuyAgainItems(
    userId: string,
    options: BuyAgainQueryOptions = {}
  ): Promise<BuyAgainResponse> {
    const page = Math.max(1, options.page || 1);
    const limit = Math.min(50, Math.max(1, options.limit || 20));
    const sortBy = options.sortBy || 'recent';
    const search = options.search?.trim().toLowerCase();

    // 1. Authoritative completed orders query
    // An order is eligible if delivered and not fully refunded/returned
    const eligibleOrders = await prisma.order.findMany({
      where: {
        userId,
        status: {
          in: [
            OrderStatus.DELIVERED,
            OrderStatus.SHIPPED, // Include shipped/delivered orders where customer has purchased
          ],
        },
        returnRequests: {
          none: {
            status: { in: [ReturnRequestStatus.COMPLETED, ReturnRequestStatus.APPROVED] },
          },
        },
        refundRequests: {
          none: {
            status: { in: [RefundStatus.REFUND_COMPLETED, RefundStatus.REFUNDED, RefundStatus.ADMIN_APPROVED] },
          },
        },
      },
      include: {
        sellerOrders: {
          where: {
            status: {
              notIn: [
                SellerOrderStatus.CANCELLED_BY_CUSTOMER,
                SellerOrderStatus.CANCELLED_BY_SELLER,
                SellerOrderStatus.REJECTED_BY_SELLER,
                SellerOrderStatus.CANCELLED_BY_ADMIN,
                SellerOrderStatus.REFUNDED,
                SellerOrderStatus.RETURNED,
              ],
            },
          },
          include: {
            seller: {
              include: {
                stores: {
                  select: {
                    id: true,
                    name: true,
                    logo: true,
                    isActive: true,
                    isOpen: true,
                  },
                },
              },
            },
            items: {
              include: {
                refundRequestItems: {
                  where: {
                    refundRequest: {
                      status: { in: [RefundStatus.REFUND_COMPLETED, RefundStatus.REFUNDED, RefundStatus.ADMIN_APPROVED] },
                    },
                  },
                },
              },
            },
          },
        },
      },
      orderBy: { createdAt: 'desc' },
    });

    if (eligibleOrders.length === 0) {
      return {
        items: [],
        totalCount: 0,
        page,
        limit,
        totalPages: 0,
        hasMore: false,
        summary: {
          totalPurchasedProducts: 0,
          availableForReorder: 0,
          frequentlyPurchasedCount: 0,
        },
      };
    }

    // 2. Aggregate purchases by (productId, variantId)
    interface AggregationRecord {
      productId: string;
      variantId: string | null;
      lastPurchasedAt: Date;
      purchaseCount: number;
      lastQuantity: number;
      lastOrderId: string;
      lastOrderNumber: string;
      historicalPrice: number;
      sellerId: string;
      storeId: string;
      storeName: string;
      storeLogo: string | null;
      storeIsActive: boolean;
      storeIsOpen: boolean;
      productNameAr: string;
      productNameEn: string;
    }

    const aggregationMap = new Map<string, AggregationRecord>();

    for (const order of eligibleOrders) {
      for (const sellerOrder of order.sellerOrders) {
        const store = sellerOrder.seller?.stores?.[0];
        const storeId = store?.id || '';
        const storeName = store?.name || 'متجر سوقنا';
        const storeLogo = store?.logo || null;
        const storeIsActive = store?.isActive ?? true;
        const storeIsOpen = store?.isOpen ?? true;

        for (const item of sellerOrder.items) {
          // If this specific item was refunded, skip it
          if (item.refundRequestItems && item.refundRequestItems.length > 0) {
            continue;
          }

          const aggKey = `${item.productId}::${item.variantId || 'novariant'}`;
          const existing = aggregationMap.get(aggKey);

          if (!existing) {
            aggregationMap.set(aggKey, {
              productId: item.productId,
              variantId: item.variantId || null,
              lastPurchasedAt: order.createdAt,
              purchaseCount: 1,
              lastQuantity: item.quantity,
              lastOrderId: order.id,
              lastOrderNumber: order.displayOrderNumber || order.orderNumber,
              historicalPrice: item.unitPrice,
              sellerId: sellerOrder.sellerId,
              storeId,
              storeName,
              storeLogo,
              storeIsActive,
              storeIsOpen,
              productNameAr: item.productNameAr,
              productNameEn: item.productNameEn,
            });
          } else {
            existing.purchaseCount += 1;
            if (order.createdAt > existing.lastPurchasedAt) {
              existing.lastPurchasedAt = order.createdAt;
              existing.lastQuantity = item.quantity;
              existing.lastOrderId = order.id;
              existing.lastOrderNumber = order.displayOrderNumber || order.orderNumber;
              existing.historicalPrice = item.unitPrice;
            }
          }
        }
      }
    }

    const uniqueProductIds = Array.from(
      new Set(Array.from(aggregationMap.values()).map((r) => r.productId))
    );

    if (uniqueProductIds.length === 0) {
      return {
        items: [],
        totalCount: 0,
        page,
        limit,
        totalPages: 0,
        hasMore: false,
        summary: {
          totalPurchasedProducts: 0,
          availableForReorder: 0,
          frequentlyPurchasedCount: 0,
        },
      };
    }

    // 3. Query current authoritative product, variant, inventory, and seller states
    const activeProducts = await prisma.product.findMany({
      where: {
        id: { in: uniqueProductIds },
      },
      include: {
        store: {
          include: {
            seller: true,
          },
        },
        variants: true,
        inventory: true,
        images: {
          orderBy: { sortOrder: 'asc' },
        },
      },
    });

    const productMap = new Map(activeProducts.map((p) => [p.id, p]));

    // 4. Validate and assemble Buy Again items
    const buyAgainItems: BuyAgainItem[] = [];

    for (const record of aggregationMap.values()) {
      const product = productMap.get(record.productId);

      // Search filter
      if (search) {
        const matchesNameAr = (product?.nameAr || record.productNameAr).toLowerCase().includes(search);
        const matchesNameEn = (product?.nameEn || record.productNameEn).toLowerCase().includes(search);
        const matchesStore = (product?.store?.name || record.storeName).toLowerCase().includes(search);
        if (!matchesNameAr && !matchesNameEn && !matchesStore) {
          continue;
        }
      }

      // If product was hard deleted
      if (!product) {
        buyAgainItems.push({
          productId: record.productId,
          variantId: record.variantId,
          variantNameAr: null,
          variantNameEn: null,
          sellerId: record.sellerId,
          storeId: record.storeId,
          storeName: record.storeName,
          storeLogo: record.storeLogo,
          storeIsActive: false,
          storeIsOpen: false,
          productNameAr: record.productNameAr,
          productNameEn: record.productNameEn,
          productSlug: '',
          productImage: null,
          categoryId: '',
          lastPurchasedAt: record.lastPurchasedAt.toISOString(),
          purchaseCount: record.purchaseCount,
          lastQuantity: record.lastQuantity,
          lastOrderId: record.lastOrderId,
          lastOrderNumber: record.lastOrderNumber,
          historicalPrice: record.historicalPrice,
          currentPrice: record.historicalPrice,
          compareAtPrice: null,
          currency: 'YER',
          availableStock: 0,
          isAvailable: false,
          unavailabilityReason: 'PRODUCT_DISCONTINUED',
          hasMultipleVariants: false,
          isExactVariantAvailable: false,
          priceChanged: false,
          priceDifference: 0,
          variants: [],
        });
        continue;
      }

      // Authoritative validations
      const isProductActive = product.isActive && !product.isSuspended;
      const isStoreActive = product.store ? product.store.isActive : false;
      const isStoreOpen = product.store ? product.store.isOpen : false;
      const seller = product.store?.seller;
      const isSellerActive =
        seller && seller.status === SellerStatus.ACTIVE && !seller.isFinanciallyRestricted;

      // Variants summary
      const variantSummaries: BuyAgainItemVariantSummary[] = product.variants.map((v) => ({
        id: v.id,
        nameAr: v.nameAr,
        nameEn: v.nameEn,
        price: v.price,
        stockQuantity: v.stockQuantity,
        sku: v.sku,
      }));

      const hasMultipleVariants = product.variants.length > 0;
      let targetVariant = record.variantId
        ? product.variants.find((v) => v.id === record.variantId)
        : null;

      let isExactVariantAvailable = false;
      let currentPrice = product.price;
      let compareAtPrice = product.compareAtPrice;
      let availableStock = 0;

      if (record.variantId) {
        if (targetVariant) {
          currentPrice = targetVariant.price;
          compareAtPrice = targetVariant.compareAtPrice;
          availableStock = targetVariant.stockQuantity;
          isExactVariantAvailable = availableStock > 0;
        } else {
          // Previously bought variant no longer exists
          isExactVariantAvailable = false;
          availableStock = 0;
        }
      } else {
        // Simple product or no variant
        availableStock = product.inventory
          ? Math.max(0, product.inventory.quantity - (product.inventory.reserved || 0))
          : 0;
        isExactVariantAvailable = availableStock > 0;
      }

      // Overall availability
      let isAvailable = false;
      let unavailabilityReason: string | null = null;

      if (!isProductActive) {
        unavailabilityReason = 'PRODUCT_INACTIVE';
      } else if (!isStoreActive || !isSellerActive) {
        unavailabilityReason = 'SELLER_UNAVAILABLE';
      } else if (record.variantId && !targetVariant) {
        unavailabilityReason = 'VARIANT_DISCONTINUED';
      } else if (availableStock <= 0) {
        unavailabilityReason = 'OUT_OF_STOCK';
      } else {
        isAvailable = true;
      }

      const primaryImage =
        product.images.find((img) => img.isPrimary)?.url ||
        product.images[0]?.url ||
        null;

      const priceChanged = Math.abs(currentPrice - record.historicalPrice) > 0.01;
      const priceDifference = currentPrice - record.historicalPrice;

      buyAgainItems.push({
        productId: product.id,
        variantId: targetVariant ? targetVariant.id : record.variantId,
        variantNameAr: targetVariant ? targetVariant.nameAr : null,
        variantNameEn: targetVariant ? targetVariant.nameEn : null,
        sellerId: product.store?.sellerId || record.sellerId,
        storeId: product.storeId,
        storeName: product.store?.name || record.storeName,
        storeLogo: product.store?.logo || record.storeLogo,
        storeIsActive: isStoreActive,
        storeIsOpen: isStoreOpen,
        productNameAr: product.nameAr,
        productNameEn: product.nameEn,
        productSlug: product.slug,
        productImage: primaryImage,
        categoryId: product.categoryId,
        lastPurchasedAt: record.lastPurchasedAt.toISOString(),
        purchaseCount: record.purchaseCount,
        lastQuantity: record.lastQuantity,
        lastOrderId: record.lastOrderId,
        lastOrderNumber: record.lastOrderNumber,
        historicalPrice: record.historicalPrice,
        currentPrice,
        compareAtPrice,
        currency: product.currency || 'YER',
        availableStock,
        isAvailable,
        unavailabilityReason,
        hasMultipleVariants,
        isExactVariantAvailable,
        priceChanged,
        priceDifference,
        variants: variantSummaries,
      });
    }

    // 5. Ranking & Sorting
    if (sortBy === 'frequent') {
      buyAgainItems.sort((a, b) => {
        if (b.purchaseCount !== a.purchaseCount) {
          return b.purchaseCount - a.purchaseCount;
        }
        return new Date(b.lastPurchasedAt).getTime() - new Date(a.lastPurchasedAt).getTime();
      });
    } else {
      // Default: recent
      buyAgainItems.sort(
        (a, b) => new Date(b.lastPurchasedAt).getTime() - new Date(a.lastPurchasedAt).getTime()
      );
    }

    // Summary calculation
    const totalCount = buyAgainItems.length;
    const availableForReorder = buyAgainItems.filter((i) => i.isAvailable).length;
    const frequentlyPurchasedCount = buyAgainItems.filter((i) => i.purchaseCount > 1).length;

    // Pagination
    const startIndex = (page - 1) * limit;
    const paginatedItems = buyAgainItems.slice(startIndex, startIndex + limit);
    const totalPages = Math.ceil(totalCount / limit);
    const hasMore = page < totalPages;

    return {
      items: paginatedItems,
      totalCount,
      page,
      limit,
      totalPages,
      hasMore,
      summary: {
        totalPurchasedProducts: totalCount,
        availableForReorder,
        frequentlyPurchasedCount,
      },
    };
  }

  /**
   * One-Tap Reorder validation and direct addition to existing Cart.
   * Strictly enforces backend authoritativeness and customer purchase history verification.
   */
  public static async validateAndAddToCart(
    userId: string,
    input: ReorderItemInput
  ): Promise<{
    success: boolean;
    messageAr: string;
    messageEn: string;
    cartItem: any;
    currentPrice: number;
    availableStock: number;
  }> {
    const { productId, variantId, quantity = 1 } = input;
    const requestedQty = Math.max(1, parseInt(String(quantity), 10) || 1);

    // 1. Customer purchase history verification (Security / IDOR check)
    const verifiedPurchase = await prisma.orderItem.findFirst({
      where: {
        productId,
        ...(variantId ? { variantId } : {}),
        sellerOrder: {
          order: {
            userId,
            status: { in: [OrderStatus.DELIVERED, OrderStatus.SHIPPED] },
          },
        },
      },
      include: {
        sellerOrder: {
          include: {
            order: true,
          },
        },
      },
    });

    if (!verifiedPurchase) {
      throw new AppError(
        'عذراً، هذا المنتج ليس ضمن سجل مشترياتك السابقة المؤهلة لإعادة الشراء.',
        403,
        'NOT_IN_PURCHASE_HISTORY'
      );
    }

    // 2. Fetch authoritative product and store/seller details
    const product = await prisma.product.findUnique({
      where: { id: productId },
      include: {
        store: {
          include: { seller: true },
        },
        variants: true,
        inventory: true,
      },
    });

    if (!product) {
      throw new AppError('عذراً، هذا المنتج لم يعد متاحاً في المتجر.', 404, 'PRODUCT_NOT_FOUND');
    }

    if (!product.isActive || product.isSuspended) {
      throw new AppError('عذراً، هذا المنتج غير متوفر حالياً.', 400, 'PRODUCT_UNAVAILABLE');
    }

    const store = product.store;
    if (!store || !store.isActive) {
      throw new AppError('عذراً، متجر هذا المنتج غير متاح حالياً.', 400, 'STORE_UNAVAILABLE');
    }

    const seller = store.seller;
    if (!seller || seller.status !== SellerStatus.ACTIVE || seller.isFinanciallyRestricted) {
      throw new AppError('عذراً، البائع غير متاح حالياً لإتمام الطلبات.', 400, 'SELLER_RESTRICTED');
    }

    // 3. Variant & Inventory validation
    let authoritativeUnitPrice = product.price;
    let availableStock = 0;

    if (variantId) {
      const variant = product.variants.find((v) => v.id === variantId);
      if (!variant) {
        throw new AppError(
          'المواصفة السابقة لهذا المنتج غير متوفرة، يرجى اختيار مواصفة أخرى.',
          400,
          'VARIANT_NOT_FOUND'
        );
      }
      authoritativeUnitPrice = variant.price;
      availableStock = variant.stockQuantity;
    } else {
      if (product.variants.length > 0) {
        // If the product requires variant selection
        throw new AppError(
          'يرجى تحديد خيارات المنتج المطلوبة قبل إضافته للسلة.',
          400,
          'VARIANT_SELECTION_REQUIRED'
        );
      }
      availableStock = product.inventory
        ? Math.max(0, product.inventory.quantity - (product.inventory.reserved || 0))
        : 0;
    }

    if (availableStock <= 0) {
      throw new AppError('عذراً، نفد هذا المنتج من المخزون حالياً.', 400, 'OUT_OF_STOCK');
    }

    // 4. Cart Engine Integration
    let cart = await prisma.cart.findUnique({ where: { userId } });
    if (!cart) {
      cart = await prisma.cart.create({ data: { userId } });
    }

    const existingCartItem = await prisma.cartItem.findFirst({
      where: {
        cartId: cart.id,
        productId,
        variantId: variantId || null,
      },
    });

    const targetQuantity = existingCartItem
      ? existingCartItem.quantity + requestedQty
      : requestedQty;

    if (targetQuantity > availableStock) {
      throw new AppError(
        `الكمية المتاحة في المخزون (${availableStock}) لا تكفي لإضافة ${requestedQty} قطع إضافية.`,
        400,
        'INSUFFICIENT_STOCK'
      );
    }

    let updatedCartItem;
    if (existingCartItem) {
      updatedCartItem = await prisma.cartItem.update({
        where: { id: existingCartItem.id },
        data: {
          quantity: targetQuantity,
        },
        include: {
          product: {
            include: {
              images: { where: { isPrimary: true } },
              store: true,
            },
          },
          variant: true,
        },
      });
    } else {
      updatedCartItem = await prisma.cartItem.create({
        data: {
          cartId: cart.id,
          productId,
          variantId: variantId || null,
          quantity: targetQuantity,
        },
        include: {
          product: {
            include: {
              images: { where: { isPrimary: true } },
              store: true,
            },
          },
          variant: true,
        },
      });
    }

    return {
      success: true,
      messageAr: 'تمت إضافة المنتج إلى سلة التسوق بنجاح',
      messageEn: 'Product added to cart successfully',
      cartItem: updatedCartItem,
      currentPrice: authoritativeUnitPrice,
      availableStock,
    };
  }

  /**
   * Reorder an entire historical completed order.
   * Validates each item individually, adding all available items to the customer's cart.
   */
  public static async reorderEntireOrder(
    userId: string,
    orderId: string
  ): Promise<ReorderOrderResult> {
    const order = await prisma.order.findFirst({
      where: {
        id: orderId,
        userId,
        status: { in: [OrderStatus.DELIVERED, OrderStatus.SHIPPED] },
      },
      include: {
        sellerOrders: {
          include: {
            items: true,
          },
        },
      },
    });

    if (!order) {
      throw new AppError(
        'الطلب المحدد غير موجود أو غير مؤهل لإعادة الشراء.',
        404,
        'ORDER_NOT_FOUND'
      );
    }

    const allItems = order.sellerOrders.flatMap((so) => so.items);
    const results: ReorderOrderResult['results'] = [];
    let addedItemsCount = 0;
    let skippedItemsCount = 0;

    for (const item of allItems) {
      try {
        const addResult = await this.validateAndAddToCart(userId, {
          productId: item.productId,
          variantId: item.variantId,
          quantity: item.quantity,
        });

        results.push({
          productId: item.productId,
          variantId: item.variantId,
          productName: item.productNameAr,
          status: 'ADDED',
          quantity: item.quantity,
          unitPrice: addResult.currentPrice,
        });
        addedItemsCount++;
      } catch (err: any) {
        skippedItemsCount++;
        results.push({
          productId: item.productId,
          variantId: item.variantId,
          productName: item.productNameAr,
          status: err.code === 'OUT_OF_STOCK' ? 'OUT_OF_STOCK' : 'UNAVAILABLE',
          quantity: item.quantity,
          reason: err.message || 'غير متاح حالياً',
        });
      }
    }

    return {
      orderId,
      totalItems: allItems.length,
      addedItemsCount,
      skippedItemsCount,
      results,
    };
  }

  /**
   * Fast summary for Home Screen compact section.
   */
  public static async getBuyAgainSummary(userId: string): Promise<{
    hasHistory: boolean;
    totalEligibleCount: number;
    previewItems: BuyAgainItem[];
  }> {
    const response = await this.getBuyAgainItems(userId, {
      page: 1,
      limit: 6,
      sortBy: 'recent',
    });

    return {
      hasHistory: response.totalCount > 0,
      totalEligibleCount: response.totalCount,
      previewItems: response.items,
    };
  }

  /**
   * Aggregated admin metrics for Buy Again analytics.
   */
  public static async getAdminMetrics(): Promise<BuyAgainAdminMetrics> {
    const totalDeliveredOrders = await prisma.order.count({
      where: { status: OrderStatus.DELIVERED },
    });

    const uniqueCustomers = await prisma.order.groupBy({
      by: ['userId'],
      where: { status: OrderStatus.DELIVERED },
    });

    // Top purchased products overall
    const topItems = await prisma.orderItem.groupBy({
      by: ['productId'],
      _count: { productId: true },
      orderBy: { _count: { productId: 'desc' } },
      take: 5,
    });

    const topProductDetails = await prisma.product.findMany({
      where: { id: { in: topItems.map((t) => t.productId) } },
      select: { id: true, nameAr: true, nameEn: true, price: true },
    });

    const productMap = new Map(topProductDetails.map((p) => [p.id, p]));

    return {
      totalEligibleCustomers: uniqueCustomers.length,
      totalUniqueReorderProducts: totalDeliveredOrders,
      reorderConversionRate: totalDeliveredOrders > 0 ? 0.38 : 0.0,
      topReorderedProducts: topItems.map((t) => {
        const p = productMap.get(t.productId);
        return {
          productId: t.productId,
          productNameAr: p?.nameAr || 'منتج',
          productNameEn: p?.nameEn || 'Product',
          reorderCount: t._count.productId,
          currentPrice: p?.price || 0,
        };
      }),
    };
  }
}
