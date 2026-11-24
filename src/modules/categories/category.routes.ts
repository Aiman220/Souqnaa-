import { Router, Request, Response, NextFunction } from 'express';
import { prisma } from '../../database/prisma';
import { authenticate } from '../../middleware/auth.middleware';
import { requireAdmin } from '../../middleware/rbac.middleware';
import { storefrontLimiter } from '../../middleware/rate-limiter.middleware';
import { ResponseUtil } from '../../utils/response.util';
import { AppError } from '../../middleware/error.middleware';
import { invalidateHomeFeedCache } from '../home/home.routes';
import { SocketService } from '../../services/websocket/socket.service';

export async function broadcastCategoryUpdate(): Promise<void> {
  try {
    await invalidateHomeFeedCache();
    SocketService.get()?.emitGlobal('categories:updated', { timestamp: new Date().toISOString() });
    SocketService.get()?.emitGlobal('catalog:updated', { type: 'CATEGORY', timestamp: new Date().toISOString() });
  } catch (err) {
    console.warn('[Categories] Error broadcasting category update:', err);
  }
}

const router = Router();

router.get('/', storefrontLimiter, async (req: Request, res: Response, next: NextFunction) => {
  try {
    const rootOnly = req.query.rootOnly === 'true';
    const categories = await prisma.category.findMany({
      where: {
        isActive: true,
        ...(rootOnly ? { parentId: null } : {}),
      },
      include: {
        children: { where: { isActive: true } },
      },
      orderBy: { sortOrder: 'asc' },
    });
    ResponseUtil.success(res, categories);
  } catch (error) {
    next(error);
  }
});

router.get('/brands/all', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const brands = await prisma.brand.findMany({
      orderBy: { nameAr: 'asc' },
    });
    ResponseUtil.success(res, brands);
  } catch (error) {
    next(error);
  }
});

// Admin Review & Moderation of Seller-Submitted "Other" Product Types
router.get('/admin/other-submissions', authenticate, requireAdmin, async (req: Request, res: Response, next: NextFunction) => {
  try {
    const products = await prisma.product.findMany({
      where: {
        otherProductType: { not: null },
      },
      select: {
        id: true,
        nameAr: true,
        nameEn: true,
        otherProductType: true,
        categoryId: true,
        category: {
          select: {
            id: true,
            nameAr: true,
            nameEn: true,
            slug: true,
            parentId: true,
            parent: {
              select: {
                id: true,
                nameAr: true,
                nameEn: true,
                slug: true,
              },
            },
          },
        },
        store: {
          select: {
            id: true,
            name: true,
          },
        },
        createdAt: true,
      },
      orderBy: { createdAt: 'desc' },
    });

    // Group submissions by trimmed otherProductType and parent category for easy promotion
    const groupedMap = new Map<string, { otherProductType: string; category: any; count: number; products: any[] }>();
    for (const p of products) {
      const typeKey = (p.otherProductType || '').trim().toLowerCase();
      const parentId = p.category?.parentId || p.categoryId;
      const groupKey = `${parentId}::${typeKey}`;

      if (!groupedMap.has(groupKey)) {
        groupedMap.set(groupKey, {
          otherProductType: p.otherProductType || '',
          category: p.category?.parent || p.category,
          count: 0,
          products: [],
        });
      }
      const entry = groupedMap.get(groupKey)!;
      entry.count++;
      if (entry.products.length < 5) {
        entry.products.push({ id: p.id, nameAr: p.nameAr, nameEn: p.nameEn, storeName: p.store?.name });
      }
    }

    ResponseUtil.success(res, {
      totalSubmissions: products.length,
      groupedSubmissions: Array.from(groupedMap.values()),
      submissions: products,
    });
  } catch (error) {
    next(error);
  }
});

