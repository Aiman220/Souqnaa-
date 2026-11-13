import { Router, Request, Response, NextFunction } from 'express';
import { prisma } from '../../database/prisma';
import { authenticate, optionalAuth } from '../../middleware/auth.middleware';
import { storefrontLimiter } from '../../middleware/rate-limiter.middleware';
import { requireSeller } from '../../middleware/rbac.middleware';
import { ResponseUtil } from '../../utils/response.util';
import { AppError } from '../../middleware/error.middleware';
import {
  formatProductForClient,
  formatProductsForClient,
  formatProductsWithCampaigns,
  formatProductWithCampaign,
} from '../../utils/product-formatter.util';
import { WishlistAlertsJob } from '../../services/jobs/wishlist-alerts.job';
import { catalogVisualIndexService } from '../search/visual/catalog-visual-index.service';
import { recommendationService } from '../recommendations/services/recommendation.service';
import { StorefrontInvalidatorService } from '../../services/storefront-invalidator.service';
import { deliveryServiceabilityService } from '../../services/delivery/delivery-serviceability.service';
import { RemoteConfigService } from '../remote-config/remote-config.service';
import { digitalFulfillmentService } from '../../services/digital/digital-fulfillment.service';
import { UrlSecurityUtil } from '../../utils/url-security.util';
import { FulfillmentType, DigitalDeliveryType } from '@prisma/client';

const router = Router();

// GET /api/v1/products — Search & Filtering
router.get('/', storefrontLimiter, optionalAuth, async (req: Request, res: Response, next: NextFunction) => {
  try {
    const rawPage = parseInt(String(req.query.page || '1'), 10);
    const page = !isNaN(rawPage) && rawPage >= 1 ? rawPage : 1;
    const rawLimit = parseInt(String(req.query.limit || '20'), 10);
    const limit = !isNaN(rawLimit) && rawLimit >= 1 ? Math.min(rawLimit, 50) : 20;
    const skip = (page - 1) * limit;

    const {
      q,
      categoryId,
      brandId,
      storeId,
      minPrice,
      maxPrice,
      isFeatured,
      inStock,
      sortBy = 'createdAt',
      sortOrder = 'desc',
      cursor,
    } = req.query;

    const ALLOWED_SORT_FIELDS = ['createdAt', 'price', 'rating', 'soldCount', 'nameAr', 'nameEn'];
    const safeSortBy = ALLOWED_SORT_FIELDS.includes(String(sortBy)) ? String(sortBy) : 'createdAt';
    const safeSortOrder: 'asc' | 'desc' = String(sortOrder).toLowerCase() === 'asc' ? 'asc' : 'desc';

    const where: any = {
      isActive: true,
    };

    if (q) {
      where.OR = [
        { nameAr: { contains: String(q), mode: 'insensitive' } },
        { nameEn: { contains: String(q), mode: 'insensitive' } },
        { descriptionAr: { contains: String(q), mode: 'insensitive' } },
        { descriptionEn: { contains: String(q), mode: 'insensitive' } },
      ];
    }

    if (categoryId) {
      const cleanCategoryId = String(categoryId).trim();
      const category = await prisma.category.findFirst({
        where: {
          OR: [{ id: cleanCategoryId }, { slug: cleanCategoryId }],
          isActive: true,
        },
        include: { children: { where: { isActive: true }, select: { id: true } } },
      });
      if (category) {
        where.categoryId = { in: [category.id, ...category.children.map(c => c.id)] };
      } else {
        where.categoryId = cleanCategoryId;
      }
    }

    if (brandId) where.brandId = String(brandId);

    const isCityDiscoveryEnabled = await RemoteConfigService.getInstance().isFeatureActive('city_based_product_discovery', {
      userId: req.user?.userId,
    });

    if (isCityDiscoveryEnabled) {
      const destination = await deliveryServiceabilityService.resolveCustomerDestination(req);
      if (destination) {
        if (!destination.isSupported) {
          return ResponseUtil.paginated(res, [], 0, page, limit);
        }
        const serviceableStoreIds = await deliveryServiceabilityService.getServiceableStoreIds(destination);
        if (storeId) {
          if (!serviceableStoreIds.has(String(storeId))) {
            return ResponseUtil.paginated(res, [], 0, page, limit);
          }
          where.storeId = String(storeId);
        } else {
          where.storeId = { in: Array.from(serviceableStoreIds) };
        }
      } else if (storeId) {
        where.storeId = String(storeId);
      }
    } else if (storeId) {
      where.storeId = String(storeId);
    }
    if (isFeatured !== undefined) where.isFeatured = isFeatured === 'true';

    if (minPrice != null || maxPrice != null) {
      const pMin = minPrice !== undefined && String(minPrice).trim() !== '' ? parseFloat(String(minPrice)) : undefined;
      const pMax = maxPrice !== undefined && String(maxPrice).trim() !== '' ? parseFloat(String(maxPrice)) : undefined;
      if (pMin !== undefined && (isNaN(pMin) || pMin < 0)) {
        throw new AppError('Minimum price must be a valid non-negative number', 400);
      }
      if (pMax !== undefined && (isNaN(pMax) || pMax < 0)) {
        throw new AppError('Maximum price must be a valid non-negative number', 400);
      }
      if (pMin !== undefined && pMax !== undefined && pMin > pMax) {
        throw new AppError('Minimum price cannot exceed maximum price', 400);
      }
      where.price = {};
      if (pMin !== undefined) where.price.gte = pMin;
      if (pMax !== undefined) where.price.lte = pMax;
    }

    if (inStock === 'true') {
      where.inventory = { quantity: { gt: 0 } };
    }

    // Stable ordering with unique tie-breaker on ID ensures deterministic pagination
    const orderByClause = [
      { [safeSortBy]: safeSortOrder },
      { id: 'asc' as const },
    ];

    const findArgs: any = {
      where,
      take: limit,
      orderBy: orderByClause,
      include: {
        store: { select: { id: true, name: true, logo: true, isVerified: true } },
        category: { select: { id: true, nameAr: true, nameEn: true, slug: true } },
        images: {
          orderBy: { sortOrder: 'asc' },
          select: { id: true, url: true, isPrimary: true, sortOrder: true },
        },
        variants: {
          select: {
            id: true,
            productId: true,
            sku: true,
            price: true,
            compareAtPrice: true,
            stockQuantity: true,
            nameAr: true,
            nameEn: true,
            image: true,
          },
        },
        inventory: { select: { quantity: true, reserved: true } },
      },
    };

    if (cursor) {
      findArgs.cursor = { id: String(cursor) };
      findArgs.skip = 1;
    } else {
      findArgs.skip = skip;
    }

    const [total, products] = await Promise.all([
      prisma.product.count({ where }),
      prisma.product.findMany(findArgs),
    ]);

    const nextCursor = products.length === limit ? products[products.length - 1].id : null;
    const locale = req.headers['accept-language']?.includes('en') ? 'en' : 'ar';
    const formatted = await formatProductsWithCampaigns(products, locale);
    ResponseUtil.paginated(res, formatted, total, page, limit, undefined, nextCursor);
  } catch (error) {
    next(error);
  }
});

