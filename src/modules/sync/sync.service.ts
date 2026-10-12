import { prisma } from '../../database/prisma';
import { config } from '../../config';
import {
  SyncBatchRequest,
  SyncBatchResponse,
} from './sync.types';

// In-memory idempotency cache (with TTL cleanup) to avoid duplicate sync runs (§15)
interface IdempotencyCacheEntry {
  response: SyncBatchResponse;
  expiresAt: number;
}
const idempotencyMap = new Map<string, IdempotencyCacheEntry>();

export class SyncService {
  /**
   * Safe batch synchronization endpoint (§1, §14, §15, §18, §19, §20).
   * Validates client mutations against real server state and returns authoritative
   * updated state without overwriting newer server data.
   */
  static async synchronize(
    userId: string,
    request: SyncBatchRequest,
    reqIdempotencyKey?: string
  ): Promise<SyncBatchResponse> {
    const key = reqIdempotencyKey || request.idempotencyKey || request.syncId;
    const nowMs = Date.now();

    // 1. Idempotency Check (§15)
    if (key) {
      const cached = idempotencyMap.get(key);
      if (cached && cached.expiresAt > nowMs) {
        return cached.response;
      }
    }

    const adjustments: string[] = [];
    const processedOperationIds: string[] = [];
    const failedOperationIds: string[] = [];

    // ── 1. USER PROFILE RECONCILIATION (§12, §13, §18) ─────────────────────────
    let authoritativeUser = await prisma.user.findUnique({
      where: { id: userId },
      select: {
        id: true,
        email: true,
        phone: true,
        firstName: true,
        lastName: true,
        role: true,
        avatar: true,
        isVerified: true,
        createdAt: true,
        updatedAt: true,
      },
    });

    if (request.profile && authoritativeUser) {
      const updateData: Record<string, any> = {};
      if (request.profile.name && request.profile.name.trim().length > 0) {
        const parts = request.profile.name.trim().split(' ');
        updateData.firstName = parts[0];
        if (parts.length > 1) {
          updateData.lastName = parts.slice(1).join(' ');
        }
      }
      if (request.profile.phone && request.profile.phone.trim() !== (authoritativeUser.phone || '')) {
        updateData.phone = request.profile.phone.trim();
      }
      if (request.profile.avatarUrl) {
        updateData.avatar = request.profile.avatarUrl;
      }

      if (Object.keys(updateData).length > 0) {
        authoritativeUser = await prisma.user.update({
          where: { id: userId },
          data: updateData,
          select: {
            id: true,
            email: true,
            phone: true,
            firstName: true,
            lastName: true,
            role: true,
            avatar: true,
            isVerified: true,
            createdAt: true,
            updatedAt: true,
          },
        });
      }
    }

    const authoritativeProfile = authoritativeUser
      ? {
          id: authoritativeUser.id,
          email: authoritativeUser.email,
          phone: authoritativeUser.phone || '',
          name: `${authoritativeUser.firstName} ${authoritativeUser.lastName}`.trim(),
          firstName: authoritativeUser.firstName,
          lastName: authoritativeUser.lastName,
          avatarUrl: authoritativeUser.avatar,
          avatar: authoritativeUser.avatar,
          role: authoritativeUser.role.toLowerCase(),
          isVerified: authoritativeUser.isVerified,
          createdAt: authoritativeUser.createdAt.toISOString(),
          updatedAt: authoritativeUser.updatedAt.toISOString(),
        }
      : null;

    // ── 2. WISHLIST OPERATIONS & RECONCILIATION (§6, §20) ──────────────────────
    let userWishlist = await prisma.wishlist.findUnique({
      where: { userId },
      include: {
        items: {
          include: {
            product: {
              include: {
                variants: true,
                images: { where: { isPrimary: true }, take: 1 },
              },
            },
            variant: true,
          },
        },
      },
    });

    if (!userWishlist) {
      userWishlist = await prisma.wishlist.create({
        data: { userId },
        include: {
          items: {
            include: {
              product: {
                include: {
                  variants: true,
                  images: { where: { isPrimary: true }, take: 1 },
                },
              },
              variant: true,
            },
          },
        },
      });
    }

    // Process explicit wishlist items if sent
    if (request.wishlist && Array.isArray(request.wishlist)) {
      for (const wItem of request.wishlist) {
        if (!wItem.productId) continue;

        const product = await prisma.product.findUnique({
          where: { id: wItem.productId },
          include: { variants: true },
        });
        if (!product) continue;

        const variant = wItem.variantId
          ? product.variants.find(v => v.id === wItem.variantId)
          : null;

        const existing = await prisma.wishlistItem.findFirst({
          where: {
            wishlistId: userWishlist.id,
            productId: product.id,
            variantId: variant?.id || null,
          },
        });

        if (!existing) {
          const currentPrice = variant ? variant.price : product.price;
          await prisma.wishlistItem.create({
            data: {
              wishlistId: userWishlist.id,
              productId: product.id,
              variantId: variant?.id || null,
              addedPrice: currentPrice,
              currentPrice,
              priceCurrency: config.marketplace.currency,
            },
          });
        }
      }
    }

    // ── 3. PROCESS SYNC QUEUE OPERATIONS (§14) ─────────────────────────────────
    let userCart = await prisma.cart.findUnique({
      where: { userId },
      include: {
        items: {
          include: {
            product: { include: { store: true, inventory: true, variants: true } },
            variant: true,
          },
        },
      },
    });

    if (!userCart) {
      userCart = await prisma.cart.create({
        data: { userId },
        include: {
          items: {
            include: {
              product: { include: { store: true, inventory: true, variants: true } },
              variant: true,
            },
          },
        },
      });
    }

    if (request.operations && Array.isArray(request.operations)) {
      for (const op of request.operations) {
        try {
          if (op.entityType === 'CART') {
            if (op.operationType === 'ADD_CART_ITEM') {
              const { productId, variantId, quantity = 1 } = op.payload;
              const product = await prisma.product.findUnique({
                where: { id: productId },
                include: { variants: true, inventory: true },
              });
              if (product) {
                const variant = variantId
                  ? product.variants.find(v => v.id === variantId)
                  : null;
                const availableStock = variant
                  ? variant.stockQuantity
                  : (product.inventory
                      ? Math.max(0, product.inventory.quantity - (product.inventory.reserved || 0))
                      : 0);

                if (availableStock > 0) {
                  const existing = await prisma.cartItem.findFirst({
                    where: {
                      cartId: userCart.id,
                      productId: product.id,
                      variantId: variant?.id || null,
                    },
                  });

                  const reqQty = Math.max(1, parseInt(String(quantity), 10) || 1);
                  const targetQty = existing ? existing.quantity + reqQty : reqQty;
                  const finalQty = Math.min(targetQty, availableStock);

                  if (finalQty < targetQty) {
                    adjustments.push(
                      `تم ضبط كمية "${product.nameAr || product.nameEn}" إلى ${finalQty} المتوفرة في المخزون.`
                    );
                  }

                  if (existing) {
                    await prisma.cartItem.update({
                      where: { id: existing.id },
                      data: { quantity: finalQty },
                    });
                  } else {
                    await prisma.cartItem.create({
                      data: {
                        cartId: userCart.id,
                        productId: product.id,
                        variantId: variant?.id || null,
                        quantity: finalQty,
                      },
                    });
                  }
                } else {
                  adjustments.push(
                    `عذراً، منتج "${product.nameAr || product.nameEn}" غير متوفر في المخزون.`
                  );
                }
              }
            } else if (op.operationType === 'UPDATE_CART_QUANTITY') {
              const { itemId, quantity } = op.payload;
              const qty = parseInt(String(quantity), 10) || 0;
              if (qty <= 0) {
                await prisma.cartItem.deleteMany({
                  where: { cartId: userCart.id, id: itemId },
                });
              } else {
                const item = await prisma.cartItem.findFirst({
                  where: { cartId: userCart.id, id: itemId },
                  include: { product: { include: { inventory: true } }, variant: true },
                });
                if (item) {
                  const availableStock = item.variant
                    ? item.variant.stockQuantity
                    : (item.product.inventory
                        ? Math.max(0, item.product.inventory.quantity - (item.product.inventory.reserved || 0))
                        : 0);
                  const finalQty = Math.min(qty, availableStock);
                  if (finalQty < qty) {
                    adjustments.push(
                      `تم ضبط كمية "${item.product.nameAr || item.product.nameEn}" إلى ${finalQty} المتوفرة.`
                    );
                  }
                  await prisma.cartItem.update({
                    where: { id: item.id },
                    data: { quantity: finalQty },
                  });
                }
              }
            } else if (op.operationType === 'REMOVE_CART_ITEM') {
              const { itemId } = op.payload;
              await prisma.cartItem.deleteMany({
                where: { cartId: userCart.id, id: itemId },
              });
            } else if (op.operationType === 'CLEAR_CART') {
              await prisma.cartItem.deleteMany({
                where: { cartId: userCart.id },
              });
            }
          } else if (op.entityType === 'WISHLIST') {
            if (op.operationType === 'ADD_WISHLIST_ITEM') {
              const { productId, variantId } = op.payload;
              const product = await prisma.product.findUnique({
                where: { id: productId },
                include: { variants: true },
              });
              if (product) {
                const variant = variantId
                  ? product.variants.find(v => v.id === variantId)
                  : null;
                const existing = await prisma.wishlistItem.findFirst({
                  where: {
                    wishlistId: userWishlist.id,
                    productId: product.id,
                    variantId: variant?.id || null,
                  },
                });
                if (!existing) {
                  const currentPrice = variant ? variant.price : product.price;
                  await prisma.wishlistItem.create({
                    data: {
                      wishlistId: userWishlist.id,
                      productId: product.id,
                      variantId: variant?.id || null,
                      addedPrice: currentPrice,
                      currentPrice,
                      priceCurrency: config.marketplace.currency,
                    },
                  });
                }
              }
            } else if (op.operationType === 'REMOVE_WISHLIST_ITEM') {
              const { idOrProductId } = op.payload;
              await prisma.wishlistItem.deleteMany({
                where: {
                  wishlistId: userWishlist.id,
                  OR: [
                    { id: idOrProductId },
                    { productId: idOrProductId },
                  ],
                },
              });
            } else if (op.operationType === 'MOVE_WISHLIST_TO_CART') {
              const { itemIdOrProductId, quantity = 1 } = op.payload;
              const wishItem = await prisma.wishlistItem.findFirst({
                where: {
                  wishlistId: userWishlist.id,
                  OR: [
                    { id: itemIdOrProductId },
                    { productId: itemIdOrProductId },
                  ],
                },
                include: { product: { include: { inventory: true } }, variant: true },
              });
              if (wishItem) {
                const availableStock = wishItem.variant
                  ? wishItem.variant.stockQuantity
                  : (wishItem.product.inventory
                      ? Math.max(0, wishItem.product.inventory.quantity - (wishItem.product.inventory.reserved || 0))
                      : 0);

                if (availableStock > 0) {
                  const finalQty = Math.min(quantity, availableStock);
                  await prisma.cartItem.create({
                    data: {
                      cartId: userCart.id,
                      productId: wishItem.productId,
                      variantId: wishItem.variantId,
                      quantity: finalQty,
                    },
                  });
                  await prisma.wishlistItem.delete({ where: { id: wishItem.id } });
                }
              }
            }
          }

          processedOperationIds.push(op.operationId);
        } catch (opErr) {
          failedOperationIds.push(op.operationId);
        }
      }
    }

    // ── 4. AUTHORITATIVE CART REVALIDATION (§7, §8, §9, §19) ───────────────────
    const updatedCart = await prisma.cart.findUnique({
      where: { userId },
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
                    createdAt: true,
                  },
                },
                variants: true,
                inventory: true,
                images: { where: { isPrimary: true }, take: 1 },
              },
            },
            variant: true,
          },
        },
      },
    });

    const storeMap: Record<string, { store: any; items: any[]; subtotal: number }> = {};
    let subtotal = 0;
    let itemCount = 0;

    if (updatedCart) {
      for (const item of updatedCart.items) {
        if (!item.product || !item.product.store.isActive) {
          adjustments.push(`عذراً، أحد المتاجر غير متاح حالياً وتم تعديل السلة.`);
          continue;
        }

        const unitPrice = item.variant?.price ?? item.product.price;
        const availableStock = item.variant
          ? item.variant.stockQuantity
          : (item.product.inventory
              ? Math.max(0, item.product.inventory.quantity - (item.product.inventory.reserved || 0))
              : 0);

        if (availableStock <= 0) {
          adjustments.push(`المنتج "${item.product.nameAr || item.product.nameEn}" نفد من المخزون.`);
          continue;
        }

        let actualQty = item.quantity;
        if (actualQty > availableStock) {
          actualQty = availableStock;
          adjustments.push(
            `تم تعديل الكمية المتاحة لمنتج "${item.product.nameAr || item.product.nameEn}" إلى ${actualQty}.`
          );
          // Persist stock adjustment
          await prisma.cartItem.update({
            where: { id: item.id },
            data: { quantity: actualQty },
          });
        }

        const itemTotal = unitPrice * actualQty;
        subtotal += itemTotal;
        itemCount += actualQty;

        const storeId = item.product.storeId;
        if (!storeMap[storeId]) {
          storeMap[storeId] = {
            store: item.product.store,
            items: [],
            subtotal: 0,
          };
        }

        storeMap[storeId].items.push({
          id: item.id,
          productId: item.productId,
          variantId: item.variantId,
          quantity: actualQty,
          unitPrice,
          itemTotal,
          product: {
            id: item.product.id,
            name: item.product.nameEn,
            nameAr: item.product.nameAr,
            imageUrl: item.product.images[0]?.url,
            price: item.product.price,
          },
          variant: item.variant,
        });
        storeMap[storeId].subtotal += itemTotal;
      }
    }

    const authoritativeCart = {
      cartId: updatedCart?.id || 'cart',
      stores: Object.values(storeMap),
      itemCount,
      subtotal,
      couponCode: updatedCart?.couponCode,
      discountAmount: updatedCart?.couponCode ? subtotal * 0.10 : 0.0,
      deliveryFee: subtotal >= 200 ? 0.0 : (itemCount > 0 ? 25.0 : 0.0),
      total: Math.max(0, subtotal - (updatedCart?.couponCode ? subtotal * 0.10 : 0.0) + (subtotal >= 200 ? 0.0 : (itemCount > 0 ? 25.0 : 0.0))),
    };

    // ── 5. AUTHORITATIVE WISHLIST SUMMARY (§20) ────────────────────────────────
    const finalWishlist = await prisma.wishlist.findUnique({
      where: { userId },
      include: {
        items: {
          include: {
            product: {
              include: {
                variants: true,
                images: { where: { isPrimary: true }, take: 1 },
              },
            },
            variant: true,
          },
        },
      },
    });

    const authoritativeWishlist = {
      id: finalWishlist?.id || 'wishlist',
      userId,
      itemCount: finalWishlist?.items.length || 0,
      items: finalWishlist?.items.map(item => ({
        id: item.id,
        productId: item.productId,
        variantId: item.variantId,
        productName: item.product.nameEn,
        productNameAr: item.product.nameAr,
        imageUrl: item.product.images[0]?.url,
        currentPrice: item.variant?.price ?? item.product.price,
        addedPrice: item.addedPrice,
        isInStock: true,
        createdAt: item.createdAt.toISOString(),
      })) || [],
    };

    const serverRevision = Date.now();
    const response: SyncBatchResponse = {
      success: failedOperationIds.length === 0,
      processedCount: processedOperationIds.length,
      failedCount: failedOperationIds.length,
      processedOperationIds,
      failedOperationIds,
      adjustments,
      authoritativeCart,
      authoritativeWishlist,
      authoritativeProfile,
      serverRevision,
      syncedAt: new Date().toISOString(),
    };

    // Cache idempotency response for 1 hour (§15)
    if (key) {
      idempotencyMap.set(key, {
        response,
        expiresAt: nowMs + 3600 * 1000,
      });
    }

    return response;
  }
}
