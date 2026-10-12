import { Router, Request, Response, NextFunction } from 'express';
import { prisma } from '../../database/prisma';
import { authenticate } from '../../middleware/auth.middleware';
import { requireAdmin } from '../../middleware/rbac.middleware';
import { ResponseUtil } from '../../utils/response.util';
import { AppError } from '../../middleware/error.middleware';

const router = Router();

router.get('/', async (req: Request, res: Response, next: NextFunction) => {
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

router.get('/:id', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const id = String(req.params.id);
    const category = await prisma.category.findUnique({
      where: { id },
      include: {
        children: true,
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
    ResponseUtil.success(res, category, 'Category updated');
  } catch (error) {
    next(error);
  }
});

router.delete('/:id', authenticate, requireAdmin, async (req: Request, res: Response, next: NextFunction) => {
  try {
    const id = String(req.params.id);
    await prisma.category.delete({ where: { id } });
    ResponseUtil.success(res, null, 'Category deleted');
  } catch (error) {
    next(error);
  }
});

export const categoryRoutes = router;