// GET /api/v1/products/featured
router.get('/featured', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const where: any = { isActive: true, isFeatured: true };
    const isCityDiscoveryEnabled = await RemoteConfigService.getInstance().isFeatureActive('city_based_product_discovery', {
      userId: req.user?.userId,
    });
    if (isCityDiscoveryEnabled) {
      const destination = await deliveryServiceabilityService.resolveCustomerDestination(req);
      if (destination) {
        if (!destination.isSupported) {
          return ResponseUtil.success(res, []);
        }
        const serviceableStoreIds = await deliveryServiceabilityService.getServiceableStoreIds(destination);
        if (serviceableStoreIds.size === 0) {
          return ResponseUtil.success(res, []);
        }
        where.storeId = { in: Array.from(serviceableStoreIds) };
      }
    }

    const products = await prisma.product.findMany({
      where,
      take: 12,
      include: {
        store: { select: { id: true, name: true, logo: true, isVerified: true } },
        images: { where: { isPrimary: true } },
        inventory: { select: { quantity: true } },
      },
    });
    const locale = req.headers['accept-language']?.includes('en') ? 'en' : 'ar';
    const formatted = await formatProductsWithCampaigns(products, locale);
    ResponseUtil.success(res, formatted);
  } catch (error) {
    next(error);
  }
});

