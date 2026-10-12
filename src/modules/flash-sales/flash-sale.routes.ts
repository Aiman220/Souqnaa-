import { Router, Request, Response, NextFunction } from 'express';
import { prisma } from '../../database/prisma';
import { authenticate, optionalAuth } from '../../middleware/auth.middleware';
import { ResponseUtil } from '../../utils/response.util';
import { AppError } from '../../middleware/error.middleware';
import { flashSaleService } from './flash-sale.service';
import { FlashSaleStatus, FlashSaleItemStatus, FlashSaleReservationStatus } from '@prisma/client';
import rateLimit from 'express-rate-limit';

const router = Router();

// Anti-bot & high-traffic rate limiter for reservations
const reservationLimiter = rateLimit({
  windowMs: 15 * 1000, // 15 seconds
  max: 10, // max 10 reservation attempts per 15s
  message: {
    success: false,
    message: 'Too many reservation requests. Please slow down.',
    errorCode: 'FLASH_SALE_RATE_LIMITED',
  },
  standardHeaders: true,
  legacyHeaders: false,
});

// GET /api/v1/flash-sales — List all public campaigns
router.get('/', optionalAuth, async (req: Request, res: Response, next: NextFunction) => {
  try {
    const campaigns = await prisma.flashSaleCampaign.findMany({
      where: {
        status: { in: [FlashSaleStatus.ACTIVE, FlashSaleStatus.SCHEDULED] },
      },
      orderBy: [{ priority: 'desc' }, { startAt: 'asc' }],
      include: {
        items: {
          where: { status: { in: [FlashSaleItemStatus.ACTIVE, FlashSaleItemStatus.SOLD_OUT] } },
          take: 8,
          include: {
            product: {
              include: {
                images: { where: { isPrimary: true } },
                store: { select: { id: true, name: true, logo: true } },
              },
            },
          },
        },
      },
    });

    ResponseUtil.success(res, {
      serverTime: new Date().toISOString(),
      campaigns,
    });
  } catch (error) {
    next(error);
  }
});

// GET /api/v1/flash-sales/active — Currently live campaigns
router.get('/active', optionalAuth, async (req: Request, res: Response, next: NextFunction) => {
  try {
    const now = new Date();
    const campaigns = await prisma.flashSaleCampaign.findMany({
      where: {
        status: FlashSaleStatus.ACTIVE,
        startAt: { lte: now },
        endAt: { gt: now },
      },
      orderBy: [{ priority: 'desc' }, { displayOrder: 'asc' }],
      include: {
        items: {
          where: { status: { in: [FlashSaleItemStatus.ACTIVE, FlashSaleItemStatus.SOLD_OUT] } },
          include: {
            product: {
              include: {
                images: { where: { isPrimary: true } },
                store: { select: { id: true, name: true, logo: true } },
                inventory: { select: { quantity: true } },
              },
            },
          },
        },
      },
    });

    ResponseUtil.success(res, {
      serverTime: now.toISOString(),
      campaigns,
    });
  } catch (error) {
    next(error);
  }
});

// GET /api/v1/flash-sales/upcoming — Scheduled campaigns starting soon
router.get('/upcoming', optionalAuth, async (req: Request, res: Response, next: NextFunction) => {
  try {
    const now = new Date();
    const campaigns = await prisma.flashSaleCampaign.findMany({
      where: {
        status: { in: [FlashSaleStatus.SCHEDULED, FlashSaleStatus.ACTIVE] },
        startAt: { gt: now },
      },
      orderBy: { startAt: 'asc' },
      include: {
        items: {
          take: 6,
          include: {
            product: {
              include: {
                images: { where: { isPrimary: true } },
                store: { select: { id: true, name: true, logo: true } },
              },
            },
          },
        },
      },
    });

    ResponseUtil.success(res, {
      serverTime: now.toISOString(),
      campaigns,
    });
  } catch (error) {
    next(error);
  }
});

// GET /api/v1/flash-sales/:id — Single campaign details
router.get('/:id', optionalAuth, async (req: Request, res: Response, next: NextFunction) => {
  try {
    const id = String(req.params.id);
    const campaign = await prisma.flashSaleCampaign.findUnique({
      where: { id },
      include: {
        items: {
          where: { status: { in: [FlashSaleItemStatus.ACTIVE, FlashSaleItemStatus.SOLD_OUT] } },
          include: {
            product: {
              include: {
                images: true,
                store: { select: { id: true, name: true, logo: true, rating: true } },
              },
            },
            variant: true,
          },
        },
      },
    });

    if (!campaign) {
      throw new AppError('Campaign not found', 404, 'FLASH_SALE_NOT_FOUND');
    }

    ResponseUtil.success(res, {
      serverTime: new Date().toISOString(),
      campaign,
    });
  } catch (error) {
    next(error);
  }
});

