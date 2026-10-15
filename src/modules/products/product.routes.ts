import { Router, Request, Response, NextFunction } from 'express';
import { prisma } from '../../database/prisma';
import { authenticate, optionalAuth } from '../../middleware/auth.middleware';
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

const router = Router();

// GET /api/v1/products — Search & Filtering
router.get('/', optionalAuth, async (req: Request, res: Response, next: NextFunction) => {
  try {
    const page = parseInt(String(req.query.page || '1'), 10);
    const limit = parseInt(String(req.query.limit || '20'), 10);
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
    } = req.query;

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
    if (storeId) where.storeId = String(storeId);
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

    const [total, products] = await Promise.all([
      prisma.product.count({ where }),
      prisma.product.findMany({
        where,
        skip,
        take: limit,
        orderBy: { [String(sortBy)]: String(sortOrder) },
        include: {
          store: { select: { id: true, name: true, logo: true, isVerified: true } },
          category: { select: { id: true, nameAr: true, nameEn: true, slug: true } },
          images: { orderBy: { sortOrder: 'asc' } },
          variants: true,
          inventory: { select: { quantity: true } },
        },
      }),
    ]);

    const locale = req.headers['accept-language']?.includes('en') ? 'en' : 'ar';
    const formatted = await formatProductsWithCampaigns(products, locale);
    ResponseUtil.paginated(res, formatted, total, page, limit);
  } catch (error) {
    next(error);
  }
});

// GET /api/v1/products/featured
router.get('/featured', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const products = await prisma.product.findMany({
      where: { isActive: true, isFeatured: true },
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
    const products = await prisma.product.findMany({
      where: { isActive: true },
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

    const suggestions = await prisma.product.findMany({
      where: {
        isActive: true,
        OR: [
          { nameAr: { contains: String(q), mode: 'insensitive' } },
          { nameEn: { contains: String(q), mode: 'insensitive' } },
        ],
      },
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
router.get('/:id', async (req: Request, res: Response, next: NextFunction) => {
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
    const locale = req.headers['accept-language']?.includes('en') ? 'en' : 'ar';
    const formatted = await formatProductWithCampaign(product, locale);
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

    const storeId = req.body.storeId || seller.stores[0].id;

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
    } = req.body;

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
            create: variants.map((v: any) => ({
              nameAr: v.nameAr,
              nameEn: v.nameEn,
              price: parseFloat(v.price),
              compareAtPrice: v.compareAtPrice ? parseFloat(v.compareAtPrice) : null,
              stockQuantity: parseInt(v.stockQuantity || '0', 10),
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

    catalogVisualIndexService.indexProduct(product.id).catch(err => {
      console.warn('[VisualIndex] Background product reindex error:', err);
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
    const { price, compareAtPrice, stockQuantity, ...data } = req.body;

    const updated = await prisma.product.update({
      where: { id },
      data: {
        ...data,
        ...(price ? { price: parseFloat(price) } : {}),
        ...(compareAtPrice ? { compareAtPrice: parseFloat(compareAtPrice) } : {}),
      },
    });

    if (stockQuantity !== undefined) {
      await prisma.inventory.upsert({
        where: { productId: id },
        update: { quantity: parseInt(String(stockQuantity), 10) },
        create: { productId: id, quantity: parseInt(String(stockQuantity), 10) },
      });
      WishlistAlertsJob.onProductStockRestocked(id).catch(() => {});
    }

    if (price !== undefined) {
      WishlistAlertsJob.onProductPriceUpdated(id).catch(() => {});
    }

    catalogVisualIndexService.indexProduct(id).catch(err => {
      console.warn('[VisualIndex] Background product reindex error:', err);
    });

    ResponseUtil.success(res, updated, 'Product updated successfully');
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