// GET /api/v1/products/best-sellers
router.get('/best-sellers', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const where: any = { isActive: true };
    const isCityDiscoveryEnabled = await RemoteConfigService.getInstance().isFeatureActive('city_based_product_discovery', {
      userId: req.user?.userId,
    });
    if (isCityDiscoveryEnabled) {
      const destination = await deliveryServiceabilityService.resolveCustomerDestination(req);
      if (destination) {
        if (!destination.isSupported) {
          return ResponseUtil.success(res, []);
        }
        const serviceableStoreIds = await deliveryServiceabilityService.getServiceableStoreIds(destination);
        if (serviceableStoreIds.size === 0) {
          return ResponseUtil.success(res, []);
        }
        where.storeId = { in: Array.from(serviceableStoreIds) };
      }
    }

    const products = await prisma.product.findMany({
      where,
      orderBy: { soldCount: 'desc' },
      take: 12,
      include: {
        store: { select: { id: true, name: true, logo: true, isVerified: true } },
        images: { where: { isPrimary: true } },
        inventory: { select: { quantity: true } },
      },
    });
    const locale = req.headers['accept-language']?.includes('en') ? 'en' : 'ar';
    const formatted = await formatProductsWithCampaigns(products, locale);
    ResponseUtil.success(res, formatted);
  } catch (error) {
    next(error);
  }
});

// GET /api/v1/products/suggestions
router.get('/suggestions', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const { q } = req.query;
    if (!q || String(q).trim().length === 0) {
      return ResponseUtil.success(res, []);
    }

    const where: any = {
      isActive: true,
      OR: [
        { nameAr: { contains: String(q), mode: 'insensitive' } },
        { nameEn: { contains: String(q), mode: 'insensitive' } },
      ],
    };

    const isCityDiscoveryEnabled = await RemoteConfigService.getInstance().isFeatureActive('city_based_product_discovery', {
      userId: req.user?.userId,
    });
    if (isCityDiscoveryEnabled) {
      const destination = await deliveryServiceabilityService.resolveCustomerDestination(req);
      if (destination) {
        if (!destination.isSupported) {
          return ResponseUtil.success(res, []);
        }
        const serviceableStoreIds = await deliveryServiceabilityService.getServiceableStoreIds(destination);
        if (serviceableStoreIds.size === 0) {
          return ResponseUtil.success(res, []);
        }
        where.storeId = { in: Array.from(serviceableStoreIds) };
      }
    }

    const suggestions = await prisma.product.findMany({
      where,
      select: { id: true, nameAr: true, nameEn: true, price: true, slug: true },
      take: 6,
    });

    ResponseUtil.success(res, suggestions);
  } catch (error) {
    next(error);
  }
});

// GET /api/v1/products/:id/recommendations (§29)
router.get('/:id/recommendations', optionalAuth, async (req: Request, res: Response) => {
  const { recommendationController } = await import('../recommendations/controllers/recommendation.controller');
  return recommendationController.getProductRecommendations(req, res);
});

// GET /api/v1/products/:id
router.get('/:id', storefrontLimiter, optionalAuth, async (req: Request, res: Response, next: NextFunction) => {
  try {
    const id = String(req.params.id);
    const product = await prisma.product.findFirst({
      where: { OR: [{ id }, { slug: id }] },
      include: {
        store: {
          include: {
            _count: {
              select: {
                products: { where: { isActive: true } },
              },
            },
          },
        },
        category: true,
        brand: true,
        images: { orderBy: { sortOrder: 'asc' } },
        variants: true,
        attributes: true,
        inventory: true,
        productReviews: {
          take: 5,
          where: { status: 'PUBLISHED' as any },
          orderBy: { createdAt: 'desc' },
          select: {
            id: true,
            rating: true,
            title: true,
            body: true,
            verifiedPurchase: true,
            helpfulCount: true,
            createdAt: true,
            user: { select: { firstName: true, lastName: true, avatar: true } },
            media: { where: { moderationStatus: 'APPROVED' as any }, take: 3, orderBy: { sortOrder: 'asc' } },
            sellerResponse: { where: { status: 'PUBLISHED' as any }, select: { body: true, createdAt: true } },
          },
        },
        ratingSummary: true,
      },
    });

    if (!product) throw new AppError('Product not found', 404);

    // Security Mandates 3 & 5: Ensure unpublished/inactive products cannot be viewed publicly.
    // Allow access only if active OR if caller is admin or the seller owning this product.
    if (!product.isActive) {
      const user = (req as any).user;
      const isOwnerSeller = user && (user.sellerId === product.store?.sellerId || user.role === 'ADMIN');
      if (!isOwnerSeller) {
        throw new AppError('Product not found', 404);
      }
    }
    const locale = req.headers['accept-language']?.includes('en') ? 'en' : 'ar';
    const formatted = await formatProductWithCampaign(product, locale);

    const isCityDiscoveryActive = await RemoteConfigService.getInstance().isFeatureActive('city_based_product_discovery', {
      userId: (req as any).user?.userId,
    });

    if (isCityDiscoveryActive && formatted && product.store) {
      const destination = await deliveryServiceabilityService.resolveCustomerDestination(req);
      if (destination) {
        const evalResult = await deliveryServiceabilityService.evaluateStoreServiceability(product.store, destination);
        formatted.isDeliverable = evalResult.isDeliverable;
        formatted.deliveryAvailability = {
          isDeliverable: evalResult.isDeliverable,
          distanceKm: evalResult.distanceKm,
          destinationCity: destination.cityName,
          reason: evalResult.reason,
          reasonAr: evalResult.reasonAr,
        };
      } else {
        formatted.isDeliverable = true;
        formatted.deliveryAvailability = null;
      }
    }
    if (formatted && formatted.store) {
      const sellerId = product.store?.sellerId || (product as any).sellerId || formatted.store?.sellerId;
      if (sellerId) {
        const { SellerPerformanceService } = await import('../seller-performance/seller-performance.service');
        const performance = await SellerPerformanceService.getPublicSellerPerformance(sellerId).catch(() => null);
        formatted.store.performance = performance;
        formatted.performance = performance;
      }
    }
    ResponseUtil.success(res, formatted);
  } catch (error) {
    next(error);
  }
});