// GET /api/v1/flash-sales/:id/items — Items in campaign
router.get('/:id/items', optionalAuth, async (req: Request, res: Response, next: NextFunction) => {
  try {
    const campaignId = String(req.params.id);
    const items = await prisma.flashSaleItem.findMany({
      where: {
        campaignId,
        status: { in: [FlashSaleItemStatus.ACTIVE, FlashSaleItemStatus.SOLD_OUT] },
      },
      include: {
        product: {
          include: {
            images: true,
            store: { select: { id: true, name: true, logo: true } },
          },
        },
        variant: true,
      },
      orderBy: { soldStock: 'desc' },
    });

    ResponseUtil.success(res, {
      serverTime: new Date().toISOString(),
      items,
    });
  } catch (error) {
    next(error);
  }
});

// POST /api/v1/flash-sales/items/:itemId/reserve — Atomic stock reservation
router.post(
  '/items/:itemId/reserve',
  authenticate,
  reservationLimiter,
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const itemId = String(req.params.itemId);
      const { quantity = 1, idempotencyKey, cartId } = req.body;

      const reservation = await flashSaleService.reserveStock({
        flashSaleItemId: itemId,
        customerId: req.user!.userId,
        quantity: parseInt(String(quantity), 10),
        idempotencyKey: idempotencyKey ? String(idempotencyKey) : undefined,
        cartId: cartId ? String(cartId) : undefined,
      });

      ResponseUtil.success(res, reservation, 'Stock reserved successfully');
    } catch (error) {
      next(error);
    }
  }
);

// POST /api/v1/flash-sales/reservations/:id/release — Release stock reservation
router.post(
  '/reservations/:id/release',
  authenticate,
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const reservationId = String(req.params.id);
      const released = await flashSaleService.releaseReservation(
        reservationId,
        req.user!.userId,
        'MANUAL_RELEASE'
      );

      ResponseUtil.success(res, released, 'Reservation released');
    } catch (error) {
      next(error);
    }
  }
);

// GET /api/v1/flash-sales/reservations/:id — Get single reservation status
router.get(
  '/reservations/:id',
  authenticate,
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const id = String(req.params.id);
      const reservation = await prisma.flashSaleReservation.findUnique({
        where: { id },
        include: {
          flashSaleItem: {
            include: {
              product: { select: { id: true, nameAr: true, nameEn: true } },
            },
          },
        },
      });

      if (!reservation) {
        throw new AppError('Reservation not found', 404, 'FLASH_SALE_RESERVATION_NOT_FOUND');
      }

      if (reservation.customerId !== req.user!.userId) {
        throw new AppError('Access denied', 403, 'FLASH_SALE_PERMISSION_DENIED');
      }

      const isExpired =
        reservation.status === FlashSaleReservationStatus.RESERVED &&
        reservation.expiresAt < new Date();

      ResponseUtil.success(res, {
        ...reservation,
        isExpired,
        serverTime: new Date().toISOString(),
      });
    } catch (error) {
      next(error);
    }
  }
);

// POST /api/v1/flash-sales/:itemId/validate — Authoritative validation check
router.post(
  '/:itemId/validate',
  optionalAuth,
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const itemId = String(req.params.itemId);
      const { quantity = 1 } = req.body;
      const qty = parseInt(String(quantity), 10);

      const item = await prisma.flashSaleItem.findUnique({
        where: { id: itemId },
        include: { campaign: true },
      });

      if (!item) {
        throw new AppError('Flash sale item not found', 404, 'FLASH_SALE_ITEM_NOT_FOUND');
      }

      const now = new Date();
      const isCampaignActive =
        item.campaign.status === FlashSaleStatus.ACTIVE &&
        now >= item.campaign.startAt &&
        now <= item.campaign.endAt;

      const remaining = item.allocatedStock - item.reservedStock - item.soldStock;
      const isAvailable = isCampaignActive && remaining >= qty && item.status === FlashSaleItemStatus.ACTIVE;

      ResponseUtil.success(res, {
        itemId: item.id,
        productId: item.productId,
        isCampaignActive,
        isAvailable,
        remainingStock: Math.max(0, remaining),
        allocatedStock: item.allocatedStock,
        originalPrice: item.originalPrice,
        flashSalePrice: item.flashSalePrice,
        perCustomerLimit: item.perCustomerLimit,
        campaignEndsAt: item.campaign.endAt,
        serverTime: now.toISOString(),
      });
    } catch (error) {
      next(error);
    }
  }
);

export const customerFlashSaleRoutes = router;