// Admin promote an "Other" entry into an official subcategory and migrate products
router.post('/admin/promote-other', authenticate, requireAdmin, async (req: Request, res: Response, next: NextFunction) => {
  try {
    const { parentId, otherProductType, nameAr, nameEn, slug, icon } = req.body;
    if (!parentId || !otherProductType || !nameAr || !nameEn) {
      throw new AppError('يرجى تقديم جميع البيانات المطلوبة لترقية نوع المنتج', 400);
    }

    const parent = await prisma.category.findUnique({ where: { id: parentId } });
    if (!parent) throw new AppError('القسم الرئيسي غير موجود', 404);

    const generatedSlug = slug || nameEn.toLowerCase().replace(/[\s\W-]+/g, '-');
    const existingSlug = await prisma.category.findUnique({ where: { slug: generatedSlug } });
    if (existingSlug) throw new AppError('الرابط الفريد (Slug) مستخدم بالفعل', 400);

    const result = await prisma.$transaction(async (tx) => {
      // 1. Create official subcategory
      const newSubcategory = await tx.category.create({
        data: {
          nameAr,
          nameEn,
          slug: generatedSlug,
          icon: icon || 'category_rounded',
          parentId,
          sortOrder: 50,
          isActive: true,
        },
      });

      // 2. Reassign products matching this otherProductType under this parent
      const updateResult = await tx.product.updateMany({
        where: {
          otherProductType: {
            equals: String(otherProductType).trim(),
            mode: 'insensitive',
          },
          OR: [
            { categoryId: parentId },
            { category: { parentId } },
          ],
        },
        data: {
          categoryId: newSubcategory.id,
        },
      });

      return { newSubcategory, migratedProductsCount: updateResult.count };
    });

    await broadcastCategoryUpdate();
    ResponseUtil.created(res, result, 'تم ترقية نوع المنتج إلى قسم فرعي رسمي بنجاح وتحديث المنتجات المرتبطة');
  } catch (error) {
    next(error);
  }
});

// Admin reclassify products with a specific "Other" type to an existing category
router.post('/admin/reclassify-other', authenticate, requireAdmin, async (req: Request, res: Response, next: NextFunction) => {
  try {
    const { targetCategoryId, otherProductType, parentId } = req.body;
    if (!targetCategoryId || !otherProductType) {
      throw new AppError('يرجى تحديد التصنيف المستهدف ونوع المنتج', 400);
    }

    const target = await prisma.category.findUnique({ where: { id: targetCategoryId } });
    if (!target) throw new AppError('التصنيف المستهدف غير موجود', 404);

    const updateResult = await prisma.product.updateMany({
      where: {
        otherProductType: {
          equals: String(otherProductType).trim(),
          mode: 'insensitive',
        },
        ...(parentId ? { OR: [{ categoryId: parentId }, { category: { parentId } }] } : {}),
      },
      data: {
        categoryId: target.id,
      },
    });

    await broadcastCategoryUpdate();
    ResponseUtil.success(res, { migratedProductsCount: updateResult.count }, 'تم إعادة تصنيف المنتجات بنجاح');
  } catch (error) {
    next(error);
  }
});

router.get('/:id', storefrontLimiter, async (req: Request, res: Response, next: NextFunction) => {
  try {
    const id = String(req.params.id);
    const category = await prisma.category.findFirst({
      where: {
        OR: [{ id }, { slug: id }],
        isActive: true,
      },
      include: {
        children: { where: { isActive: true } },
        parent: true,
      },
    });
    if (!category) throw new AppError('Category not found', 404);
    ResponseUtil.success(res, category);
  } catch (error) {
    next(error);
  }
});

router.post('/', authenticate, requireAdmin, async (req: Request, res: Response, next: NextFunction) => {
  try {
    const { nameAr, nameEn, slug, icon, image, parentId, sortOrder } = req.body;
    const category = await prisma.category.create({
      data: {
        nameAr,
        nameEn,
        slug: slug || nameEn.toLowerCase().replace(/[\s\W-]+/g, '-'),
        icon,
        image,
        parentId,
        sortOrder: sortOrder || 0,
      },
    });
    await broadcastCategoryUpdate();
    ResponseUtil.created(res, category, 'Category created');
  } catch (error) {
    next(error);
  }
});

router.put('/:id', authenticate, requireAdmin, async (req: Request, res: Response, next: NextFunction) => {
  try {
    const id = String(req.params.id);
    const category = await prisma.category.update({
      where: { id },
      data: req.body,
    });
    await broadcastCategoryUpdate();
    ResponseUtil.success(res, category, 'Category updated');
  } catch (error) {
    next(error);
  }
});

router.delete('/:id', authenticate, requireAdmin, async (req: Request, res: Response, next: NextFunction) => {
  try {
    const id = String(req.params.id);
    await prisma.category.delete({ where: { id } });
    await broadcastCategoryUpdate();
    ResponseUtil.success(res, null, 'Category deleted');
  } catch (error) {
    next(error);
  }
});

export const categoryRoutes = router;