// POST /api/v1/products (Seller create product)
router.post('/', authenticate, requireSeller, async (req: Request, res: Response, next: NextFunction) => {
  try {
    const seller = await prisma.seller.findUnique({
      where: { userId: req.user!.userId },
      include: { stores: true },
    });

    if (!seller || seller.stores.length === 0) {
      throw new AppError('You must create a store before listing products', 400);
    }

    const validStore = req.body.storeId
      ? seller.stores.find((s) => s.id === req.body.storeId)
      : seller.stores[0];

    if (!validStore) {
      throw new AppError('المتجر المحدد غير صالح أو لا تملك صلاحية النشر فيه', 403);
    }

    const storeId = validStore.id;

    const {
      categoryId,
      brandId,
      nameAr,
      nameEn,
      descriptionAr,
      descriptionEn,
      price,
      compareAtPrice,
      sku,
      stockQuantity = 10,
      images = [],
      variants = [],
      attributes = [],
      fulfillmentType: rawFulfillmentType = 'PHYSICAL',
      digitalDeliveryType,
      digitalFileUrl,
      digitalInstructions,
    } = req.body;

    const fulfillmentType: FulfillmentType =
      String(rawFulfillmentType).toUpperCase() === 'DIGITAL' ? FulfillmentType.DIGITAL : FulfillmentType.PHYSICAL;

    if (fulfillmentType === FulfillmentType.DIGITAL) {
      const category = await prisma.category.findUnique({ where: { id: categoryId } });
      const isEligible = digitalFulfillmentService.isSubcategoryEligibleForDigital(category?.slug);
      if (!isEligible && req.user?.role !== 'ADMIN') {
        throw new AppError(
          'القسم المحدد غير مؤهل لمنتجات التسليم الرقمي. الأقسام المؤهلة تشمل: شحن الرصيد، باقات الإنترنت، بطاقات الهدايا، بطاقات الألعاب، الاشتراكات، والبرمجيات.',
          400,
          'CATEGORY_NOT_DIGITAL_ELIGIBLE'
        );
      }
      if (digitalFileUrl && typeof digitalFileUrl === 'string') {
        if (!UrlSecurityUtil.isSafeUrl(digitalFileUrl)) {
          throw new AppError('رابط الملف الرقمي غير صالح أو غير مسموح به لأسباب أمنية', 400, 'INVALID_DIGITAL_URL');
        }
      }
    }

    const slug = `${nameEn.toLowerCase().replace(/[\s\W-]+/g, '-')}-${Date.now()}`;

    const product = await prisma.$transaction(async (tx) => {
      const created = await tx.product.create({
        data: {
          storeId,
          categoryId,
          brandId,
          nameAr,
          nameEn,
          slug,
          descriptionAr,
          descriptionEn,
          price: parseFloat(price),
          compareAtPrice: compareAtPrice ? parseFloat(compareAtPrice) : null,
          sku: sku || `SKU-${Date.now()}`,
          fulfillmentType,
          digitalDeliveryType: fulfillmentType === FulfillmentType.DIGITAL ? (digitalDeliveryType || DigitalDeliveryType.CODE) : null,
          digitalFileUrl: fulfillmentType === FulfillmentType.DIGITAL ? (digitalFileUrl || null) : null,
          digitalInstructions: fulfillmentType === FulfillmentType.DIGITAL ? (digitalInstructions || null) : null,
          images: {
            create: images.map((img: any, idx: number) => ({
              url: typeof img === 'string' ? img : img.url,
              isPrimary: idx === 0,
              sortOrder: idx,
            })),
          },
          attributes: {
            create: attributes.map((attr: any) => ({
              keyAr: attr.keyAr,
              keyEn: attr.keyEn,
              valueAr: attr.valueAr,
              valueEn: attr.valueEn,
            })),
          },
          variants: {
            create: variants.map((v: any, idx: number) => ({
              nameAr: v.nameAr || `متغير ${idx + 1}`,
              nameEn: v.nameEn || v.nameAr || `Variant ${idx + 1}`,
              sku: v.sku || null,
              price: parseFloat(v.price),
              compareAtPrice: v.compareAtPrice ? parseFloat(v.compareAtPrice) : null,
              stockQuantity: parseInt(v.stockQuantity || v.stock || '0', 10),
              image: v.image || null,
            })),
          },
        },
      });

      await tx.inventory.create({
        data: {
          productId: created.id,
          quantity: parseInt(String(stockQuantity), 10),
        },
      });

      return created;
    });

    StorefrontInvalidatorService.onProductMutation({
      productId: product.id,
      slug: product.slug,
      storeId: validStore.id,
      storeSlug: validStore.slug,
      categoryId: product.categoryId,
    }).catch((err) => {
      console.warn('[createProduct] Invalidation error:', err);
    });

    ResponseUtil.created(res, product, 'Product created successfully');
  } catch (error) {
    next(error);
  }
});

// PUT /api/v1/products/:id
router.put('/:id', authenticate, requireSeller, async (req: Request, res: Response, next: NextFunction) => {
  try {
    const id = String(req.params.id);
    const isAdmin = req.user?.role === 'ADMIN';

    // 1. Fetch existing product with store relation
    const existing = await prisma.product.findUnique({
      where: { id },
      include: {
        store: { select: { id: true, sellerId: true } },
      },
    });

    if (!existing) {
      throw new AppError('المنتج غير موجود أو لا تملك صلاحية تعديله', 404);
    }

    // 2. Enforce strict seller store ownership if not admin
    if (!isAdmin) {
      const seller = await prisma.seller.findUnique({
        where: { userId: req.user!.userId },
        include: { stores: { select: { id: true } } },
      });

      const ownedStoreIds = seller?.stores.map((s) => s.id) || [];
      if (!seller || !ownedStoreIds.includes(existing.storeId)) {
        throw new AppError('المنتج غير موجود أو لا تملك صلاحية تعديله', 404);
      }
    }

    // 3. Strict whitelist of mutable fields to prevent privilege escalation / mass assignment
    // Disallow storeId, sellerId, commissionRate, isSuspended, isFeatured, rating, reviewCount, soldCount tampering
    const {
      nameAr,
      nameEn,
      descriptionAr,
      descriptionEn,
      categoryId,
      brandId,
      sku,
      barcode,
      price,
      compareAtPrice,
      weight,
      hasWarranty,
      warrantyPeriod,
      warrantyPolicy,
      videoUrl,
      isActive,
      stockQuantity,
      variants,
      fulfillmentType,
      digitalDeliveryType,
      digitalFileUrl,
      digitalInstructions,
    } = req.body;

    const updateData: any = {};
    if (fulfillmentType !== undefined) {
      const targetType = String(fulfillmentType).toUpperCase() === 'DIGITAL' ? FulfillmentType.DIGITAL : FulfillmentType.PHYSICAL;
      if (targetType === FulfillmentType.DIGITAL) {
        const catId = categoryId || existing.categoryId;
        const cat = await prisma.category.findUnique({ where: { id: catId } });
        const isEligible = digitalFulfillmentService.isSubcategoryEligibleForDigital(cat?.slug);
        if (!isEligible && !isAdmin) {
          throw new AppError('القسم المحدد غير مؤهل لمنتجات التسليم الرقمي', 400, 'CATEGORY_NOT_DIGITAL_ELIGIBLE');
        }
      }
      updateData.fulfillmentType = targetType;
    }
    if (digitalDeliveryType !== undefined) updateData.digitalDeliveryType = digitalDeliveryType;
    if (digitalFileUrl !== undefined) {
      if (digitalFileUrl && typeof digitalFileUrl === 'string' && !UrlSecurityUtil.isSafeUrl(digitalFileUrl)) {
        throw new AppError('رابط الملف الرقمي غير صالح أو غير مسموح به لأسباب أمنية', 400, 'INVALID_DIGITAL_URL');
      }
      updateData.digitalFileUrl = digitalFileUrl;
    }
    if (digitalInstructions !== undefined) updateData.digitalInstructions = digitalInstructions ? String(digitalInstructions) : null;
    if (nameAr !== undefined) updateData.nameAr = String(nameAr);
    if (nameEn !== undefined) updateData.nameEn = String(nameEn);
    if (descriptionAr !== undefined) updateData.descriptionAr = descriptionAr ? String(descriptionAr) : null;
    if (descriptionEn !== undefined) updateData.descriptionEn = descriptionEn ? String(descriptionEn) : null;
    if (categoryId !== undefined) updateData.categoryId = String(categoryId);
    if (brandId !== undefined) updateData.brandId = brandId ? String(brandId) : null;
    if (sku !== undefined) updateData.sku = sku ? String(sku) : null;
    if (barcode !== undefined) updateData.barcode = barcode ? String(barcode) : null;
    if (price !== undefined) updateData.price = parseFloat(String(price));
    if (compareAtPrice !== undefined) updateData.compareAtPrice = compareAtPrice ? parseFloat(String(compareAtPrice)) : null;
    if (weight !== undefined) updateData.weight = weight ? parseFloat(String(weight)) : null;
    if (hasWarranty !== undefined) updateData.hasWarranty = Boolean(hasWarranty);
    if (warrantyPeriod !== undefined) updateData.warrantyPeriod = warrantyPeriod ? String(warrantyPeriod) : null;
    if (warrantyPolicy !== undefined) updateData.warrantyPolicy = warrantyPolicy ? String(warrantyPolicy) : null;
    if (videoUrl !== undefined) updateData.videoUrl = videoUrl ? String(videoUrl) : null;
    if (isActive !== undefined) updateData.isActive = Boolean(isActive);

    if (isAdmin) {
      if (req.body.isFeatured !== undefined) updateData.isFeatured = Boolean(req.body.isFeatured);
      if (req.body.isSuspended !== undefined) updateData.isSuspended = Boolean(req.body.isSuspended);
      if (req.body.commissionRate !== undefined) updateData.commissionRate = req.body.commissionRate !== null ? parseFloat(String(req.body.commissionRate)) : null;
    }

    const updated = await prisma.product.update({
      where: { id },
      data: updateData,
    });

    if (stockQuantity !== undefined) {
      const parsedQty = parseInt(String(stockQuantity), 10);
      const prevInventory = await prisma.inventory.findUnique({
        where: { productId: id },
      });
      const prevAvailable = prevInventory ? Math.max(0, prevInventory.quantity - prevInventory.reserved) : 0;

      await prisma.inventory.upsert({
        where: { productId: id },
        update: { quantity: parsedQty },
        create: { productId: id, quantity: parsedQty, reserved: 0 },
      });

      const newAvailable = Math.max(0, parsedQty - (prevInventory?.reserved || 0));
      if (prevAvailable <= 0 && newAvailable > 0) {
        WishlistAlertsJob.onProductStockRestocked(id).catch(() => {});
      }
    }

    if (Array.isArray(variants)) {
      await prisma.$transaction(async (tx) => {
        await tx.productVariant.deleteMany({ where: { productId: id } });
        if (variants.length > 0) {
          await tx.productVariant.createMany({
            data: variants.map((v: any, index: number) => ({
              productId: id,
              nameAr: v.nameAr || `متغير ${index + 1}`,
              nameEn: v.nameEn || v.nameAr || `Variant ${index + 1}`,
              sku: v.sku || `${updated.sku || 'SKU'}-V${index + 1}-${Date.now().toString().slice(-4)}`,
              price: v.price !== undefined && v.price !== '' ? parseFloat(v.price) : updated.price,
              compareAtPrice: v.compareAtPrice ? parseFloat(v.compareAtPrice) : null,
              stockQuantity: parseInt(v.stockQuantity || v.stock || '0', 10) || 0,
              image: v.image || null,
            })),
          });
        }
      });
    }

    if (price !== undefined) {
      WishlistAlertsJob.onProductPriceUpdated(id).catch(() => {});
    }

    catalogVisualIndexService.indexProduct(id).catch(err => {
      console.warn('[VisualIndex] Background product reindex error:', err);
    });

    recommendationService.invalidateProductCache(id).catch(err => {
      console.warn('[Recommendation] Product cache invalidation error:', err);
    });

    StorefrontInvalidatorService.onProductMutation({
      productId: id,
      slug: updated.slug,
      storeId: existing.storeId,
      categoryId: updated.categoryId,
    }).catch((err) => {
      console.warn('[updateProduct] Invalidation error:', err);
    });

    ResponseUtil.success(res, updated, 'Product updated successfully');
  } catch (error) {
    next(error);
  }
});

// POST /api/v1/products/:id/digital-codes (Seller add encrypted digital codes to pool)
router.post('/:id/digital-codes', authenticate, requireSeller, async (req: Request, res: Response, next: NextFunction) => {
  try {
    const productId = String(req.params.id);
    const { codes } = req.body;

    if (!Array.isArray(codes) || codes.length === 0) {
      throw new AppError('يرجى تقديم قائمة صالحة من الرموز الرقمية (مصفوفة نصوص)', 400);
    }

    const seller = await prisma.seller.findUnique({
      where: { userId: req.user!.userId },
    });
    const sellerId = seller?.id || '';

    const result = await digitalFulfillmentService.addDigitalCodes({
      productId,
      sellerId,
      codes,
      actorId: req.user!.userId,
      actorRole: req.user?.role || 'SELLER',
    });

    ResponseUtil.success(res, result, 'تمت إضافة الرموز الرقمية بنجاح إلى مخزون المنتج');
  } catch (error) {
    next(error);
  }
});

// GET /api/v1/products/:id/digital-codes (View safe masked pool list and stock count)
router.get('/:id/digital-codes', authenticate, requireSeller, async (req: Request, res: Response, next: NextFunction) => {
  try {
    const productId = String(req.params.id);
    const seller = await prisma.seller.findUnique({
      where: { userId: req.user!.userId },
      include: { stores: true },
    });

    const product = await prisma.product.findUnique({
      where: { id: productId },
      include: { store: true },
    });

    if (!product) throw new AppError('المنتج غير موجود', 404);

    if (req.user?.role !== 'ADMIN' && product.store.sellerId !== seller?.id) {
      throw new AppError('لا تملك صلاحية عرض هذا المخزون', 403);
    }

    const codes = await prisma.digitalProductCode.findMany({
      where: { productId },
      select: {
        id: true,
        codeMasked: true,
        isUsed: true,
        usedAt: true,
        createdAt: true,
      },
      orderBy: { createdAt: 'desc' },
      take: 100,
    });

    const totalCount = await prisma.digitalProductCode.count({ where: { productId } });
    const unusedCount = await prisma.digitalProductCode.count({ where: { productId, isUsed: false } });

    ResponseUtil.success(res, {
      productId,
      totalCount,
      availableCount: unusedCount,
      usedCount: totalCount - unusedCount,
      codes,
    });
  } catch (error) {
    next(error);
  }
});

// POST /api/v1/products/:id/report
router.post('/:id/report', optionalAuth, async (req: Request, res: Response, next: NextFunction) => {
  try {
    const id = String(req.params.id);
    const { reason, description } = req.body;

    if (!reason) {
      throw new AppError('سبب البلاغ مطلوب', 400);
    }

    const product = await prisma.product.findUnique({ where: { id } });
    if (!product) {
      throw new AppError('المنتج غير موجود', 404);
    }

    const report = await prisma.productReport.create({
      data: {
        productId: id,
        userId: req.user?.userId || null,
        reason: String(reason),
        description: description ? String(description) : null,
      },
    });

    ResponseUtil.created(res, report, 'تم استلام البلاغ وسيقوم فريق الرقابة بمراجعته والتحقق منه');
  } catch (error) {
    next(error);
  }
});

export const productRoutes = router;
