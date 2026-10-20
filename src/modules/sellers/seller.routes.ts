import { Router, Request, Response, NextFunction } from 'express';
import { prisma } from '../../database/prisma';
import { redis } from '../../database/redis';
import { authenticate } from '../../middleware/auth.middleware';
import { requireSeller } from '../../middleware/rbac.middleware';
import { ResponseUtil } from '../../utils/response.util';
import { AppError } from '../../middleware/error.middleware';
import {
  OrderStatus,
  SellerOrderStatus,
  TransactionType,
  CancellationRequestStatus,
  ReturnRequestStatus,
  RefundStatus,
  WithdrawalStatus,
  PaymentStatus,
  PaymentMethodType,
  SellerStatus,
  RefundDestination,
} from '@prisma/client';
import { SocketService } from '../../services/websocket/socket.service';
import { OrderStateMachine } from '../orders/order.state-machine';
import { WalletProviderRegistry } from '../payments/adapters/wallet-provider.adapter';
import { OrderInvoiceService } from '../../services/orders/order-invoice.service';
import { SellerOrderPrintService, PrintDocumentType, PrintFormat } from '../../services/orders/seller-order-print.service';
import { remoteConfigService } from '../remote-config/remote-config.service';
import { AnalyticsCacheService } from '../analytics/services/analytics-cache.service';
import { SellerFinancialRiskService } from '../commission/seller-financial-risk.service';
import { RefundService } from '../refunds/services/refund.service';

const router = Router();
router.use(authenticate, requireSeller);

// Helper to get or assert seller (auto-provisions if user is authenticated SELLER)
async function getSeller(userId: string) {
  let seller = await prisma.seller.findUnique({
    where: { userId },
    include: {
      stores: {
        include: {
          addresses: true,
        },
      },
      balance: true,
      user: { select: { id: true, email: true, phone: true, firstName: true, lastName: true, avatar: true } },
    },
  });

  if (!seller) {
    const user = await prisma.user.findUnique({ where: { id: userId } });
    if (!user) throw new AppError('المستخدم غير موجود', 404);

    const storeName = `${user.firstName} ${user.lastName}`.trim() || 'متجري';
    const storeSlug = `store-${userId.slice(0, 6)}-${Date.now().toString(36)}`;

    seller = await prisma.$transaction(async (tx) => {
      const createdSeller = await tx.seller.create({
        data: {
          userId: user.id,
          status: 'ACTIVE',
          commissionRate: 0.10,
        },
      });

      await tx.store.create({
        data: {
          sellerId: createdSeller.id,
          name: storeName,
          slug: storeSlug,
          isActive: true,
          isVerified: true,
        },
      });

      await tx.sellerBalance.create({
        data: {
          sellerId: createdSeller.id,
          availableBalance: 0.0,
          pendingBalance: 0.0,
          withdrawnBalance: 0.0,
        },
      });

      return await tx.seller.findUnique({
        where: { id: createdSeller.id },
        include: {
          stores: {
            include: {
              addresses: true,
            },
          },
          balance: true,
          user: { select: { id: true, email: true, phone: true, firstName: true, lastName: true, avatar: true } },
        },
      });
    });
  }

  // Ensure balance exists
  if (seller && !seller.balance) {
    const bal = await prisma.sellerBalance.create({
      data: {
        sellerId: seller.id,
        availableBalance: 0.0,
        pendingBalance: 0.0,
        withdrawnBalance: 0.0,
      },
    });
    seller.balance = bal;
  }

  // Ensure at least one store exists
  if (seller && seller.stores.length === 0) {
    const storeName = `${seller.user.firstName} ${seller.user.lastName}`.trim() || 'متجري';
    const store = await prisma.store.create({
      data: {
        sellerId: seller.id,
        name: storeName,
        slug: `store-${seller.id.slice(0, 6)}-${Date.now().toString(36)}`,
        isActive: true,
        isVerified: true,
      },
      include: { addresses: true },
    });
    seller.stores.push(store);
  }

  return seller!;
}

// ── 1. Profile & Verification ──────────────────────────────────────────────────
router.get('/me', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const seller = await getSeller(req.user!.userId);
    ResponseUtil.success(res, seller);
  } catch (error) {
    next(error);
  }
});

router.get('/user/:userId', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const targetUserId = String(req.params.userId);
    if (req.user!.userId !== targetUserId && req.user!.role !== 'ADMIN') {
      throw new AppError('Forbidden: Access denied to other seller resources', 403, 'FORBIDDEN');
    }
    const seller = await getSeller(targetUserId);
    ResponseUtil.success(res, seller);
  } catch (error) {
    next(error);
  }
});

router.patch('/me', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const {
      businessType,
      crNumber,
      taxNumber,
      idNumber,
      idFrontUrl,
      idBackUrl,
      idSelfieUrl,
      businessDocUrl,
    } = req.body;
    const seller = await getSeller(req.user!.userId);

    const updated = await (prisma.seller as any).update({
      where: { id: seller.id },
      data: {
        ...(businessType !== undefined ? { businessType } : {}),
        ...(crNumber !== undefined ? { crNumber } : {}),
        ...(taxNumber !== undefined ? { taxNumber } : {}),
        ...(idNumber !== undefined ? { idNumber } : {}),
        ...(idFrontUrl !== undefined ? { idFrontUrl } : {}),
        ...(idBackUrl !== undefined ? { idBackUrl } : {}),
        ...(idSelfieUrl !== undefined ? { idSelfieUrl } : {}),
        ...(businessDocUrl !== undefined ? { businessDocUrl } : {}),
      },
    });

    ResponseUtil.success(res, updated, 'تم تحديث بيانات البائع بنجاح');
  } catch (error) {
    next(error);
  }
});

router.get('/verification', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const seller = await getSeller(req.user!.userId);
    ResponseUtil.success(res, {
      status: seller.status,
      crNumber: seller.crNumber,
      taxNumber: seller.taxNumber,
      businessType: seller.businessType,
      idNumber: (seller as any).idNumber,
      idFrontUrl: (seller as any).idFrontUrl,
      idBackUrl: (seller as any).idBackUrl,
      idSelfieUrl: (seller as any).idSelfieUrl,
      businessDocUrl: (seller as any).businessDocUrl,
      isOnboarded: (seller as any).isOnboarded ?? false,
      verificationNotes: (seller as any).verificationNotes,
      rejectionReason: (seller as any).rejectionReason,
      verifiedAt: seller.verifiedAt,
    });
  } catch (error) {
    next(error);
  }
});

router.patch('/verification', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const seller = await getSeller(req.user!.userId);
    const {
      businessType,
      crNumber,
      taxNumber,
      idNumber,
      idFrontUrl,
      idBackUrl,
      idSelfieUrl,
      businessDocUrl,
    } = req.body;

    const updated = await (prisma.seller as any).update({
      where: { id: seller.id },
      data: {
        ...(businessType !== undefined ? { businessType } : {}),
        ...(crNumber !== undefined ? { crNumber } : {}),
        ...(taxNumber !== undefined ? { taxNumber } : {}),
        ...(idNumber !== undefined ? { idNumber } : {}),
        ...(idFrontUrl !== undefined ? { idFrontUrl } : {}),
        ...(idBackUrl !== undefined ? { idBackUrl } : {}),
        ...(idSelfieUrl !== undefined ? { idSelfieUrl } : {}),
        ...(businessDocUrl !== undefined ? { businessDocUrl } : {}),
        status: SellerStatus.PENDING_VERIFICATION,
        rejectionReason: null,
      },
    });

    SocketService.get()?.emitGlobal('admin:seller_registered', { sellerId: seller.id });
    SocketService.get()?.emitGlobal('seller:verification_submitted', { sellerId: seller.id });
    SocketService.get()?.emitGlobal('admin:seller_updated', { sellerId: seller.id, status: SellerStatus.PENDING_VERIFICATION });

    ResponseUtil.success(res, updated, 'تم إرسال مستندات التوثيق بنجاح للمراجعة والتدقيق');
  } catch (error) {
    next(error);
  }
});

// GET /api/v1/sellers/me/onboarding-status
router.get('/me/onboarding-status', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const seller = await getSeller(req.user!.userId);
    const store = seller.stores.length > 0 ? seller.stores[0] : null;
    let address = null;
    if (store) {
      address = await prisma.address.findFirst({
        where: { storeId: store.id },
        include: { city: true, district: true },
      });
    }

    ResponseUtil.success(res, {
      isOnboarded: (seller as any).isOnboarded ?? false,
      status: seller.status,
      hasStore: !!store,
      store,
      address,
      verification: {
        crNumber: seller.crNumber,
        taxNumber: seller.taxNumber,
        businessType: seller.businessType,
        idNumber: (seller as any).idNumber,
        idFrontUrl: (seller as any).idFrontUrl,
        idBackUrl: (seller as any).idBackUrl,
        idSelfieUrl: (seller as any).idSelfieUrl,
        businessDocUrl: (seller as any).businessDocUrl,
        rejectionReason: (seller as any).rejectionReason,
        verificationNotes: (seller as any).verificationNotes,
      },
    });
  } catch (error) {
    next(error);
  }
});

// POST /api/v1/sellers/me/onboarding
// Step 1: Store & Address Setup
// Step 2: Business & Identity Registration
router.post('/me/onboarding', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const seller = await getSeller(req.user!.userId);
    const {
      // Step 1: Store details & address
      storeName,
      storeDescription,
      storeLogo,
      city,
      district,
      street,
      buildingNumber,
      latitude,
      longitude,

      // Step 2: Business & Identity
      businessType,
      crNumber,
      taxNumber,
      idNumber,
      idFrontUrl,
      idBackUrl,
      idSelfieUrl,
      businessDocUrl,
    } = req.body;

    // 1. Create or update store
    let store: any = seller.stores.length > 0 ? seller.stores[0] : null;
    if (store) {
      store = await prisma.store.update({
        where: { id: store.id },
        data: {
          ...(storeName ? { name: storeName } : {}),
          ...(storeDescription !== undefined ? { description: storeDescription } : {}),
          ...(storeLogo ? { logo: storeLogo } : {}),
          ...(latitude !== undefined ? { latitude: Number(latitude) } : {}),
          ...(longitude !== undefined ? { longitude: Number(longitude) } : {}),
          ...(latitude !== undefined || longitude !== undefined ? { locationUpdatedAt: new Date() } : {}),
        },
      });
    } else if (storeName) {
      const slug = String(storeName).toLowerCase().replace(/[\s\W-]+/g, '-') + '-' + Date.now().toString().slice(-4);
      store = await prisma.store.create({
        data: {
          sellerId: seller.id,
          name: storeName,
          slug,
          description: storeDescription || null,
          logo: storeLogo || null,
          latitude: latitude !== undefined ? Number(latitude) : 15.3694,
          longitude: longitude !== undefined ? Number(longitude) : 44.1910,
          locationUpdatedAt: new Date(),
        },
      });
    }

    // 2. Store address
    if (store && (street || city)) {
      const cityRecord = await getOrCreateCity(city);
      const districtRecord = await getOrCreateDistrict(cityRecord.id, district);

      const existingAddress = await prisma.address.findFirst({
        where: { storeId: store.id },
      });

      if (existingAddress) {
        await prisma.address.update({
          where: { id: existingAddress.id },
          data: {
            street: street || existingAddress.street,
            buildingNumber: buildingNumber ?? existingAddress.buildingNumber,
            cityId: cityRecord.id,
            districtId: districtRecord?.id ?? existingAddress.districtId,
            latitude: latitude !== undefined ? Number(latitude) : existingAddress.latitude,
            longitude: longitude !== undefined ? Number(longitude) : existingAddress.longitude,
          },
        });
      } else {
        await prisma.address.create({
          data: {
            storeId: store.id,
            userId: req.user!.userId,
            recipientName: store.name,
            recipientPhone: seller.user.phone || '+967770000000',
            street: street || 'الشارع الرئيسي',
            buildingNumber: buildingNumber || '1',
            cityId: cityRecord.id,
            districtId: districtRecord?.id ?? null,
            latitude: latitude !== undefined ? Number(latitude) : 15.3694,
            longitude: longitude !== undefined ? Number(longitude) : 44.1910,
            isDefault: true,
          },
        });
      }
    }

    // 3. Update Seller business details, documents, and mark onboarded
    const updatedSeller = await (prisma.seller as any).update({
      where: { id: seller.id },
      data: {
        ...(businessType !== undefined ? { businessType } : {}),
        ...(crNumber !== undefined ? { crNumber } : {}),
        ...(taxNumber !== undefined ? { taxNumber } : {}),
        ...(idNumber !== undefined ? { idNumber } : {}),
        ...(idFrontUrl !== undefined ? { idFrontUrl } : {}),
        ...(idBackUrl !== undefined ? { idBackUrl } : {}),
        ...(idSelfieUrl !== undefined ? { idSelfieUrl } : {}),
        ...(businessDocUrl !== undefined ? { businessDocUrl } : {}),
        isOnboarded: true,
        status: SellerStatus.PENDING_VERIFICATION,
        rejectionReason: null,
      },
    });

    SocketService.get()?.emitGlobal('admin:seller_registered', { sellerId: seller.id, storeName: store?.name });
    SocketService.get()?.emitGlobal('seller:verification_submitted', { sellerId: seller.id });
    SocketService.get()?.emitGlobal('admin:store_created', { storeId: store?.id, sellerId: seller.id });
    SocketService.get()?.emitGlobal('admin:seller_updated', { sellerId: seller.id, status: SellerStatus.PENDING_VERIFICATION });

    ResponseUtil.success(res, {
      seller: updatedSeller,
      store,
    }, 'تم حفظ بيانات التسجيل والتوثيق بنجاح');
  } catch (error) {
    next(error);
  }
});

// ── 2. Store Management & Pickup Location ──────────────────────────────────────
router.get('/me/store', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const seller = await getSeller(req.user!.userId);
    const store = seller.stores.length > 0 ? seller.stores[0] : null;
    if (!store) {
      return ResponseUtil.success(res, null, 'لا يوجد متجر مسجل');
    }

    const storeWithDetails = await prisma.store.findUnique({
      where: { id: store.id },
      include: {
        addresses: true,
        enhancement: true,
      },
    });

    if (!storeWithDetails) {
      return ResponseUtil.success(res, null, 'لا يوجد متجر مسجل');
    }

    const effectiveCover = storeWithDetails.cover || storeWithDetails.enhancement?.bannerDesktop || storeWithDetails.enhancement?.bannerMobile || null;
    const effectiveLogo = storeWithDetails.logo || storeWithDetails.enhancement?.logoMedium || storeWithDetails.enhancement?.logoOriginal || null;

    ResponseUtil.success(res, {
      ...storeWithDetails,
      cover: effectiveCover,
      banner: effectiveCover,
      logo: effectiveLogo,
    });
  } catch (error) {
    next(error);
  }
});

router.post('/me/store', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const seller = await getSeller(req.user!.userId);
    const { name, description, logo, cover } = req.body;

    const slug = (name as string).toLowerCase().replace(/[^a-z0-9]+/g, '-') + '-' + Date.now().toString().slice(-4);

    const store = await prisma.store.create({
      data: {
        sellerId: seller.id,
        name,
        slug,
        description,
        logo,
        cover,
      },
    });

    ResponseUtil.created(res, store, 'تم إنشاء المتجر بنجاح');
  } catch (error) {
    next(error);
  }
});

router.patch('/me/store', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const seller = await getSeller(req.user!.userId);
    const store = seller.stores[0];
    if (!store) throw new AppError('لا يوجد متجر لتعديله', 404);

    const {
      name,
      description,
      logo,
      cover,
      isActive,
      isOpen,
      openingTime,
      closingTime,
      acceptsExpress,
      acceptsScheduled,
      busyMode,
      closedReason,
    } = req.body;

    const updated = await prisma.store.update({
      where: { id: store.id },
      data: {
        name: (name !== undefined && typeof name === 'string' && name.trim().length > 0) ? name.trim() : store.name,
        description: description !== undefined ? description : store.description,
        logo: logo !== undefined ? logo : store.logo,
        cover: cover !== undefined ? cover : store.cover,
        isActive: isActive !== undefined ? Boolean(isActive) : store.isActive,
        isOpen: isOpen !== undefined ? Boolean(isOpen) : store.isOpen,
        openingTime: openingTime !== undefined ? openingTime : store.openingTime,
        closingTime: closingTime !== undefined ? closingTime : store.closingTime,
        acceptsExpress: acceptsExpress !== undefined ? Boolean(acceptsExpress) : store.acceptsExpress,
        acceptsScheduled: acceptsScheduled !== undefined ? Boolean(acceptsScheduled) : store.acceptsScheduled,
        busyMode: busyMode !== undefined ? Boolean(busyMode) : store.busyMode,
        closedReason: closedReason !== undefined ? closedReason : store.closedReason,
      },
    });

    // Also synchronize storeEnhancement if cover or logo is provided
    if (cover !== undefined || logo !== undefined) {
      await prisma.storeEnhancement.upsert({
        where: { storeId: store.id },
        update: {
          ...(cover !== undefined && { bannerDesktop: cover, bannerMobile: cover }),
          ...(logo !== undefined && { logoOriginal: logo, logoMedium: logo }),
        },
        create: {
          storeId: store.id,
          ...(cover !== undefined && { bannerDesktop: cover, bannerMobile: cover }),
          ...(logo !== undefined && { logoOriginal: logo, logoMedium: logo }),
        },
      });
    }

    await Promise.all([
      redis.del(`storefront:${store.slug}`),
      redis.del(`storefront:${store.id}`),
    ]);

    ResponseUtil.success(res, {
      ...updated,
      cover: updated.cover,
      banner: updated.cover,
    }, 'تم تحديث بيانات وساعات عمل المتجر بنجاح');
  } catch (error) {
    next(error);
  }
});

async function getOrCreateCity(cityName?: string) {
  let country = await prisma.country.findFirst({
    where: { OR: [{ code: 'YE' }, { code: 'SA' }] },
  });
  if (!country) {
    country = await prisma.country.create({
      data: {
        code: 'YE',
        nameAr: 'اليمن',
        nameEn: 'Yemen',
        currency: 'YER',
        phoneCode: '+967',
        isActive: true,
      },
    });
  }

  const name = cityName?.trim() || 'صنعاء';
  const existing = await prisma.city.findFirst({
    where: {
      OR: [
        { nameAr: { contains: name, mode: 'insensitive' } },
        { nameEn: { contains: name, mode: 'insensitive' } },
      ],
    },
  });
  if (existing) return existing;

  return await prisma.city.create({
    data: {
      countryId: country.id,
      nameAr: name,
      nameEn: name,
      isActive: true,
    },
  });
}

async function getOrCreateDistrict(cityId: string, districtName?: string) {
  const name = districtName?.trim();
  if (!name) return null;

  const existing = await prisma.district.findFirst({
    where: {
      cityId,
      OR: [
        { nameAr: { contains: name, mode: 'insensitive' } },
        { nameEn: { contains: name, mode: 'insensitive' } },
      ],
    },
  });
  if (existing) return existing;

  return await prisma.district.create({
    data: {
      cityId,
      nameAr: name,
      nameEn: name,
      isActive: true,
    },
  });
}

router.patch('/me/store/address', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const seller = await getSeller(req.user!.userId);
    const store = seller.stores[0];
    if (!store) throw new AppError('لا يوجد متجر مسجل', 404);

    const { street, buildingNumber, latitude, longitude, city, district } = req.body;

    const cityRecord = await getOrCreateCity(city);
    const cityId = cityRecord.id;

    const districtRecord = await getOrCreateDistrict(cityId, district);
    const districtId = districtRecord?.id ?? null;

    const existing = await prisma.address.findFirst({
      where: { storeId: store.id },
    });

    let address;
    if (existing) {
      address = await prisma.address.update({
        where: { id: existing.id },
        data: {
          street: street ?? existing.street,
          buildingNumber: buildingNumber ?? existing.buildingNumber,
          cityId: cityId,
          districtId: districtId ?? existing.districtId,
          latitude: latitude !== undefined ? latitude : existing.latitude,
          longitude: longitude !== undefined ? longitude : existing.longitude,
        },
      });
    } else {
      address = await prisma.address.create({
        data: {
          storeId: store.id,
          userId: req.user!.userId,
          recipientName: store.name,
          recipientPhone: seller.user.phone || '+967770000000',
          street: street || 'الشارع الرئيسي',
          buildingNumber: buildingNumber || '1',
          cityId: cityId,
          districtId: districtId,
          latitude: latitude || 15.3694,
          longitude: longitude || 44.1910,
          isDefault: true,
        },
      });
    }

    ResponseUtil.success(res, address, 'تم حفظ موقع المتجر بنجاح');
  } catch (error) {
    next(error);
  }
});

// ── 2b. Store Location (GPS / Map-based) ─────────────────────────────────────
// §9: Seller stores must have a geographic location
// §25: GET /api/v1/seller/store/location, PUT /api/v1/seller/store/location

router.get('/me/store/location', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const seller = await getSeller(req.user!.userId);
    const store = seller.stores[0];
    if (!store) throw new AppError('لا يوجد متجر مسجل', 404);

    const storeData = await prisma.store.findUnique({
      where: { id: store.id },
      select: {
        id: true,
        name: true,
        latitude: true,
        longitude: true,
        locationUpdatedAt: true,
      },
    });

    const address = await prisma.address.findFirst({
      where: { storeId: store.id },
      include: { city: true, district: true },
    });

    ResponseUtil.success(res, {
      storeId: storeData?.id,
      storeName: storeData?.name,
      latitude: storeData?.latitude ?? address?.latitude ?? null,
      longitude: storeData?.longitude ?? address?.longitude ?? null,
      hasLocation: !!((storeData?.latitude && storeData?.longitude) || (address?.latitude && address?.longitude)),
      locationUpdatedAt: storeData?.locationUpdatedAt ?? null,
      city: address?.city?.nameAr || address?.city?.nameEn || 'صنعاء',
      cityId: address?.cityId || '',
      district: address?.district?.nameAr || address?.district?.nameEn || '',
      street: address?.street || '',
      buildingNumber: address?.buildingNumber || '',
      apartmentNumber: address?.apartmentNumber || '',
      floorNumber: address?.floorNumber || '',
      postalCode: address?.postalCode || '',
      recipientName: address?.recipientName || store.name,
      recipientPhone: address?.recipientPhone || seller.user.phone || '',
    });
  } catch (error) {
    next(error);
  }
});

router.put('/me/store/location', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const seller = await getSeller(req.user!.userId);
    const store = seller.stores[0];
    if (!store) throw new AppError('لا يوجد متجر مسجل', 404);

    const {
      latitude,
      longitude,
      city,
      district,
      street,
      buildingNumber,
      apartmentNumber,
      floorNumber,
      postalCode,
      recipientPhone,
      recipientName,
    } = req.body;

    const lat = latitude !== undefined && latitude !== null ? parseFloat(String(latitude)) : null;
    const lng = longitude !== undefined && longitude !== null ? parseFloat(String(longitude)) : null;

    if (lat !== null && lng !== null) {
      if (isNaN(lat) || isNaN(lng) || lat < -90 || lat > 90 || lng < -180 || lng > 180) {
        throw new AppError('إحداثيات غير صحيحة. خط العرض يجب أن يكون بين -90 و90، خط الطول بين -180 و180', 400);
      }
    }

    // Update store coordinates
    const updatedStore = await prisma.store.update({
      where: { id: store.id },
      data: {
        ...(lat !== null && lng !== null ? {
          latitude: lat,
          longitude: lng,
          locationUpdatedAt: new Date(),
        } : {}),
      },
      select: {
        id: true,
        name: true,
        latitude: true,
        longitude: true,
        locationUpdatedAt: true,
      },
    });

    // Ensure valid City and Country record exists
    const cityRecord = await getOrCreateCity(city);
    const targetCityId = cityRecord.id;

    // Ensure valid District record exists
    const districtRecord = await getOrCreateDistrict(targetCityId, district);
    const targetDistrictId = districtRecord?.id ?? null;

    // Upsert store dispatch address
    const existingAddress = await prisma.address.findFirst({ where: { storeId: store.id } });

    let address;
    if (existingAddress) {
      address = await prisma.address.update({
        where: { id: existingAddress.id },
        data: {
          recipientName: recipientName || existingAddress.recipientName || store.name,
          recipientPhone: recipientPhone || existingAddress.recipientPhone || seller.user.phone || '+967770000000',
          street: street !== undefined ? String(street) : existingAddress.street,
          buildingNumber: buildingNumber !== undefined ? String(buildingNumber) : existingAddress.buildingNumber,
          apartmentNumber: apartmentNumber !== undefined ? String(apartmentNumber) : existingAddress.apartmentNumber,
          floorNumber: floorNumber !== undefined ? String(floorNumber) : existingAddress.floorNumber,
          postalCode: postalCode !== undefined ? String(postalCode) : existingAddress.postalCode,
          cityId: targetCityId,
          districtId: targetDistrictId !== null ? targetDistrictId : existingAddress.districtId,
          ...(lat !== null && lng !== null ? { latitude: lat, longitude: lng } : {}),
        },
      });
    } else {
      address = await prisma.address.create({
        data: {
          storeId: store.id,
          userId: req.user!.userId,
          recipientName: recipientName || store.name,
          recipientPhone: recipientPhone || seller.user.phone || '+967770000000',
          street: street || 'الشارع الرئيسي',
          buildingNumber: buildingNumber || null,
          apartmentNumber: apartmentNumber || null,
          floorNumber: floorNumber || null,
          postalCode: postalCode || null,
          cityId: targetCityId,
          districtId: targetDistrictId,
          latitude: lat ?? 15.3694,
          longitude: lng ?? 44.1910,
          isDefault: true,
        },
      });
    }

    ResponseUtil.success(res, {
      ...updatedStore,
      address,
    }, 'تم حفظ وتحديث بيانات عنوان وموقع المتجر بنجاح');
  } catch (error) {
    next(error);
  }
});




// GET /api/v1/sellers/me/location/search — geocoding for seller location picker
router.get('/me/location/search', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const { q, limit = '5' } = req.query;

    if (!q || String(q).trim().length < 2) {
      throw new AppError('يجب أن تكون الكلمة المُبحَث عنها حرفين على الأقل', 400);
    }

    // Import geoService lazily to avoid circular deps
    const { geoService } = await import('../../services/geo/geo.service');

    if (!geoService.isConfigured()) {
      throw new AppError('خدمة البحث غير مُهيأة', 503);
    }

    const results = await geoService.geocoding().geocode(String(q), {
      limit: Math.min(parseInt(String(limit), 10) || 5, 10),
      lang: 'ar',
    });

    res.setHeader('Cache-Control', 'public, max-age=300');
    ResponseUtil.success(res, results);
  } catch (error) {
    next(error);
  }
});

// ── 3. Dashboard Metrics & Analytics ───────────────────────────────────────────

router.get('/dashboard', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const seller = await getSeller(req.user!.userId);

    // Fast-path: Return cached dashboard metrics if fresh (prevents DB overload on multi-device or polling)
    const cacheKey = `seller_dashboard_metrics_${seller.id}`;
    const cached = AnalyticsCacheService.get(cacheKey);
    if (cached) {
      return ResponseUtil.success(res, cached.data);
    }

    const storeIds = seller.stores.map((s) => s.id);

    const paymentReadyCondition = {
      order: {
        OR: [
          { payment: { status: PaymentStatus.PAID } },
          { payment: { method: PaymentMethodType.CASH_ON_DELIVERY } },
          { payment: null },
        ],
      },
    };

    const [totalOrders, pendingOrders, totalProducts, balance] = await Promise.all([
      prisma.sellerOrder.count({ where: { sellerId: seller.id, ...paymentReadyCondition } }),
      prisma.sellerOrder.count({ where: { sellerId: seller.id, status: 'PENDING', ...paymentReadyCondition } }),
      prisma.product.count({ where: { storeId: { in: storeIds } } }),
      prisma.sellerBalance.findUnique({ where: { sellerId: seller.id } }),
    ]);

    const recentOrders = await prisma.sellerOrder.findMany({
      where: { sellerId: seller.id, ...paymentReadyCondition },
      take: 5,
      orderBy: { createdAt: 'desc' },
      include: {
        order: { select: { orderNumber: true, createdAt: true } },
        items: true,
      },
    });

    const earned = (balance?.availableBalance || 0) + (balance?.withdrawnBalance || 0);

    const outstandingCommission = balance?.outstandingCommission || 0;
    const isFinanciallyRestricted = seller.isFinanciallyRestricted || false;
    const financialRestrictionLevel = seller.financialRestrictionLevel || 'NORMAL';
    const amountNeededToUnblock = Math.max(0, outstandingCommission - 4000);

    const payload = {
      revenue: earned,
      availableBalance: balance?.availableBalance || 0,
      pendingBalance: balance?.pendingBalance || 0,
      withdrawnBalance: balance?.withdrawnBalance || 0,
      outstandingCommission,
      isFinanciallyRestricted,
      financialRestrictionLevel,
      financialRestrictionReason: seller.financialRestrictionReason || null,
      amountNeededToUnblock,
      cashOnDeliveryEnabled: seller.cashOnDeliveryEnabled ?? true,
      currency: (balance?.currency && balance.currency !== 'SAR') ? balance.currency : 'YER',
      totalOrders,
      pendingOrders,
      totalProducts,
      recentOrders,
    };

    // Cache metrics for 30s in-memory (real-time enough for sellers, zero DB pressure)
    AnalyticsCacheService.set(cacheKey, payload, 30, 'REAL_TIME');

    ResponseUtil.success(res, payload);
  } catch (error) {
    next(error);
  }
});

router.get('/analytics', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const seller = await getSeller(req.user!.userId);

    const orders = await prisma.sellerOrder.findMany({
      where: { sellerId: seller.id },
      select: {
        createdAt: true,
        sellerPayout: true,
        subtotal: true,
        status: true,
      },
      orderBy: { createdAt: 'asc' },
    });

    ResponseUtil.success(res, {
      salesCount: orders.length,
      orders,
    });
  } catch (error) {
    next(error);
  }
});

// ── 4. Product Management (CRUD & Variants) Based on userId ───────────────────

function formatProductWithStock(product: any) {
  if (!product) return null;
  const variantStock = Array.isArray(product.variants) && product.variants.length > 0
    ? product.variants.reduce((sum: number, v: any) => sum + (v.stockQuantity || 0), 0)
    : 0;
  const stock = product.inventory?.quantity ?? (variantStock > 0 ? variantStock : 0);
  const rawSold = product.soldCount ?? product.sold_count ?? product.unitsSold ?? product.totalSold;
  const soldCount = typeof rawSold === 'number'
    ? rawSold
    : (typeof rawSold === 'string' ? parseInt(rawSold, 10) || 0 : 0);

  return {
    ...product,
    stock,
    soldCount,
    sold_count: soldCount,
  };
}

async function fetchSellerProducts(userId: string) {
  const seller = await getSeller(userId);
  const storeIds = seller.stores.map((s) => s.id);

  const products = await prisma.product.findMany({
    where: { storeId: { in: storeIds } },
    include: {
      images: { orderBy: { sortOrder: 'asc' } },
      variants: true,
      inventory: true,
      category: true,
    },
    orderBy: { createdAt: 'desc' },
  });

  return products.map(formatProductWithStock);
}

async function fetchSellerProductById(userId: string, productId: string) {
  const seller = await getSeller(userId);
  const storeIds = seller.stores.map((s) => s.id);

  const product = await prisma.product.findFirst({
    where: { id: productId, storeId: { in: storeIds } },
    include: {
      images: { orderBy: { sortOrder: 'asc' } },
      variants: true,
      inventory: true,
      category: true,
      brand: true,
    },
  });

  if (!product) throw new AppError('المنتج غير موجود أو لا تملك صلاحية الوصول إليه', 404);
  return formatProductWithStock(product);
}

async function createSellerProduct(userId: string, body: any) {
  const seller = await getSeller(userId);
  const store = seller.stores[0];

  const {
    nameAr,
    nameEn,
    categoryId,
    brandId,
    price,
    compareAtPrice,
    sku,
    descriptionAr,
    descriptionEn,
    weight,
    hasWarranty,
    warrantyPeriod,
    warrantyPolicy,
    videoUrl,
    stock,
    images = [],
    variants = [],
  } = body;

  let targetCategoryId = categoryId;
  if (!targetCategoryId) {
    const existingCat = await prisma.category.findFirst({ where: { isActive: true } });
    if (existingCat) {
      targetCategoryId = existingCat.id;
    } else {
      const defaultCat = await prisma.category.create({
        data: {
          nameAr: 'عام',
          nameEn: 'General',
          slug: `general-${Date.now()}`,
          isActive: true,
        },
      });
      targetCategoryId = defaultCat.id;
    }
  }

  const baseSlug = (nameEn ? nameEn.toLowerCase().replace(/[^a-z0-9]+/g, '-') : 'prod').replace(/^-+|-+$/g, '') || 'prod';
  let finalSlug = `${baseSlug}-${Date.now().toString(36)}-${Math.floor(Math.random() * 1000)}`;
  const existingSlug = await prisma.product.findUnique({ where: { slug: finalSlug } });
  if (existingSlug) {
    finalSlug = `${finalSlug}-${Date.now().toString().slice(-4)}`;
  }

  let finalSku = (sku || '').toString().trim();
  if (finalSku) {
    const existingProdWithSku = await prisma.product.findUnique({ where: { sku: finalSku } });
    if (existingProdWithSku) {
      finalSku = `${finalSku}-${Date.now().toString().slice(-4)}`;
    }
  } else {
    finalSku = `SKU-${Date.now().toString(36).toUpperCase()}-${Math.floor(Math.random() * 1000)}`;
  }

  const parsedVariants = Array.isArray(variants) ? variants : [];
  const totalVariantStock = parsedVariants.reduce((sum: number, v: any) => sum + (parseInt(v.stockQuantity || v.stock || '0', 10) || 0), 0);
  const finalStock = parsedVariants.length > 0 ? totalVariantStock : (stock ? parseInt(stock, 10) : 0);

  const existingVariantSkus = new Set(
    (await prisma.productVariant.findMany({ select: { sku: true } }))
      .map((v) => v.sku)
      .filter(Boolean) as string[]
  );

  return await prisma.$transaction(async (tx) => {
    const created = await tx.product.create({
      data: {
        storeId: store.id,
        categoryId: targetCategoryId,
        brandId: brandId || null,
        nameAr: nameAr || 'منتج جديد',
        nameEn: nameEn || nameAr || 'New Product',
        slug: finalSlug,
        price: parseFloat(price) || 0.0,
        compareAtPrice: compareAtPrice ? parseFloat(compareAtPrice) : null,
        sku: finalSku,
        descriptionAr: descriptionAr || null,
        descriptionEn: descriptionEn || null,
        weight: weight !== undefined && weight !== '' ? parseFloat(weight) : null,
        hasWarranty: Boolean(hasWarranty),
        warrantyPeriod: warrantyPeriod || null,
        warrantyPolicy: warrantyPolicy || null,
        videoUrl: videoUrl || null,
        isActive: true,
      },
    });

    await tx.inventory.create({
      data: {
        productId: created.id,
        quantity: finalStock,
        reserved: 0,
      },
    });

    if (Array.isArray(images) && images.length > 0) {
      await tx.productImage.createMany({
        data: images.map((url: string, index: number) => ({
          productId: created.id,
          url,
          isPrimary: index === 0,
          sortOrder: index,
        })),
      });
    }

    if (parsedVariants.length > 0) {
      const variantPayloads: any[] = [];
      for (let index = 0; index < parsedVariants.length; index++) {
        const v = parsedVariants[index];
        let vSku = (v.sku || '').toString().trim() || `${finalSku}-V${index + 1}`;
        if (existingVariantSkus.has(vSku)) {
          vSku = `${vSku}-${Date.now().toString().slice(-4)}-${index + 1}`;
        }
        existingVariantSkus.add(vSku);

        variantPayloads.push({
          productId: created.id,
          nameAr: v.nameAr || `متغير ${index + 1}`,
          nameEn: v.nameEn || v.nameAr || `Variant ${index + 1}`,
          sku: vSku,
          price: v.price !== undefined && v.price !== '' ? (parseFloat(v.price) || parseFloat(price) || 0.0) : (parseFloat(price) || 0.0),
          compareAtPrice: v.compareAtPrice ? parseFloat(v.compareAtPrice) : null,
          stockQuantity: parseInt(v.stockQuantity || v.stock || '0', 10) || 0,
          image: v.image || null,
        });
      }

      await tx.productVariant.createMany({
        data: variantPayloads,
      });
    }

    return await tx.product.findUnique({
      where: { id: created.id },
      include: {
        images: { orderBy: { sortOrder: 'asc' } },
        variants: true,
        inventory: true,
        category: true,
      },
    });
  });
}

async function updateSellerProduct(userId: string, productId: string, body: any) {
  const seller = await getSeller(userId);
  const storeIds = seller.stores.map((s) => s.id);

  const product = await prisma.product.findFirst({
    where: { id: productId, storeId: { in: storeIds } },
    include: { variants: true, images: true },
  });
  if (!product) throw new AppError('المنتج غير موجود أو لا تملك صلاحية تعديله', 404);

  const {
    nameAr,
    nameEn,
    categoryId,
    brandId,
    sku,
    price,
    compareAtPrice,
    descriptionAr,
    descriptionEn,
    weight,
    hasWarranty,
    warrantyPeriod,
    warrantyPolicy,
    videoUrl,
    isActive,
    stock,
    images,
    variants,
  } = body;

  return await prisma.$transaction(async (tx) => {
    // 1. Update Base Product
    const prod = await tx.product.update({
      where: { id: productId },
      data: {
        nameAr: nameAr ?? product.nameAr,
        nameEn: nameEn ?? product.nameEn,
        categoryId: categoryId !== undefined ? categoryId : product.categoryId,
        brandId: brandId !== undefined ? brandId : product.brandId,
        sku: sku ?? product.sku,
        price: price !== undefined ? parseFloat(price) : product.price,
        compareAtPrice: compareAtPrice !== undefined ? (compareAtPrice ? parseFloat(compareAtPrice) : null) : product.compareAtPrice,
        descriptionAr: descriptionAr !== undefined ? descriptionAr : product.descriptionAr,
        descriptionEn: descriptionEn !== undefined ? descriptionEn : product.descriptionEn,
        weight: weight !== undefined ? (weight ? parseFloat(weight) : null) : product.weight,
        hasWarranty: hasWarranty !== undefined ? Boolean(hasWarranty) : product.hasWarranty,
        warrantyPeriod: warrantyPeriod !== undefined ? (warrantyPeriod || null) : product.warrantyPeriod,
        warrantyPolicy: warrantyPolicy !== undefined ? (warrantyPolicy || null) : product.warrantyPolicy,
        videoUrl: videoUrl !== undefined ? (videoUrl || null) : product.videoUrl,
        isActive: isActive !== undefined ? isActive : product.isActive,
      },
    });

    // 2. Update Images if provided
    if (Array.isArray(images)) {
      await tx.productImage.deleteMany({ where: { productId } });
      if (images.length > 0) {
        await tx.productImage.createMany({
          data: images.map((url: string, index: number) => ({
            productId,
            url,
            isPrimary: index === 0,
            sortOrder: index,
          })),
        });
      }
    }

    // 3. Update Variants if provided
    if (Array.isArray(variants)) {
      await tx.productVariant.deleteMany({ where: { productId } });
      if (variants.length > 0) {
        await tx.productVariant.createMany({
          data: variants.map((v: any, index: number) => ({
            productId,
            nameAr: v.nameAr || `متغير ${index + 1}`,
            nameEn: v.nameEn || v.nameAr || `Variant ${index + 1}`,
            sku: v.sku || `${prod.sku}-V${index + 1}-${Date.now().toString().slice(-4)}`,
            price: v.price !== undefined && v.price !== '' ? parseFloat(v.price) : prod.price,
            compareAtPrice: v.compareAtPrice ? parseFloat(v.compareAtPrice) : null,
            stockQuantity: parseInt(v.stockQuantity || v.stock || '0', 10) || 0,
            image: v.image || null,
          })),
        });
      }
    }

    // 4. Update Inventory
    const totalVarStock = Array.isArray(variants) && variants.length > 0
      ? variants.reduce((sum: number, v: any) => sum + (parseInt(v.stockQuantity || v.stock || '0', 10) || 0), 0)
      : (stock !== undefined ? parseInt(stock, 10) : undefined);

    if (totalVarStock !== undefined) {
      await tx.inventory.upsert({
        where: { productId },
        update: { quantity: totalVarStock },
        create: { productId, quantity: totalVarStock, reserved: 0 },
      });
    }

    return await tx.product.findUnique({
      where: { id: productId },
      include: {
        images: { orderBy: { sortOrder: 'asc' } },
        variants: true,
        inventory: true,
        category: true,
        brand: true,
      },
    });
  });
}

async function deleteSellerProduct(userId: string, productId: string) {
  const seller = await getSeller(userId);
  const storeIds = seller.stores.map((s) => s.id);

  const product = await prisma.product.findFirst({
    where: { id: productId, storeId: { in: storeIds } },
  });
  if (!product) throw new AppError('المنتج غير موجود أو لا تملك صلاحية حذفه', 404);

  await prisma.product.delete({ where: { id: productId } });
}

// ── GET Endpoints ────────────────────────────────────────────────────────────
router.get('/me/products', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const products = await fetchSellerProducts(req.user!.userId);
    ResponseUtil.success(res, products);
  } catch (error) {
    next(error);
  }
});

router.get('/user/:userId/products', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const targetUserId = String(req.params.userId);
    if (req.user!.userId !== targetUserId && req.user!.role !== 'ADMIN') {
      throw new AppError('Forbidden: Access denied to other seller resources', 403, 'FORBIDDEN');
    }
    const products = await fetchSellerProducts(targetUserId);
    ResponseUtil.success(res, products);
  } catch (error) {
    next(error);
  }
});

router.get('/me/products/:id', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const product = await fetchSellerProductById(req.user!.userId, String(req.params.id));
    ResponseUtil.success(res, product);
  } catch (error) {
    next(error);
  }
});

router.get('/user/:userId/products/:id', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const targetUserId = String(req.params.userId);
    if (req.user!.userId !== targetUserId && req.user!.role !== 'ADMIN') {
      throw new AppError('Forbidden: Access denied to other seller resources', 403, 'FORBIDDEN');
    }
    const product = await fetchSellerProductById(targetUserId, String(req.params.id));
    ResponseUtil.success(res, product);
  } catch (error) {
    next(error);
  }
});

// ── POST Endpoints ───────────────────────────────────────────────────────────
router.post('/me/products', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const product = await createSellerProduct(req.user!.userId, req.body);
    ResponseUtil.created(res, product, 'تم إضافة المنتج والمتغيرات بنجاح');
  } catch (error) {
    next(error);
  }
});

router.post('/user/:userId/products', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const targetUserId = String(req.params.userId);
    if (req.user!.userId !== targetUserId && req.user!.role !== 'ADMIN') {
      throw new AppError('Forbidden: Access denied to other seller resources', 403, 'FORBIDDEN');
    }
    const product = await createSellerProduct(targetUserId, req.body);
    ResponseUtil.created(res, product, 'تم إضافة المنتج والمتغيرات بنجاح');
  } catch (error) {
    next(error);
  }
});

// ── PATCH Endpoints ──────────────────────────────────────────────────────────
router.patch('/me/products/:id', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const updated = await updateSellerProduct(req.user!.userId, String(req.params.id), req.body);
    ResponseUtil.success(res, updated, 'تم تعديل المنتج بنجاح');
  } catch (error) {
    next(error);
  }
});

router.patch('/user/:userId/products/:id', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const targetUserId = String(req.params.userId);
    if (req.user!.userId !== targetUserId && req.user!.role !== 'ADMIN') {
      throw new AppError('Forbidden: Access denied to other seller resources', 403, 'FORBIDDEN');
    }
    const updated = await updateSellerProduct(targetUserId, String(req.params.id), req.body);
    ResponseUtil.success(res, updated, 'تم تعديل المنتج بنجاح');
  } catch (error) {
    next(error);
  }
});

// ── DELETE Endpoints ─────────────────────────────────────────────────────────
router.delete('/me/products/:id', async (req: Request, res: Response, next: NextFunction) => {
  try {
    await deleteSellerProduct(req.user!.userId, String(req.params.id));
    ResponseUtil.success(res, null, 'تم حذف المنتج بنجاح');
  } catch (error) {
    next(error);
  }
});

router.delete('/user/:userId/products/:id', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const targetUserId = String(req.params.userId);
    if (req.user!.userId !== targetUserId && req.user!.role !== 'ADMIN') {
      throw new AppError('Forbidden: Access denied to other seller resources', 403, 'FORBIDDEN');
    }
    await deleteSellerProduct(targetUserId, String(req.params.id));
    ResponseUtil.success(res, null, 'تم حذف المنتج بنجاح');
  } catch (error) {
    next(error);
  }
});

// ── 5. Inventory Stock Adjustments ─────────────────────────────────────────────
router.get('/me/inventory', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const seller = await getSeller(req.user!.userId);
    const storeIds = seller.stores.map((s) => s.id);

    const inventories = await prisma.inventory.findMany({
      where: { product: { storeId: { in: storeIds } } },
      include: {
        product: {
          select: {
            id: true,
            nameAr: true,
            nameEn: true,
            sku: true,
            price: true,
            images: { take: 1, orderBy: { sortOrder: 'asc' } },
          },
        },
      },
    });

    const formatted = inventories.map((inv) => {
      const quantity = inv.quantity;
      const reserved = inv.reserved;
      const available = Math.max(0, quantity - reserved);
      const lowStockAlert = inv.lowStockAlert || 5;

      let status = 'Good';
      if (available <= 0) {
        status = 'Out';
      } else if (available <= lowStockAlert) {
        status = 'Low';
      }

      return {
        id: inv.id,
        productId: inv.productId,
        product: inv.product,
        quantity,
        reserved,
        available,
        lowStockAlert,
        status,
        updatedAt: inv.updatedAt,
      };
    });

    ResponseUtil.success(res, formatted);
  } catch (error) {
    next(error);
  }
});

router.post('/me/inventory/adjust', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const seller = await getSeller(req.user!.userId);
    const { productId, quantity } = req.body;
    const storeIds = seller.stores.map((s) => s.id);

    const product = await prisma.product.findFirst({
      where: { id: productId, storeId: { in: storeIds } },
    });
    if (!product) throw new AppError('المنتج غير موجود أو لا تملك صلاحية تعديله', 404);

    const parsedQty = parseInt(quantity, 10);
    if (isNaN(parsedQty) || parsedQty < 0) {
      throw new AppError('كمية المخزون يجب أن تكون رقماً موجباً', 400);
    }

    const inventory = await prisma.inventory.upsert({
      where: { productId },
      update: { quantity: parsedQty },
      create: { productId, quantity: parsedQty, reserved: 0 },
      include: {
        product: { select: { id: true, nameAr: true, nameEn: true, sku: true, price: true } },
      },
    });

    const available = Math.max(0, inventory.quantity - inventory.reserved);
    const status = available <= 0 ? 'Out' : available <= inventory.lowStockAlert ? 'Low' : 'Good';

    // Broadcast stock adjustment realtime
    try {
      SocketService.get()?.emitGlobal('inventory:updated', {
        productId,
        quantity: inventory.quantity,
        available,
        status,
      });
    } catch (_) {}

    ResponseUtil.success(res, {
      ...inventory,
      available,
      status,
    }, 'تم تحديث كمية المخزون بنجاح');
  } catch (error) {
    next(error);
  }
});

// ── 6. Order State Machine ─────────────────────────────────────────────────────
router.get('/me/orders', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const seller = await getSeller(req.user!.userId);
    const { status } = req.query;

    let statusFilter: any = undefined;
    if (status && status !== 'ALL') {
      const s = status.toString().toUpperCase();
      if (s === 'CANCELLED' || s === 'CANCELLED_BY_CUSTOMER' || s === 'CANCELLED_BY_SELLER' || s === 'REJECTED_BY_SELLER' || s === 'CANCELLED_BY_ADMIN') {
        statusFilter = { in: [SellerOrderStatus.CANCELLED_BY_CUSTOMER, SellerOrderStatus.CANCELLED_BY_SELLER, SellerOrderStatus.REJECTED_BY_SELLER, SellerOrderStatus.CANCELLED_BY_ADMIN] };
      } else if (s === 'RETURNS' || s === 'RETURN_REQUESTED' || s === 'RETURN_APPROVED' || s === 'RETURNED' || s === 'REFUND_PENDING' || s === 'REFUNDED') {
        statusFilter = { in: [SellerOrderStatus.RETURN_REQUESTED, SellerOrderStatus.RETURN_APPROVED, SellerOrderStatus.RETURNED, SellerOrderStatus.REFUND_PENDING, SellerOrderStatus.REFUNDED] };
      } else if (s === 'READY_FOR_PICKUP' || s === 'READY_FOR_SHIPMENT') {
        statusFilter = SellerOrderStatus.READY_TO_SHIP;
      } else if (s === 'ACCEPTED') {
        statusFilter = SellerOrderStatus.CONFIRMED;
      } else if (s === 'PREPARING') {
        statusFilter = SellerOrderStatus.PROCESSING;
      } else {
        statusFilter = s as any;
      }
    }

    const isCancelledTab = status && [
      'CANCELLED',
      'CANCELLED_BY_CUSTOMER',
      'CANCELLED_BY_SELLER',
      'REJECTED_BY_SELLER',
      'CANCELLED_BY_ADMIN',
    ].includes(status.toString().toUpperCase());

    const paymentFilter = isCancelledTab
      ? {}
      : {
          order: {
            OR: [
              { payment: { status: PaymentStatus.PAID } },
              { payment: { method: PaymentMethodType.CASH_ON_DELIVERY } },
              { payment: null },
            ],
          },
        };

    const page = req.query.page ? Math.max(1, parseInt(req.query.page as string, 10) || 1) : undefined;
    const limit = req.query.limit ? Math.min(100, Math.max(1, parseInt(req.query.limit as string, 10) || 20)) : undefined;
    const skip = page && limit ? (page - 1) * limit : undefined;

    const where = {
      sellerId: seller.id,
      ...(statusFilter ? { status: statusFilter } : {}),
      ...paymentFilter,
    };

    const [orders, total] = await Promise.all([
      prisma.sellerOrder.findMany({
        where,
        include: {
          order: {
            select: {
              orderNumber: true,
              displayOrderNumber: true,
              orderSequence: true,
              createdAt: true,
              deliveryScheduleType: true,
              deliveryDate: true,
              deliveryTimeSlot: true,
              slotBooking: { include: { timeSlot: true } },
              addressSnapshot: true,
              notes: true,
              user: { select: { firstName: true, lastName: true, phone: true } },
              returnRequests: { orderBy: { createdAt: 'desc' }, take: 1 },
              refundRequests: {
                include: { evidence: true },
                orderBy: { createdAt: 'desc' },
                take: 1,
              },
            },
          },
          items: true,
          deliveryMethod: true,
          deliveryQuoteSnapshot: true,
          cancellationRequests: true,
          statusHistory: { orderBy: { createdAt: 'desc' }, take: 1 },
          refundRequests: {
            include: { evidence: true },
            orderBy: { createdAt: 'desc' },
            take: 1,
          },
        },
        orderBy: { createdAt: 'desc' },
        ...(skip !== undefined ? { skip } : {}),
        ...(limit !== undefined ? { take: limit } : {}),
      }),
      page && limit ? prisma.sellerOrder.count({ where }) : Promise.resolve(0),
    ]);

    const enrichedOrders = orders.map((o) => {
      const firstRefund = (o.refundRequests && o.refundRequests[0]) || (o.order?.refundRequests && o.order.refundRequests[0]);
      const firstReturn = (o.order?.returnRequests && o.order.returnRequests[0]);
      const evidenceUrls: string[] = [];
      if (firstRefund?.evidence) {
        firstRefund.evidence.forEach((ev: any) => {
          if (ev.fileUrl && !evidenceUrls.includes(ev.fileUrl)) {
            evidenceUrls.push(ev.fileUrl);
          }
        });
      }
      return {
        ...o,
        notes: (o as any).notes || o.order?.notes || null,
        returnReason: firstRefund?.reasonText || firstReturn?.reason || (o as any).returnReason || null,
        returnDescription: firstRefund?.description || firstReturn?.description || (o as any).returnDescription || null,
        returnImages: evidenceUrls,
      };
    });

    const meta = page && limit ? {
      page,
      limit,
      total,
      totalPages: Math.ceil(total / limit),
    } : undefined;

    ResponseUtil.success(res, enrichedOrders, undefined, 200, meta);
  } catch (error) {
    next(error);
  }
});

// GET /me/orders/:id — Single seller order details
router.get('/me/orders/:id', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const seller = await getSeller(req.user!.userId);
    const id = String(req.params.id);

    const order = await prisma.sellerOrder.findFirst({
      where: {
        sellerId: seller.id,
        OR: [
          { id },
          { sellerOrderNumber: id },
          { orderId: id },
          { order: { orderNumber: id } },
          { order: { displayOrderNumber: id } },
        ],
      },
      include: {
        order: {
          include: {
            addressSnapshot: true,
            deliveryTimeSlot: true,
            slotBooking: { include: { timeSlot: true } },
            user: { select: { firstName: true, lastName: true, phone: true, email: true } },
            payment: true,
            returnRequests: { orderBy: { createdAt: 'desc' } },
            refundRequests: {
              include: {
                evidence: true,
                items: true,
                reason: true,
              },
              orderBy: { createdAt: 'desc' },
            },
          },
        },
        items: true,
        deliveryMethod: true,
        deliveryQuoteSnapshot: true,
        cancellationRequests: { orderBy: { createdAt: 'desc' } },
        statusHistory: { orderBy: { createdAt: 'asc' } },
        refundRequests: {
          include: {
            evidence: true,
            items: true,
            reason: true,
          },
          orderBy: { createdAt: 'desc' },
        },
      },
    });

    if (!order) throw new AppError('طلب المتجر غير موجود', 404);

    const firstRefund = (order.refundRequests && order.refundRequests[0]) || (order.order?.refundRequests && order.order.refundRequests[0]);
    const firstReturn = (order.order?.returnRequests && order.order.returnRequests[0]);
    const evidenceUrls: string[] = [];
    if (firstRefund?.evidence) {
      firstRefund.evidence.forEach((ev: any) => {
        if (ev.fileUrl && !evidenceUrls.includes(ev.fileUrl)) {
          evidenceUrls.push(ev.fileUrl);
        }
      });
    }

    const enrichedOrder = {
      ...order,
      notes: (order as any).notes || order.order?.notes || null,
      returnReason: firstRefund?.reasonText || firstReturn?.reason || (order as any).returnReason || null,
      returnDescription: firstRefund?.description || firstReturn?.description || (order as any).returnDescription || null,
      returnImages: evidenceUrls,
    };

    ResponseUtil.success(res, enrichedOrder);
  } catch (error) {
    next(error);
  }
});

// GET /me/orders/:id/print — Comprehensive Seller Order Printing & Invoice Engine
router.get(
  ['/me/orders/:id/print', '/me/orders/:id/invoice', '/me/orders/:id/receipt'],
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const seller = await getSeller(req.user!.userId);
      const id = String(req.params.id);

      const sellerOrder = await prisma.sellerOrder.findFirst({
        where: {
          sellerId: seller.id,
          OR: [
            { id },
            { sellerOrderNumber: id },
            { orderId: id },
            { order: { orderNumber: id } },
            { order: { displayOrderNumber: id } },
          ],
        },
        include: {
          seller: {
            include: {
              stores: { include: { addresses: true } },
              user: { select: { firstName: true, lastName: true, phone: true, email: true } },
            },
          },
          order: {
            include: {
              addressSnapshot: true,
              deliveryAddress: true,
              payment: true,
              user: { select: { firstName: true, lastName: true, phone: true } },
            },
          },
          items: {
            include: {
              product: { select: { nameAr: true, nameEn: true, sku: true, images: true } },
              variant: { select: { sku: true, nameAr: true, nameEn: true } },
            },
          },
          printLogs: {
            orderBy: { printedAt: 'desc' },
            take: 10,
          },
        },
      });

      if (!sellerOrder || !(sellerOrder as any).order) {
        throw new AppError('طلب المتجر غير موجود', 404);
      }

      // Determine requested document type & format
      const rawType = String(req.query.type || 'invoice').toLowerCase();
      let docType: PrintDocumentType = 'INVOICE';
      if (rawType === 'packing_slip' || rawType === 'packing' || rawType === 'slip') {
        docType = 'PACKING_SLIP';
      } else if (rawType === 'statement' || rawType === 'financial') {
        docType = 'STATEMENT';
      }

      const rawFormat = String(req.query.format || req.query.size || 'a4').toUpperCase();
      let format: PrintFormat = 'A4';
      if (rawFormat === '80MM' || rawFormat === '80') {
        format = '80MM';
      } else if (rawFormat === '58MM' || rawFormat === '58') {
        format = '58MM';
      }

      const autoPrint = req.query.autoPrint === 'true' || req.query.autoprint === '1';
      const isActionPrint = req.query.action === 'print';

      // Build safe normalized print document data
      const printData = await SellerOrderPrintService.buildPrintDocumentData(sellerOrder, docType, format);

      // Record print audit if action is print or autoPrint is requested
      if (isActionPrint || autoPrint) {
        const newCount = (sellerOrder.printCount || 0) + 1;
        printData.printAudit.printCount = newCount;
        printData.printAudit.lastPrintedAt = new Date().toISOString();

        await prisma.sellerOrder.update({
          where: { id: sellerOrder.id },
          data: {
            printCount: newCount,
            lastPrintedAt: new Date(),
          },
        });

        await prisma.sellerOrderPrintLog.create({
          data: {
            sellerId: seller.id,
            orderId: sellerOrder.orderId,
            sellerOrderId: sellerOrder.id,
            documentType: docType,
            format,
            printedBy: `${seller.user.firstName || ''} ${seller.user.lastName || ''}`.trim() || 'البائع',
          },
        });
      }

      // Output negotiation
      const wantsHtml =
        req.query.output === 'html' ||
        req.query.format === 'html' ||
        req.headers.accept?.includes('text/html');

      if (wantsHtml) {
        let baseFilename = `SOUQNAA-Order-${printData.sellerOrderNumber}`;
        if (docType === 'PACKING_SLIP') baseFilename = `SOUQNAA-Packing-${printData.sellerOrderNumber}`;
        if (docType === 'STATEMENT') baseFilename = `SOUQNAA-Statement-${printData.sellerOrderNumber}`;

        res.setHeader(
          'Content-Security-Policy',
          "default-src 'self' 'unsafe-inline' data: https://fonts.googleapis.com https://fonts.gstatic.com; script-src 'self' 'unsafe-inline'; object-src 'none';"
        );
        res.setHeader('X-Content-Type-Options', 'nosniff');
        res.setHeader('Content-Type', 'text/html; charset=utf-8');
        res.setHeader('Content-Disposition', `inline; filename="${baseFilename}.html"`);
        return res.send(SellerOrderPrintService.renderHtmlDocument(printData, autoPrint));
      }

      ResponseUtil.success(res, printData, 'تم استرجاع بيانات وثيقة الطباعة بنجاح');
    } catch (error) {
      next(error);
    }
  }
);

// POST /me/orders/:id/print/log — Record seller order reprint / print audit event
router.post('/me/orders/:id/print/log', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const seller = await getSeller(req.user!.userId);
    const id = String(req.params.id);
    const { documentType = 'INVOICE', format = 'A4' } = req.body;

    const sellerOrder = await prisma.sellerOrder.findFirst({
      where: {
        sellerId: seller.id,
        OR: [
          { id },
          { sellerOrderNumber: id },
          { orderId: id },
          { order: { orderNumber: id } },
          { order: { displayOrderNumber: id } },
        ],
      },
    });

    if (!sellerOrder) throw new AppError('طلب المتجر غير موجود', 404);

    const newCount = (sellerOrder.printCount || 0) + 1;
    const now = new Date();

    const [updated] = await prisma.$transaction([
      prisma.sellerOrder.update({
        where: { id: sellerOrder.id },
        data: {
          printCount: newCount,
          lastPrintedAt: now,
        },
      }),
      prisma.sellerOrderPrintLog.create({
        data: {
          sellerId: seller.id,
          orderId: sellerOrder.orderId,
          sellerOrderId: sellerOrder.id,
          documentType: String(documentType).toUpperCase(),
          format: String(format).toUpperCase(),
          printedBy: `${seller.user.firstName || ''} ${seller.user.lastName || ''}`.trim() || 'البائع',
        },
      }),
    ]);

    ResponseUtil.success(
      res,
      {
        printCount: updated.printCount,
        lastPrintedAt: updated.lastPrintedAt,
      },
      'تم تسجيل عملية الطباعة في سجل التدقيق بنجاح'
    );
  } catch (error) {
    next(error);
  }
});

// GET /me/orders/:id/print/history — Print audit history for seller order
router.get('/me/orders/:id/print/history', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const seller = await getSeller(req.user!.userId);
    const id = String(req.params.id);

    const sellerOrder = await prisma.sellerOrder.findFirst({
      where: {
        sellerId: seller.id,
        OR: [
          { id },
          { sellerOrderNumber: id },
          { orderId: id },
          { order: { orderNumber: id } },
          { order: { displayOrderNumber: id } },
        ],
      },
      select: {
        id: true,
        sellerOrderNumber: true,
        printCount: true,
        lastPrintedAt: true,
        printLogs: {
          orderBy: { printedAt: 'desc' },
          take: 50,
        },
      },
    });

    if (!sellerOrder) throw new AppError('طلب المتجر غير موجود', 404);

    ResponseUtil.success(res, sellerOrder, 'تم استرجاع سجل طباعة الطلب بنجاح');
  } catch (error) {
    next(error);
  }
});

// Helper to resolve seller order ID from id / orderId / orderNumber
async function resolveSellerOrderId(sellerId: string, idParam: string): Promise<string> {
  const match = await prisma.sellerOrder.findFirst({
    where: {
      sellerId,
      OR: [
        { id: idParam },
        { sellerOrderNumber: idParam },
        { orderId: idParam },
        { order: { orderNumber: idParam } },
        { order: { displayOrderNumber: idParam } },
      ],
    },
    select: { id: true },
  });
  if (!match) throw new AppError('طلب المتجر غير موجود', 404);
  return match.id;
}

// POST /me/orders/:id/accept — PENDING -> CONFIRMED
router.post('/me/orders/:id/accept', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const seller = await getSeller(req.user!.userId);
    const resolvedId = await resolveSellerOrderId(seller.id, String(req.params.id));

    const result = await OrderStateMachine.transitionSellerOrder({
      sellerOrderId: resolvedId,
      targetStatus: SellerOrderStatus.CONFIRMED,
      changedBy: req.user!.userId,
      changedByRole: 'SELLER',
      note: 'تم قبول الطلب وبدء التحضير',
    });

    ResponseUtil.success(res, result.sellerOrder, 'تم قبول الطلب وتأكيده بنجاح');
  } catch (error) {
    next(error);
  }
});

// POST /me/orders/:id/reject — PENDING -> REJECTED_BY_SELLER
router.post('/me/orders/:id/reject', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const seller = await getSeller(req.user!.userId);
    const resolvedId = await resolveSellerOrderId(seller.id, String(req.params.id));
    const { reason, note } = req.body;

    if (!reason) {
      throw new AppError('سبب رفض الطلب مطلوب (OUT_OF_STOCK, PRODUCT_UNAVAILABLE, PRICE_ERROR, OPERATIONAL_ISSUE, OTHER)', 400);
    }

    const result = await OrderStateMachine.transitionSellerOrder({
      sellerOrderId: resolvedId,
      targetStatus: SellerOrderStatus.REJECTED_BY_SELLER,
      changedBy: req.user!.userId,
      changedByRole: 'SELLER',
      reason,
      note: note || `تم رفض الطلب لسبب: ${reason}`,
    });

    ResponseUtil.success(res, result.sellerOrder, 'تم رفض الطلب وتحرير المخزون');
  } catch (error) {
    next(error);
  }
});

// POST /me/orders/:id/processing — CONFIRMED -> PROCESSING
router.post('/me/orders/:id/processing', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const seller = await getSeller(req.user!.userId);
    const resolvedId = await resolveSellerOrderId(seller.id, String(req.params.id));

    const result = await OrderStateMachine.transitionSellerOrder({
      sellerOrderId: resolvedId,
      targetStatus: SellerOrderStatus.PROCESSING,
      changedBy: req.user!.userId,
      changedByRole: 'SELLER',
      note: 'الطلب قيد التجهيز والتغليف الآن',
    });

    ResponseUtil.success(res, result.sellerOrder, 'تم تحويل الطلب إلى قيد التجهيز');
  } catch (error) {
    next(error);
  }
});

// POST /me/orders/:id/ready-to-ship (and /ready) — PROCESSING -> READY_TO_SHIP
router.post(['/me/orders/:id/ready-to-ship', '/me/orders/:id/ready'], async (req: Request, res: Response, next: NextFunction) => {
  try {
    const seller = await getSeller(req.user!.userId);
    const resolvedId = await resolveSellerOrderId(seller.id, String(req.params.id));

    const result = await OrderStateMachine.transitionSellerOrder({
      sellerOrderId: resolvedId,
      targetStatus: SellerOrderStatus.READY_TO_SHIP,
      changedBy: req.user!.userId,
      changedByRole: 'SELLER',
      note: 'الشحنة جاهزة للتسليم والشحن',
    });

    ResponseUtil.success(res, result.sellerOrder, 'تم تحديد الطلب كجاهز للشحن بنجاح');
  } catch (error) {
    next(error);
  }
});

// POST /me/orders/:id/shipped (and /ship) — READY_TO_SHIP -> SHIPPED
router.post(['/me/orders/:id/shipped', '/me/orders/:id/ship'], async (req: Request, res: Response, next: NextFunction) => {
  try {
    const seller = await getSeller(req.user!.userId);
    const resolvedId = await resolveSellerOrderId(seller.id, String(req.params.id));

    const result = await OrderStateMachine.transitionSellerOrder({
      sellerOrderId: resolvedId,
      targetStatus: SellerOrderStatus.SHIPPED,
      changedBy: req.user!.userId,
      changedByRole: 'SELLER',
      note: 'تم تسليم الشحنة للشحن وبانتظار تأكيد استلام العميل',
    });

    ResponseUtil.success(res, result.sellerOrder, 'تم شحن الطلب بنجاح وهو بانتظار استلام العميل');
  } catch (error) {
    next(error);
  }
});

// POST /me/orders/:id/cancel — Seller cancellation
router.post('/me/orders/:id/cancel', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const seller = await getSeller(req.user!.userId);
    const resolvedId = await resolveSellerOrderId(seller.id, String(req.params.id));
    const { reason, note } = req.body;

    if (!reason) throw new AppError('سبب إلغاء الطلب مطلوب', 400);

    const result = await OrderStateMachine.transitionSellerOrder({
      sellerOrderId: resolvedId,
      targetStatus: SellerOrderStatus.CANCELLED_BY_SELLER,
      changedBy: req.user!.userId,
      changedByRole: 'SELLER',
      reason,
      note: note || `تم إلغاء الطلب من قبل المتجر: ${reason}`,
    });

    ResponseUtil.success(res, result.sellerOrder, 'تم إلغاء الطلب بنجاح');
  } catch (error) {
    next(error);
  }
});

// GET /me/cancellations — List cancellation requests for this seller
router.get('/me/cancellations', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const seller = await getSeller(req.user!.userId);

    const requests = await prisma.cancellationRequest.findMany({
      where: {
        OR: [
          { sellerOrder: { sellerId: seller.id } },
          { order: { sellerOrders: { some: { sellerId: seller.id } } } },
        ],
      },
      include: {
        order: { select: { orderNumber: true, total: true, user: { select: { firstName: true, lastName: true, phone: true } } } },
        sellerOrder: { select: { id: true, subtotal: true, status: true } },
      },
      orderBy: { createdAt: 'desc' },
    });

    ResponseUtil.success(res, requests);
  } catch (error) {
    next(error);
  }
});

// POST /me/cancellations/:id/approve — Seller approves customer cancellation request
router.post('/me/cancellations/:id/approve', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const seller = await getSeller(req.user!.userId);
    const id = String(req.params.id);

    const cancelReq = await prisma.cancellationRequest.findFirst({
      where: {
        id,
        OR: [
          { sellerOrder: { sellerId: seller.id } },
          { order: { sellerOrders: { some: { sellerId: seller.id } } } },
        ],
      },
      include: {
        sellerOrder: true,
        order: { include: { sellerOrders: true } },
      },
    });

    if (!cancelReq) {
      throw new AppError('طلب الإلغاء غير موجود أو لا يخص هذا المتجر', 404);
    }

    const targetSellerOrderId =
      cancelReq.sellerOrderId ||
      cancelReq.order.sellerOrders.find((s) => s.sellerId === seller.id)?.id;

    if (!targetSellerOrderId) {
      throw new AppError('طلب المتجر المرتبط بطلب الإلغاء غير موجود', 404);
    }

    await prisma.cancellationRequest.update({
      where: { id: cancelReq.id },
      data: {
        status: CancellationRequestStatus.APPROVED,
        resolvedBy: req.user!.userId,
        resolvedAt: new Date(),
      },
    });

    const result = await OrderStateMachine.transitionSellerOrder({
      sellerOrderId: targetSellerOrderId,
      targetStatus: SellerOrderStatus.CANCELLED_BY_CUSTOMER,
      changedBy: req.user!.userId,
      changedByRole: 'SELLER',
      reason: cancelReq.reason,
      note: 'موافقة المتجر على طلب إلغاء العميل وإرجاع كامل المبلغ لمحفظة العميل',
    });

    ResponseUtil.success(res, result.sellerOrder, 'تمت الموافقة على طلب الإلغاء وإرجاع كامل المبلغ لمحفظة العميل وتحرير المخزون');
  } catch (error) {
    next(error);
  }
});

// POST /me/cancellations/:id/reject — Seller rejects customer cancellation request
router.post('/me/cancellations/:id/reject', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const seller = await getSeller(req.user!.userId);
    const id = String(req.params.id);
    const { note } = req.body;

    const cancelReq = await prisma.cancellationRequest.findFirst({
      where: {
        id,
        OR: [
          { sellerOrder: { sellerId: seller.id } },
          { order: { sellerOrders: { some: { sellerId: seller.id } } } },
        ],
      },
      include: {
        sellerOrder: true,
        order: { include: { sellerOrders: true } },
      },
    });

    if (!cancelReq) {
      throw new AppError('طلب الإلغاء غير موجود أو لا يخص هذا المتجر', 404);
    }

    const targetSellerOrderId =
      cancelReq.sellerOrderId ||
      cancelReq.order.sellerOrders.find((s) => s.sellerId === seller.id)?.id;

    if (!targetSellerOrderId) {
      throw new AppError('طلب المتجر المرتبط بطلب الإلغاء غير موجود', 404);
    }

    await prisma.cancellationRequest.update({
      where: { id: cancelReq.id },
      data: {
        status: CancellationRequestStatus.REJECTED,
        resolvedBy: req.user!.userId,
        resolvedAt: new Date(),
        adminNote: note,
      },
    });

    // Restore seller order status back to PROCESSING
    await prisma.sellerOrder.update({
      where: { id: targetSellerOrderId },
      data: { status: SellerOrderStatus.PROCESSING },
    });
    const parentStatus = await OrderStateMachine.syncParentOrderStatus(cancelReq.orderId);

    try {
      const orderData = await prisma.order.findUnique({
        where: { id: cancelReq.orderId },
        select: { orderNumber: true, displayOrderNumber: true, userId: true },
      });
      SocketService.get()?.emitOrderStatusUpdate({
        orderId: cancelReq.orderId,
        orderNumber: orderData?.orderNumber || '',
        displayOrderNumber: orderData?.displayOrderNumber || undefined,
        sellerOrderId: targetSellerOrderId,
        customerUserId: orderData?.userId,
        sellerUserIds: [seller.userId],
        status: parentStatus,
        changedByRole: 'SELLER',
        extra: { previousStatus: OrderStatus.CANCELLATION_REQUESTED },
      });
    } catch (_) {}

    ResponseUtil.success(res, null, 'تم رفض طلب الإلغاء واستئناف تجهيز الطلب');
  } catch (error) {
    next(error);
  }
});

// GET /me/returns — List return requests for this seller
router.get('/me/returns', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const seller = await getSeller(req.user!.userId);

    const returns = await prisma.returnRequest.findMany({
      where: {
        OR: [
          { sellerOrder: { sellerId: seller.id } },
          { order: { sellerOrders: { some: { sellerId: seller.id } } } },
        ],
      },
      include: {
        order: { select: { orderNumber: true, total: true, user: { select: { firstName: true, lastName: true, phone: true } } } },
        sellerOrder: { select: { id: true, subtotal: true, status: true } },
      },
      orderBy: { createdAt: 'desc' },
    });

    ResponseUtil.success(res, returns);
  } catch (error) {
    next(error);
  }
});

// POST /me/returns/:id/approve or /me/orders/:id/approve-return
router.post(['/me/returns/:id/approve', '/me/orders/:id/approve-return'], async (req: Request, res: Response, next: NextFunction) => {
  try {
    const seller = await getSeller(req.user!.userId);
    const id = String(req.params.id);

    let returnReq = await prisma.returnRequest.findFirst({
      where: {
        OR: [{ id }, { sellerOrderId: id }, { orderId: id }],
        sellerOrder: { sellerId: seller.id },
      },
      include: { sellerOrder: true, order: { include: { sellerOrders: true } } },
    });

    if (!returnReq && id) {
      returnReq = await prisma.returnRequest.findFirst({
        where: {
          OR: [{ id }, { sellerOrderId: id }, { orderId: id }],
          order: { sellerOrders: { some: { sellerId: seller.id } } },
        },
        include: { sellerOrder: true, order: { include: { sellerOrders: true } } },
      });
    }

    if (returnReq) {
      await prisma.returnRequest.update({
        where: { id: returnReq.id },
        data: {
          status: ReturnRequestStatus.APPROVED,
          resolvedBy: req.user!.userId,
          resolvedAt: new Date(),
        },
      });
    }

    const sellerOrderId =
      returnReq?.sellerOrderId ||
      returnReq?.order?.sellerOrders?.find((s) => s.sellerId === seller.id)?.id ||
      id;

    const result = await OrderStateMachine.transitionSellerOrder({
      sellerOrderId,
      targetStatus: SellerOrderStatus.RETURN_APPROVED,
      changedBy: req.user!.userId,
      changedByRole: 'SELLER',
      reason: returnReq?.reason || 'موافقة المتجر على طلب الإرجاع',
      note: 'تمت الموافقة على طلب الإرجاع وإرجاع كامل المبلغ لمحفظة العميل',
    });

    // Synchronize associated RefundRequest if present
    try {
      const activeRefund = await prisma.refundRequest.findFirst({
        where: {
          OR: [
            { sellerOrderId },
            { orderId: result.sellerOrder.orderId },
          ],
          status: { in: [RefundStatus.UNDER_SELLER_REVIEW, RefundStatus.REQUESTED, RefundStatus.SELLER_REVIEW, RefundStatus.SUBMITTED] },
        },
      });

      if (activeRefund) {
        await prisma.refundRequest.update({
          where: { id: activeRefund.id },
          data: {
            status: RefundStatus.SELLER_ACCEPTED,
            approvedAmount: activeRefund.requestedAmount,
            sellerResponse: returnReq?.reason || 'موافقة المتجر على طلب الإرجاع',
          },
        });

        await prisma.refundExecutionLock.upsert({
          where: { refundId: activeRefund.id },
          create: {
            refundId: activeRefund.id,
            destination: RefundDestination.CUSTOMER_WALLET,
            status: 'COMPLETED',
            completedAt: new Date(),
          },
          update: {
            status: 'COMPLETED',
            completedAt: new Date(),
          },
        });
      }
    } catch (refErr) {
      console.error('[SellerReturnAccept] Error auto-processing refund request:', refErr);
    }

    try {
      SocketService.get()?.emitGlobal('order:return_approved', {
        sellerOrderId,
        orderId: result.sellerOrder.orderId,
      });
      SocketService.get()?.emitGlobal('order:status', {
        orderId: result.sellerOrder.orderId,
        status: 'RETURN_APPROVED',
      });
    } catch (_) {}

    ResponseUtil.success(res, result.sellerOrder, 'تمت الموافقة على طلب الإرجاع واسترداد كامل المبلغ لمحفظة العميل بنجاح');
  } catch (error) {
    next(error);
  }
});

// POST /me/returns/:id/reject or /me/orders/:id/reject-return
router.post(['/me/returns/:id/reject', '/me/orders/:id/reject-return'], async (req: Request, res: Response, next: NextFunction) => {
  try {
    const seller = await getSeller(req.user!.userId);
    const id = String(req.params.id);
    const { note } = req.body;

    let returnReq = await prisma.returnRequest.findFirst({
      where: {
        OR: [{ id }, { sellerOrderId: id }, { orderId: id }],
        sellerOrder: { sellerId: seller.id },
      },
      include: { sellerOrder: true },
    });

    if (returnReq) {
      await prisma.returnRequest.update({
        where: { id: returnReq.id },
        data: {
          status: ReturnRequestStatus.REJECTED,
          resolvedBy: req.user!.userId,
          resolvedAt: new Date(),
        },
      });
    }

    const sellerOrderId = returnReq?.sellerOrderId || id;
    await OrderStateMachine.transitionSellerOrder({
      sellerOrderId,
      targetStatus: SellerOrderStatus.DELIVERED,
      changedBy: req.user!.userId,
      changedByRole: 'SELLER',
      reason: note || 'تم رفض طلب الإرجاع من قبل التاجر',
      note: note || 'تم رفض طلب الإرجاع من قبل التاجر',
    });

    const targetOrderId = returnReq?.orderId || (await prisma.sellerOrder.findUnique({ where: { id: sellerOrderId }, select: { orderId: true } }))?.orderId;
    if (targetOrderId) {

      // Also update any related RefundRequest to REJECTED so customer can dispute
      await prisma.refundRequest.updateMany({
        where: {
          OR: [
            { orderId: targetOrderId },
            { sellerOrderId: sellerOrderId },
          ],
          status: { in: [RefundStatus.REQUESTED, RefundStatus.SELLER_REVIEW] },
        },
        data: {
          status: RefundStatus.REJECTED,
          sellerResponse: note || 'تم رفض طلب الإرجاع من قبل المتجر',
          sellerRejectionReason: note || 'تم رفض طلب الإرجاع من قبل المتجر',
        },
      });
    }

    try {
      SocketService.get()?.emitGlobal('order:return_rejected', {
        sellerOrderId,
        orderId: targetOrderId || returnReq?.orderId,
        reason: note,
      });
      if (targetOrderId) {
        const orderData = await prisma.order.findUnique({
          where: { id: targetOrderId },
          select: { orderNumber: true, displayOrderNumber: true, userId: true },
        });
        SocketService.get()?.emitOrderStatusUpdate({
          orderId: targetOrderId,
          orderNumber: orderData?.orderNumber || '',
          displayOrderNumber: orderData?.displayOrderNumber || undefined,
          sellerOrderId,
          customerUserId: orderData?.userId,
          sellerUserIds: [seller.userId],
          status: OrderStatus.DELIVERED,
          changedByRole: 'SELLER',
          extra: { previousStatus: OrderStatus.RETURN_REQUESTED },
        });
      }
    } catch (_) {}

    ResponseUtil.success(res, null, 'تم رفض طلب الإرجاع والاحتفاظ بحالة الطلب كمكتمل');
  } catch (error) {
    next(error);
  }
});

// ── 7. Finance & Balance & Withdrawals ─────────────────────────────────────────
router.get('/me/balance', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const seller = await getSeller(req.user!.userId);
    const standing = await SellerFinancialRiskService.getSellerFinancialStanding(seller.id);

    // Calculate aggregated delivered payouts & commissions & taxes
    const stats = await prisma.sellerOrder.aggregate({
      where: { sellerId: seller.id, status: 'DELIVERED' },
      _sum: {
        sellerPayout: true,
        commissionAmount: true,
        taxAmount: true,
        subtotal: true,
        voucherDiscountAmount: true,
      },
    });

    const totalEarnings = stats._sum.sellerPayout ?? (standing.availableBalance + standing.withdrawnBalance);
    const totalCommissions = stats._sum.commissionAmount ?? 0;
    const totalTaxCollected = stats._sum.taxAmount ?? 0;

    ResponseUtil.success(res, {
      id: seller.balance?.id,
      sellerId: seller.id,
      availableBalance: standing.availableBalance,
      pendingBalance: standing.pendingBalance,
      withdrawnBalance: standing.withdrawnBalance,
      outstandingCommission: standing.outstandingCommission,
      isFinanciallyRestricted: standing.isFinanciallyRestricted,
      financialRestrictionLevel: standing.financialRestrictionLevel,
      financialRestrictionReason: standing.financialRestrictionReason,
      financialRestrictedAt: standing.financialRestrictedAt,
      cashOnDeliveryEnabled: standing.cashOnDeliveryEnabled,
      amountNeededToUnblock: standing.amountNeededToUnblock,
      thresholds: standing.thresholds,
      currency: standing.currency,
      totalEarnings,
      totalCommissions,
      totalTaxCollected,
      updatedAt: seller.balance?.updatedAt || new Date(),
    });
  } catch (error) {
    next(error);
  }
});

// ── GET /me/financial-standing ─────────────────────────────────────────────────
router.get('/me/financial-standing', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const seller = await getSeller(req.user!.userId);
    const standing = await SellerFinancialRiskService.getSellerFinancialStanding(seller.id);
    ResponseUtil.success(res, standing);
  } catch (error) {
    next(error);
  }
});

// ── GET /me/outstandings ────────────────────────────────────────────────────────
router.get('/me/outstandings', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const seller = await getSeller(req.user!.userId);
    const page = parseInt(req.query.page as string, 10) || 1;
    const limit = parseInt(req.query.limit as string, 10) || 20;
    const status = req.query.status as string | undefined;

    const where: any = { sellerId: seller.id };
    if (status && status !== 'ALL') {
      where.status = status;
    }

    const [total, outstandings] = await Promise.all([
      prisma.sellerOutstanding.count({ where }),
      prisma.sellerOutstanding.findMany({
        where,
        skip: (page - 1) * limit,
        take: limit,
        orderBy: { createdAt: 'desc' },
      }),
    ]);

    ResponseUtil.success(res, {
      outstandings,
      pagination: {
        total,
        page,
        limit,
        totalPages: Math.ceil(total / limit),
      },
    });
  } catch (error) {
    next(error);
  }
});

// ── GET /me/cod-settings ───────────────────────────────────────────────────────
router.get('/me/cod-settings', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const seller = await getSeller(req.user!.userId);
    const standing = await SellerFinancialRiskService.getSellerFinancialStanding(seller.id);
    ResponseUtil.success(res, {
      cashOnDeliveryEnabled: seller.cashOnDeliveryEnabled,
      isFinanciallyRestricted: seller.isFinanciallyRestricted,
      financialRestrictionLevel: seller.financialRestrictionLevel || 'NORMAL',
      financialRestrictionReason: seller.financialRestrictionReason,
      outstandingCommission: standing.outstandingCommission,
      amountNeededToUnblock: standing.amountNeededToUnblock,
      canEnableCod: !seller.isFinanciallyRestricted,
    });
  } catch (error) {
    next(error);
  }
});

// ── PATCH /me/cod-settings ─────────────────────────────────────────────────────
router.patch('/me/cod-settings', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const seller = await getSeller(req.user!.userId);
    const { enabled } = req.body;

    if (typeof enabled !== 'boolean') {
      throw new AppError('يرجى تحديد حالة التفعيل كقيمة منطقية (true/false)', 400);
    }

    if (enabled && seller.isFinanciallyRestricted) {
      throw new AppError(
        'لا يمكن تفعيل الدفع عند الاستلام لوجود تقييد مالي معلق على الحساب بسبب تجاوز حد المديونية. يرجى سداد المديونية أولاً.',
        400,
        'FINANCIAL_RESTRICTION'
      );
    }

    const updated = await prisma.$transaction(async (tx) => {
      const s = await tx.seller.update({
        where: { id: seller.id },
        data: { cashOnDeliveryEnabled: enabled },
      });

      // Synchronize all stores under this seller
      await tx.store.updateMany({
        where: { sellerId: seller.id },
        data: { cashOnDeliveryEnabled: enabled },
      });

      return s;
    });

    SocketService.get()?.emitToUser(seller.userId, 'seller:cod_updated', {
      cashOnDeliveryEnabled: enabled,
    });

    ResponseUtil.success(
      res,
      { cashOnDeliveryEnabled: updated.cashOnDeliveryEnabled },
      enabled ? 'تم تفعيل الدفع عند الاستلام بنجاح' : 'تم تعطيل الدفع عند الاستلام بنجاح'
    );
  } catch (error) {
    next(error);
  }
});


// ── GET /me/finance/statement ──────────────────────────────────────────────────
// Tax-aware seller statement strictly separating gross sales, tax collected, and net payout
router.get('/me/finance/statement', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const seller = await getSeller(req.user!.userId);
    const { fromDate, toDate } = req.query;

    const where: any = { sellerId: seller.id };
    if (fromDate || toDate) {
      where.createdAt = {};
      if (fromDate) where.createdAt.gte = new Date(String(fromDate));
      if (toDate) where.createdAt.lte = new Date(String(toDate));
    }

    const [orderStats, refundStats] = await Promise.all([
      prisma.sellerOrder.aggregate({
        where,
        _sum: {
          subtotal: true,
          voucherDiscountAmount: true,
          taxAmount: true,
          deliveryFee: true,
          commissionAmount: true,
          sellerPayout: true,
        },
        _count: true,
      }),
      prisma.refundRequest.aggregate({
        where: { sellerId: seller.id, status: 'REFUND_COMPLETED' },
        _sum: { approvedAmount: true },
      }),
    ]);

    const grossSales = orderStats._sum.subtotal || 0;
    const discounts = orderStats._sum.voucherDiscountAmount || 0;
    const taxCollected = orderStats._sum.taxAmount || 0;
    const shipping = orderStats._sum.deliveryFee || 0;
    const commission = orderStats._sum.commissionAmount || 0;
    const sellerGrossPayout = orderStats._sum.sellerPayout || 0;
    const refunds = refundStats._sum.approvedAmount || 0;
    const netSellerAmount = Math.max(0, sellerGrossPayout - refunds);

    return ResponseUtil.success(res, {
      currency: 'YER',
      period: { fromDate: fromDate || null, toDate: toDate || null },
      statement: {
        orderCount: orderStats._count,
        grossSales,
        discounts,
        taxableBase: Math.max(0, grossSales - discounts),
        taxCollected, // Separated - NOT seller revenue!
        shipping,
        platformCommission: commission,
        refunds,
        netSellerAmount,
      },
    });
  } catch (error) {
    next(error);
  }
});

// ── GET /me/wallets ─────────────────────────────────────────────────────────────
router.get('/me/wallets', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const seller = await getSeller(req.user!.userId);
    const wallets = await prisma.sellerSavedWallet.findMany({
      where: { sellerId: seller.id },
      orderBy: { createdAt: 'desc' },
    });
    ResponseUtil.success(res, wallets);
  } catch (error) {
    next(error);
  }
});

// ── POST /me/wallets ────────────────────────────────────────────────────────────
router.post('/me/wallets', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const seller = await getSeller(req.user!.userId);
    const { provider, walletNumber, holderName } = req.body;

    if (!provider || !walletNumber) {
      throw new AppError('مزود الخدمة/المحفظة ورقم الحساب مطلوبان', 400);
    }

    let masked = walletNumber.trim();
    let normalized = walletNumber.trim();

    if (provider.toUpperCase() === 'BANK_TRANSFER') {
      if (normalized.length < 8) {
        throw new AppError('رقم الحساب البنكي أو الآيبان غير صحيح', 400);
      }
      masked = normalized.length > 8 ? normalized.slice(0, 4) + '****' + normalized.slice(-4) : normalized;
    } else {
      const adapter = WalletProviderRegistry.getAdapter(provider);
      const validation = adapter.validateWalletNumber(walletNumber);
      if (!validation.isValid) {
        throw new AppError(validation.error || 'رقم المحفظة غير صالح', 400);
      }
      normalized = validation.normalized || walletNumber.trim();
      masked = adapter.maskWalletNumber(normalized);
    }

    const saved = await prisma.sellerSavedWallet.create({
      data: {
        sellerId: seller.id,
        provider: provider.toUpperCase(),
        walletNumberMasked: masked,
        walletNumberFull: normalized,
        holderName: holderName ? holderName.trim() : null,
        isVerified: false,
      },
    });

    ResponseUtil.created(res, saved, 'تم ربط بيانات المحفظة بنجاح');
  } catch (error) {
    next(error);
  }
});

// ── PUT /me/wallets/:id ─────────────────────────────────────────────────────────
router.put('/me/wallets/:id', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const seller = await getSeller(req.user!.userId);
    const id = String(req.params.id);
    const { provider, walletNumber, holderName } = req.body;

    const existing = await prisma.sellerSavedWallet.findFirst({
      where: { id, sellerId: seller.id },
    });
    if (!existing) {
      throw new AppError('المحفظة غير موجودة أو ليس لديك صلاحية تعديلها', 404);
    }

    const targetProvider = (provider || existing.provider).toUpperCase();
    let walletNumberFull = existing.walletNumberFull;
    let walletNumberMasked = existing.walletNumberMasked;

    if (walletNumber && walletNumber.trim() !== '') {
      if (targetProvider === 'BANK_TRANSFER') {
        const trimmed = walletNumber.trim();
        walletNumberFull = trimmed;
        walletNumberMasked = trimmed.length > 8
          ? trimmed.slice(0, 4) + '****' + trimmed.slice(-4)
          : trimmed;
      } else {
        const adapter = WalletProviderRegistry.getAdapter(targetProvider);
        const validation = adapter.validateWalletNumber(walletNumber);
        if (!validation.isValid) {
          throw new AppError(validation.error || 'رقم المحفظة غير صالح', 400);
        }
        walletNumberFull = validation.normalized || walletNumber.trim();
        walletNumberMasked = adapter.maskWalletNumber(walletNumberFull || '');
      }
    }

    const updated = await prisma.sellerSavedWallet.update({
      where: { id },
      data: {
        provider: targetProvider,
        walletNumberFull,
        walletNumberMasked,
        holderName: holderName !== undefined ? (holderName ? holderName.trim() : null) : existing.holderName,
      },
    });

    ResponseUtil.success(res, updated, 'تم تحديث بيانات المحفظة بنجاح');
  } catch (error) {
    next(error);
  }
});

// ── DELETE /me/wallets/:id ──────────────────────────────────────────────────────
router.delete('/me/wallets/:id', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const seller = await getSeller(req.user!.userId);
    const id = String(req.params.id);

    const existing = await prisma.sellerSavedWallet.findFirst({
      where: { id, sellerId: seller.id },
    });
    if (!existing) {
      throw new AppError('المحفظة غير موجودة أو تم حذفها مسبقاً', 404);
    }

    await prisma.sellerSavedWallet.delete({
      where: { id },
    });

    ResponseUtil.success(res, null, 'تم حذف المحفظة بنجاح');
  } catch (error) {
    next(error);
  }
});

// ── GET /me/wallet-providers ────────────────────────────────────────────────────
router.get('/me/wallet-providers', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const providers = WalletProviderRegistry.listSupportedProviders();
    const allProviders = [
      ...providers,
      {
        code: 'BANK_TRANSFER',
        nameAr: 'تحويل بنكي مباشر (IBAN / حساب)',
        nameEn: 'Bank Account / IBAN Transfer',
        merchantWalletNumber: '',
        merchantAccountName: '',
        capabilities: {
          supportsPayment: false,
          supportsVerification: false,
          supportsRefund: false,
          supportsWebhook: false,
          supportsPayout: true,
          supportsWalletTransfer: true,
          supportsManualDeposit: false,
        },
      },
    ];
    ResponseUtil.success(res, allProviders);
  } catch (error) {
    next(error);
  }
});

// ── GET /me/withdrawals ─────────────────────────────────────────────────────────
router.get('/me/withdrawals', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const seller = await getSeller(req.user!.userId);

    const withdrawals = await prisma.withdrawal.findMany({
      where: { sellerId: seller.id },
      include: { savedWallet: true },
      orderBy: { createdAt: 'desc' },
    });

    const mapped = withdrawals.map((w) => ({
      ...w,
      status: (w.status as string).toLowerCase(),
      rawStatus: w.status,
      walletProvider: w.walletProvider || w.savedWallet?.provider || (w.bankName ? 'BANK_TRANSFER' : 'KURAIMI'),
      walletNumberMasked: w.walletNumberMasked || w.savedWallet?.walletNumberMasked || (w.iban ? (w.iban.length > 8 ? w.iban.slice(0, 4) + '****' + w.iban.slice(-4) : w.iban) : ''),
      holderName: w.holderName || w.accountName || w.savedWallet?.holderName || '',
      bankDetails: {
        bankName: w.bankName || '',
        iban: w.iban || '',
        accountName: w.accountName || '',
      },
      proofImageUrl: w.proofImageUrl || null,
      externalRef: w.externalRef || null,
      adminNote: w.adminNote || null,
      rejectionReason: w.rejectionReason || w.adminNote || null,
    }));

    ResponseUtil.success(res, mapped);
  } catch (error) {
    next(error);
  }
});

// ── POST /me/withdrawals ────────────────────────────────────────────────────────
router.post('/me/withdrawals', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const seller = await getSeller(req.user!.userId);
    const { amount, savedWalletId, walletProvider, walletNumber, holderName, bankName, iban, accountName } = req.body;
    const withdrawAmount = parseFloat(amount);

    if (isNaN(withdrawAmount) || withdrawAmount <= 0) {
      throw new AppError('يرجى إدخال مبلغ سحب صحيح', 400);
    }

    const minWithdrawal = 1000; // 1,000 YER minimum
    if (withdrawAmount < minWithdrawal) {
      throw new AppError(`الحد الأدنى لطلب السحب هو ${minWithdrawal} ريال يمني`, 400);
    }

    if (!seller.balance || seller.balance.availableBalance < withdrawAmount) {
      throw new AppError('الرصيد المتاح غير كافٍ لطلب هذا المبلغ', 400);
    }

    let finalProvider = walletProvider;
    let finalMasked = walletNumber;
    let finalFull = walletNumber;
    let finalHolderName = holderName;
    let finalBankName = bankName;
    let finalIban = iban;
    let finalAccountName = accountName;

    if (savedWalletId) {
      const savedWallet = await prisma.sellerSavedWallet.findFirst({
        where: { id: savedWalletId, sellerId: seller.id },
      });
      if (!savedWallet) {
        throw new AppError('المحفظة المحددة غير موجودة', 404);
      }
      finalProvider = savedWallet.provider;
      finalMasked = savedWallet.walletNumberMasked;
      finalFull = savedWallet.walletNumberFull;
      finalHolderName = savedWallet.holderName;
      if (finalProvider === 'BANK_TRANSFER') {
        finalBankName = 'تحويل بنكي';
        finalIban = savedWallet.walletNumberFull || savedWallet.walletNumberMasked;
        finalAccountName = savedWallet.holderName;
      }
    } else if (finalProvider && finalProvider !== 'BANK_TRANSFER' && finalFull) {
      const adapter = WalletProviderRegistry.getAdapter(finalProvider);
      const validation = adapter.validateWalletNumber(finalFull);
      if (!validation.isValid) {
        throw new AppError(validation.error || 'رقم المحفظة غير صالح', 400);
      }
      finalFull = validation.normalized || finalFull.trim();
      finalMasked = adapter.maskWalletNumber(finalFull);
    }

    const currency = (seller.balance.currency && seller.balance.currency !== 'SAR') ? seller.balance.currency : 'YER';

    const withdrawal = await prisma.$transaction(async (tx) => {
      await tx.sellerBalance.update({
        where: { id: seller.balance!.id },
        data: {
          availableBalance: { decrement: withdrawAmount },
          pendingBalance: { increment: withdrawAmount },
        },
      });

      const created = await tx.withdrawal.create({
        data: {
          sellerId: seller.id,
          amount: withdrawAmount,
          currency,
          savedWalletId: savedWalletId || null,
          walletProvider: finalProvider || null,
          walletNumberMasked: finalMasked || null,
          walletNumberFull: finalFull || null,
          holderName: finalHolderName || null,
          bankName: finalBankName || null,
          iban: finalIban || null,
          accountName: finalAccountName || null,
          status: 'PENDING',
        },
      });

      await tx.sellerTransaction.create({
        data: {
          sellerBalanceId: seller.balance!.id,
          amount: -withdrawAmount,
          type: 'WITHDRAWAL',
          referenceId: created.id,
          description: `طلب سحب أرباح إلى ${finalProvider || finalBankName || 'محفظة رقمية'} (${finalMasked || finalIban || ''})`,
        },
      });

      return created;
    });

    SocketService.get()?.emitToUser(req.user!.userId, 'withdrawal:created', withdrawal);
    SocketService.get()?.emitToUser(req.user!.userId, 'seller:finance_updated', { withdrawalId: withdrawal.id });
    SocketService.get()?.emitGlobal('admin:withdrawal_created', withdrawal);
    SocketService.get()?.emitGlobal('withdrawal:created', withdrawal);

    ResponseUtil.created(res, withdrawal, 'تم تقديم طلب السحب بنجاح وسيتم معالجته من قبل الإدارة');
  } catch (error) {
    next(error);
  }
});

// ── POST /me/deposits ───────────────────────────────────────────────────────────
router.post('/me/deposits', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const seller = await getSeller(req.user!.userId);
    const { amount, walletProvider, transferReference, proofImageUrl, senderName, senderPhone } = req.body;

    const parsedAmount = parseFloat(String(amount));
    if (!parsedAmount || isNaN(parsedAmount) || parsedAmount < 500) {
      throw new AppError('الحد الأدنى لطلب الشحن هو 500 ريال يمني', 400);
    }
    if (!walletProvider || typeof walletProvider !== 'string') {
      throw new AppError('يرجى تحديد مزود المحفظة أو البنك المحول منه', 400);
    }
    if (!transferReference || typeof transferReference !== 'string' || !transferReference.trim()) {
      throw new AppError('رقم الحوالة أو مرجع العملية مطلوب', 400);
    }
    if (!proofImageUrl || typeof proofImageUrl !== 'string' || !proofImageUrl.trim()) {
      throw new AppError('صورة سند التحويل أو إشعار الإيداع مطلوبة', 400);
    }

    const deposit = await prisma.walletDeposit.create({
      data: {
        userType: 'SELLER',
        userId: seller.userId,
        sellerId: seller.id,
        amount: parsedAmount,
        currency: 'YER',
        walletProvider: walletProvider.trim().toUpperCase(),
        transferReference: transferReference.trim(),
        proofImageUrl: proofImageUrl.trim(),
        senderName: senderName ? String(senderName).trim() : null,
        senderPhone: senderPhone ? String(senderPhone).trim() : null,
        status: 'PENDING',
      },
    });

    // Real-time broadcast
    SocketService.get()?.emitToUser(seller.userId, 'seller:deposit_created', deposit);
    SocketService.get()?.emitGlobal('admin:deposit_created', deposit);

    ResponseUtil.created(res, deposit, 'تم إرسال طلب شحن رصيد المتجر بنجاح وهو الآن قيد مراجعة الإدارة');
  } catch (error) {
    next(error);
  }
});

// ── GET /me/deposits ────────────────────────────────────────────────────────────
router.get('/me/deposits', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const seller = await getSeller(req.user!.userId);
    const deposits = await prisma.walletDeposit.findMany({
      where: { sellerId: seller.id, userType: 'SELLER' },
      orderBy: { createdAt: 'desc' },
      take: 50,
    });
    ResponseUtil.success(res, deposits);
  } catch (error) {
    next(error);
  }
});

// ── GET /me/platform-deposit-accounts ─────────────────────────────────────────
// Returns active platform wallet accounts for sellers to deposit store balance
router.get('/me/platform-deposit-accounts', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const accounts = await remoteConfigService.getPlatformWalletAccounts('SELLER_DEPOSIT');
    ResponseUtil.success(res, accounts, 'تم استرجاع حسابات منصة سوقناا لإيداع رصيد المتجر بنجاح');
  } catch (error) {
    next(error);
  }
});

// ── GET /me/transactions ────────────────────────────────────────────────────────
router.get('/me/transactions', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const seller = await getSeller(req.user!.userId);
    const page = parseInt(req.query.page as string, 10) || 1;
    const limit = parseInt(req.query.limit as string, 10) || 20;
    const type = req.query.type as string | undefined;

    const where: any = {
      sellerBalanceId: seller.balance!.id,
    };

    if (type && type !== 'ALL') {
      where.type = type as TransactionType;
    }

    const [total, transactions] = await Promise.all([
      prisma.sellerTransaction.count({ where }),
      prisma.sellerTransaction.findMany({
        where,
        skip: (page - 1) * limit,
        take: limit,
        orderBy: { createdAt: 'desc' },
      }),
    ]);

    const mapped = transactions.map((t) => ({
      id: t.id,
      amount: t.amount,
      type: t.type,
      description: t.description,
      referenceId: t.referenceId,
      createdAt: t.createdAt,
      isCredit: t.amount > 0,
      currency: (seller.balance?.currency && seller.balance.currency !== 'SAR') ? seller.balance.currency : 'YER',
    }));

    ResponseUtil.success(res, {
      transactions: mapped,
      pagination: {
        total,
        page,
        limit,
        totalPages: Math.ceil(total / limit),
      },
    });
  } catch (error) {
    next(error);
  }
});

// ── 8. Customers Directory ─────────────────────────────────────────────────────
router.get('/me/customers', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const seller = await getSeller(req.user!.userId);

    const orders = await prisma.sellerOrder.findMany({
      where: { sellerId: seller.id },
      include: {
        order: {
          select: {
            user: { select: { id: true, firstName: true, lastName: true, phone: true, email: true } },
            createdAt: true,
          },
        },
      },
    });

    const customerMap = new Map<string, any>();
    for (const so of orders) {
      const u = so.order.user;
      if (!customerMap.has(u.id)) {
        customerMap.set(u.id, {
          id: u.id,
          name: `${u.firstName} ${u.lastName}`,
          phone: u.phone,
          ordersCount: 1,
          totalSpent: so.sellerPayout,
          lastOrderAt: so.order.createdAt,
        });
      } else {
        const c = customerMap.get(u.id);
        c.ordersCount += 1;
        c.totalSpent += so.sellerPayout;
      }
    }

    ResponseUtil.success(res, Array.from(customerMap.values()));
  } catch (error) {
    next(error);
  }
});

// ── 9. Reviews & Moderation ─────────────────────────────────────────────────
// Old /me/reviews and /me/reviews/:id/reply routes are now replaced by
// the full implementation using ProductReview appended at the bottom of this file.
// They delegate to reviews.service.ts (createSellerResponse etc.)


// ── 10. Notifications ──────────────────────────────────────────────────────────
router.get('/me/notifications', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const page = parseInt(req.query.page as string) || 1;
    const limit = parseInt(req.query.limit as string) || 20;
    const skip = (page - 1) * limit;

    const [notifications, total] = await Promise.all([
      prisma.notification.findMany({
        where: { userId: req.user!.userId },
        orderBy: { createdAt: 'desc' },
        skip,
        take: limit,
      }),
      prisma.notification.count({ where: { userId: req.user!.userId } }),
    ]);

    ResponseUtil.success(res, {
      notifications,
      total,
      page,
      totalPages: Math.ceil(total / limit),
      unreadCount: await prisma.notification.count({ where: { userId: req.user!.userId, isRead: false } }),
    });
  } catch (error) {
    next(error);
  }
});

router.patch('/me/notifications/:id/read', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const id = String(req.params.id);
    await prisma.notification.update({ where: { id, userId: req.user!.userId }, data: { isRead: true } });
    ResponseUtil.success(res, null, 'تم تحديد الإشعار كمقروء');
  } catch (error) {
    next(error);
  }
});

router.patch('/me/notifications/read-all', async (req: Request, res: Response, next: NextFunction) => {
  try {
    await prisma.notification.updateMany({ where: { userId: req.user!.userId, isRead: false }, data: { isRead: true } });
    ResponseUtil.success(res, null, 'تم تحديد جميع الإشعارات كمقروءة');
  } catch (error) {
    next(error);
  }
});

// ── 11. Coupons ─────────────────────────────────────────────────────────────────
router.get('/me/coupons', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const seller = await getSeller(req.user!.userId);
    const storeIds = seller.stores.map((s) => s.id);

    const coupons = await prisma.coupon.findMany({
      where: { storeId: { in: storeIds } } as any,
      orderBy: { createdAt: 'desc' },
    });
    ResponseUtil.success(res, coupons);
  } catch (error) {
    next(error);
  }
});

router.post('/me/coupons', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const seller = await getSeller(req.user!.userId);
    const store = seller.stores[0];
    if (!store) throw new AppError('يجب إنشاء متجر أولاً', 400);

    const { code, discountType, discountValue, minOrderValue, maxDiscount, usageLimit, validFrom, validUntil } = req.body;

    const coupon = await prisma.coupon.create({
      data: {
        code: (code as string).toUpperCase(),
        discountType: discountType || 'PERCENTAGE',
        discountValue: parseFloat(discountValue),
        minOrderValue: minOrderValue ? parseFloat(minOrderValue) : null,
        maxDiscount: maxDiscount ? parseFloat(maxDiscount) : null,
        usageLimit: usageLimit ? parseInt(usageLimit) : null,
        validFrom: new Date(validFrom),
        validUntil: new Date(validUntil),
        isActive: true,
        storeId: store.id,
      } as any,
    });

    ResponseUtil.created(res, coupon, 'تم إنشاء الكوبون بنجاح');
  } catch (error) {
    next(error);
  }
});

router.patch('/me/coupons/:id', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const seller = await getSeller(req.user!.userId);
    const storeIds = seller.stores.map((s) => s.id);
    const id = String(req.params.id);

    const coupon = await prisma.coupon.findFirst({ where: { id, storeId: { in: storeIds } } as any });
    if (!coupon) throw new AppError('الكوبون غير موجود', 404);

    const { discountValue, minOrderValue, maxDiscount, usageLimit, validFrom, validUntil, isActive } = req.body;

    const updated = await prisma.coupon.update({
      where: { id },
      data: {
        discountValue: discountValue !== undefined ? parseFloat(discountValue) : undefined,
        minOrderValue: minOrderValue !== undefined ? parseFloat(minOrderValue) : undefined,
        maxDiscount: maxDiscount !== undefined ? parseFloat(maxDiscount) : undefined,
        usageLimit: usageLimit !== undefined ? parseInt(usageLimit) : undefined,
        validFrom: validFrom ? new Date(validFrom) : undefined,
        validUntil: validUntil ? new Date(validUntil) : undefined,
        isActive: isActive !== undefined ? isActive : undefined,
      },
    });

    ResponseUtil.success(res, updated, 'تم تعديل الكوبون بنجاح');
  } catch (error) {
    next(error);
  }
});

router.delete('/me/coupons/:id', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const seller = await getSeller(req.user!.userId);
    const storeIds = seller.stores.map((s) => s.id);
    const id = String(req.params.id);

    const coupon = await prisma.coupon.findFirst({ where: { id, storeId: { in: storeIds } } as any });
    if (!coupon) throw new AppError('الكوبون غير موجود', 404);

    await prisma.coupon.delete({ where: { id } });
    ResponseUtil.success(res, null, 'تم حذف الكوبون بنجاح');
  } catch (error) {
    next(error);
  }
});

// ── 12. Analytics with date period ─────────────────────────────────────────────
router.get('/me/analytics', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const seller = await getSeller(req.user!.userId);
    const storeIds = seller.stores.map((s) => s.id);
    const period = (req.query.period as string) || '30d';

    let fromDate = new Date();
    if (period === '7d') fromDate.setDate(fromDate.getDate() - 7);
    else if (period === '30d') fromDate.setDate(fromDate.getDate() - 30);
    else if (period === 'today') fromDate.setHours(0, 0, 0, 0);
    else if (req.query.from) fromDate = new Date(req.query.from as string);

    const toDate = req.query.to ? new Date(req.query.to as string) : new Date();

    const [orders, topProducts, totalProductsCount] = await Promise.all([
      prisma.sellerOrder.findMany({
        where: { sellerId: seller.id, createdAt: { gte: fromDate, lte: toDate } },
        select: { createdAt: true, sellerPayout: true, subtotal: true, status: true, commissionAmount: true },
        orderBy: { createdAt: 'asc' },
      }),
      prisma.orderItem.groupBy({
        by: ['productId'],
        where: { sellerOrder: { sellerId: seller.id, createdAt: { gte: fromDate, lte: toDate } } },
        _sum: { quantity: true, totalPrice: true },
        orderBy: { _sum: { totalPrice: 'desc' } },
        take: 10,
      }),
      prisma.product.count({ where: { storeId: { in: storeIds } } }),
    ]);

    const totalRevenue = orders.reduce((sum: number, o: { sellerPayout: number }) => sum + (o.sellerPayout || 0), 0);
    const totalOrders = orders.length;
    const aov = totalOrders > 0 ? totalRevenue / totalOrders : 0;

    // Group by date for chart
    const dailyMap = new Map<string, { date: string; revenue: number; orders: number }>();
    for (const o of orders) {
      const dateKey = o.createdAt.toISOString().split('T')[0];
      const existing = dailyMap.get(dateKey) || { date: dateKey, revenue: 0, orders: 0 };
      existing.revenue += o.sellerPayout || 0;
      existing.orders += 1;
      dailyMap.set(dateKey, existing);
    }

    ResponseUtil.success(res, {
      summary: { totalRevenue, totalOrders, aov, totalProducts: totalProductsCount },
      chartData: Array.from(dailyMap.values()),
      topProducts,
    });
  } catch (error) {
    next(error);
  }
});

// ── 13. Product Images ──────────────────────────────────────────────────────────
router.post('/me/products/:id/images', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const seller = await getSeller(req.user!.userId);
    const id = String(req.params.id);
    const storeIds = seller.stores.map((s) => s.id);

    const product = await prisma.product.findFirst({ where: { id, storeId: { in: storeIds } } });
    if (!product) throw new AppError('المنتج غير موجود', 404);

    const { urls } = req.body; // Array of URLs from upload service
    if (!Array.isArray(urls) || urls.length === 0) throw new AppError('يجب إرسال روابط الصور', 400);

    const currentCount = await prisma.productImage.count({ where: { productId: id } });

    await prisma.productImage.createMany({
      data: urls.map((url: string, i: number) => ({
        productId: id,
        url,
        isPrimary: currentCount === 0 && i === 0,
        sortOrder: currentCount + i,
      })),
    });

    const images = await prisma.productImage.findMany({ where: { productId: id }, orderBy: { sortOrder: 'asc' } });
    ResponseUtil.success(res, images, 'تم رفع الصور بنجاح');
  } catch (error) {
    next(error);
  }
});

router.delete('/me/products/:id/images/:imageId', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const seller = await getSeller(req.user!.userId);
    const storeIds = seller.stores.map((s) => s.id);
    const productId = String(req.params.id);
    const imageId = String(req.params.imageId);

    const product = await prisma.product.findFirst({ where: { id: productId, storeId: { in: storeIds } } });
    if (!product) throw new AppError('المنتج غير موجود', 404);

    await prisma.productImage.delete({ where: { id: imageId } });
    ResponseUtil.success(res, null, 'تم حذف الصورة بنجاح');
  } catch (error) {
    next(error);
  }
});

router.patch('/me/products/:id/images/reorder', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const seller = await getSeller(req.user!.userId);
    const storeIds = seller.stores.map((s) => s.id);
    const productId = String(req.params.id);

    const product = await prisma.product.findFirst({ where: { id: productId, storeId: { in: storeIds } } });
    if (!product) throw new AppError('المنتج غير موجود', 404);

    const { order } = req.body; // Array of { id, sortOrder }
    await Promise.all(
      (order as { id: string; sortOrder: number }[]).map((item) =>
        prisma.productImage.update({ where: { id: item.id }, data: { sortOrder: item.sortOrder } })
      )
    );

    ResponseUtil.success(res, null, 'تم تحديث ترتيب الصور بنجاح');
  } catch (error) {
    next(error);
  }
});

// ── 14. Product Variants ────────────────────────────────────────────────────────
router.post('/me/products/:id/variants', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const seller = await getSeller(req.user!.userId);
    const storeIds = seller.stores.map((s) => s.id);
    const productId = String(req.params.id);

    const product = await prisma.product.findFirst({ where: { id: productId, storeId: { in: storeIds } } });
    if (!product) throw new AppError('المنتج غير موجود', 404);

    const { nameAr, nameEn, sku, price, compareAtPrice, stockQuantity, image } = req.body;

    const variant = await prisma.productVariant.create({
      data: {
        productId,
        nameAr: nameAr || product.nameAr,
        nameEn: nameEn || product.nameEn,
        sku: sku || null,
        price: price !== undefined ? parseFloat(price) : product.price,
        compareAtPrice: compareAtPrice ? parseFloat(compareAtPrice) : null,
        stockQuantity: stockQuantity ? parseInt(stockQuantity) : 0,
        image: image || null,
      },
    });

    ResponseUtil.created(res, variant, 'تم إضافة المتغير بنجاح');
  } catch (error) {
    next(error);
  }
});

router.patch('/me/products/:id/variants/:variantId', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const seller = await getSeller(req.user!.userId);
    const storeIds = seller.stores.map((s) => s.id);
    const productId = String(req.params.id);
    const variantId = String(req.params.variantId);

    const product = await prisma.product.findFirst({ where: { id: productId, storeId: { in: storeIds } } });
    if (!product) throw new AppError('المنتج غير موجود', 404);

    const { nameAr, nameEn, sku, price, compareAtPrice, stockQuantity, image } = req.body;

    const updated = await prisma.productVariant.update({
      where: { id: variantId },
      data: {
        nameAr: nameAr ?? undefined,
        nameEn: nameEn ?? undefined,
        sku: sku ?? undefined,
        price: price !== undefined ? parseFloat(price) : undefined,
        compareAtPrice: compareAtPrice !== undefined ? parseFloat(compareAtPrice) : undefined,
        stockQuantity: stockQuantity !== undefined ? parseInt(stockQuantity) : undefined,
        image: image ?? undefined,
      },
    });

    ResponseUtil.success(res, updated, 'تم تعديل المتغير بنجاح');
  } catch (error) {
    next(error);
  }
});

router.delete('/me/products/:id/variants/:variantId', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const seller = await getSeller(req.user!.userId);
    const storeIds = seller.stores.map((s) => s.id);
    const productId = String(req.params.id);
    const variantId = String(req.params.variantId);

    const product = await prisma.product.findFirst({ where: { id: productId, storeId: { in: storeIds } } });
    if (!product) throw new AppError('المنتج غير موجود', 404);

    await prisma.productVariant.delete({ where: { id: variantId } });
    ResponseUtil.success(res, null, 'تم حذف المتغير بنجاح');
  } catch (error) {
    next(error);
  }
});

// ── 15. Order State Machine (single unified endpoint) ──────────────────────────
router.patch('/me/orders/:id/status', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const seller = await getSeller(req.user!.userId);
    const id = String(req.params.id);
    const { status: newStatus, note, reason } = req.body;

    const result = await OrderStateMachine.transitionSellerOrder({
      sellerOrderId: id,
      targetStatus: newStatus as SellerOrderStatus,
      changedBy: req.user!.userId,
      changedByRole: 'SELLER',
      reason,
      note,
    });
    ResponseUtil.success(res, result.sellerOrder, 'تم تحديث حالة الطلب بنجاح');
  } catch (error) {
    next(error);
  }
});

// ── 16. Order Detail ────────────────────────────────────────────────────────────
router.get('/me/orders/:id', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const seller = await getSeller(req.user!.userId);
    const id = String(req.params.id);

    const sellerOrder = await prisma.sellerOrder.findFirst({
      where: { id, sellerId: seller.id },
      include: {
        order: {
          include: {
            user: { select: { firstName: true, lastName: true, phone: true, email: true } },
            addressSnapshot: true,
            deliveryTimeSlot: true,
            slotBooking: { include: { timeSlot: true } },
            payment: true,
          },
        },
        items: {
          include: {
            product: { select: { nameAr: true, nameEn: true, images: { take: 1, orderBy: { sortOrder: 'asc' } } } },
            variant: { select: { nameAr: true, nameEn: true } },
          },
        },
        deliveryMethod: true,
        deliveryQuoteSnapshot: true,
      },
    });

    if (!sellerOrder) throw new AppError('الطلب غير موجود', 404);

    ResponseUtil.success(res, sellerOrder);
  } catch (error) {
    next(error);
  }
});

// ── 17. Flash Sales (available campaigns) ──────────────────────────────────────
router.get('/me/flash-sales', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const now = new Date();
    const flashSales = await prisma.flashSale.findMany({
      where: { isActive: true, endsAt: { gte: now } },
      include: { products: { select: { productId: true } } },
      orderBy: { startsAt: 'asc' },
    });
    ResponseUtil.success(res, flashSales);
  } catch (error) {
    next(error);
  }
});

router.post('/me/flash-sales/:flashSaleId/products', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const seller = await getSeller(req.user!.userId);
    const storeIds = seller.stores.map((s) => s.id);
    const flashSaleId = String(req.params.flashSaleId);
    const { productId, discountPrice, limitPerUser } = req.body;

    const product = await prisma.product.findFirst({ where: { id: productId, storeId: { in: storeIds } } });
    if (!product) throw new AppError('المنتج غير موجود', 404);

    const flashSale = await prisma.flashSale.findUnique({ where: { id: flashSaleId } });
    if (!flashSale || !flashSale.isActive) throw new AppError('حملة Flash Sale غير موجودة أو منتهية', 404);

    const parsedDiscountPrice = parseFloat(discountPrice);
    if (parsedDiscountPrice >= product.price) {
      throw new AppError('سعر البيع في Flash Sale يجب أن يكون أقل من السعر الأصلي', 400);
    }

    const discountPercent = Math.round(((product.price - parsedDiscountPrice) / product.price) * 100);

    const item = await prisma.flashSaleProduct.create({
      data: {
        flashSaleId,
        productId,
        discountPrice: parsedDiscountPrice,
        discountPercent,
        limitPerUser: limitPerUser ? parseInt(limitPerUser) : 1,
      },
    });

    ResponseUtil.created(res, item, 'تم إضافة منتجك إلى حملة Flash Sale');
  } catch (error) {
    next(error);
  }
});

// ══════════════════════════════════════════════════════════════════════════════
// SELLER REVIEWS  (protected by authenticate + requireSeller via router.use)
// ══════════════════════════════════════════════════════════════════════════════

// GET /api/v1/sellers/me/reviews/stats — aggregated stats for seller dashboard
router.get('/me/reviews/stats', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const seller = await getSeller(req.user!.userId);
    const { ReviewStatus } = await import('@prisma/client');

    const [total, published, pending, avgAgg, verified, withResponse, distribution] = await Promise.all([
      prisma.productReview.count({ where: { sellerId: seller.id, status: { not: ReviewStatus.DELETED } } }),
      prisma.productReview.count({ where: { sellerId: seller.id, status: ReviewStatus.PUBLISHED } }),
      prisma.productReview.count({ where: { sellerId: seller.id, status: ReviewStatus.PENDING } }),
      prisma.productReview.aggregate({ where: { sellerId: seller.id, status: ReviewStatus.PUBLISHED }, _avg: { rating: true } }),
      prisma.productReview.count({ where: { sellerId: seller.id, status: ReviewStatus.PUBLISHED, verifiedPurchase: true } }),
      prisma.productReview.count({ where: { sellerId: seller.id, status: ReviewStatus.PUBLISHED, sellerResponseExists: false } }),
      prisma.productReview.groupBy({
        by: ['rating'],
        where: { sellerId: seller.id, status: ReviewStatus.PUBLISHED },
        _count: { id: true },
      }),
    ]);

    const dist = new Map(distribution.map((d) => [d.rating, d._count.id]));

    ResponseUtil.success(res, {
      totalReviews: total,
      publishedReviews: published,
      pendingReviews: pending,
      averageRating: avgAgg._avg.rating ? parseFloat(avgAgg._avg.rating.toFixed(2)) : 0,
      verifiedReviews: verified,
      unansweredReviews: withResponse,
      distribution: { 1: dist.get(1) ?? 0, 2: dist.get(2) ?? 0, 3: dist.get(3) ?? 0, 4: dist.get(4) ?? 0, 5: dist.get(5) ?? 0 },
    });
  } catch (error) {
    next(error);
  }
});

// GET /api/v1/sellers/me/reviews — paginated review list
router.get('/me/reviews', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const seller = await getSeller(req.user!.userId);
    const { ReviewStatus, ReviewMediaModerationStatus, ReviewSellerResponseStatus } = await import('@prisma/client');

    const page = parseInt(req.query.page as string, 10) || 1;
    const limit = Math.min(parseInt(req.query.limit as string, 10) || 20, 50);
    const skip = (page - 1) * limit;
    const rating = req.query.rating ? parseInt(req.query.rating as string, 10) : undefined;
    const verified = req.query.verified === 'true' ? true : req.query.verified === 'false' ? false : undefined;
    const unanswered = req.query.unanswered === 'true';
    const search = (req.query.search as string)?.trim();

    const where: any = {
      sellerId: seller.id,
      status: ReviewStatus.PUBLISHED,
    };
    if (rating) where.rating = rating;
    if (verified !== undefined) where.verifiedPurchase = verified;
    if (unanswered) where.sellerResponseExists = false;
    if (search) {
      where.OR = [
        { title: { contains: search, mode: 'insensitive' } },
        { body: { contains: search, mode: 'insensitive' } },
      ];
    }

    const [total, reviews] = await Promise.all([
      prisma.productReview.count({ where }),
      prisma.productReview.findMany({
        where,
        skip,
        take: limit,
        orderBy: { createdAt: 'desc' },
        select: {
          id: true,
          productId: true,
          rating: true,
          title: true,
          body: true,
          verifiedPurchase: true,
          status: true,
          helpfulCount: true,
          reportCount: true,
          sellerResponseExists: true,
          createdAt: true,
          user: { select: { firstName: true, lastName: true, avatar: true } },
          product: { select: { id: true, nameAr: true, nameEn: true, images: { where: { isPrimary: true }, take: 1, select: { url: true } } } },
          media: {
            where: { moderationStatus: ReviewMediaModerationStatus.APPROVED },
            select: { id: true, mediaType: true, url: true, thumbnailUrl: true, sortOrder: true },
            orderBy: { sortOrder: 'asc' },
          },
          sellerResponse: {
            where: { status: ReviewSellerResponseStatus.PUBLISHED },
            select: { id: true, body: true, createdAt: true, updatedAt: true },
          },
        },
      }),
    ]);

    ResponseUtil.success(res, {
      reviews,
      pagination: { total, page, limit, totalPages: Math.ceil(total / limit) },
    });
  } catch (error) {
    next(error);
  }
});

// POST /api/v1/sellers/me/reviews/:reviewId/reply  (legacy compat)
router.post('/me/reviews/:reviewId/reply', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const reviewId = String(req.params.reviewId);
    const { reply } = req.body;
    if (!reply?.trim()) throw new AppError('نص الرد مطلوب', 400);

    const seller = await getSeller(req.user!.userId);
    const { createSellerResponse: createResp } = await import('../reviews/reviews.service');
    const response = await createResp(reviewId, seller.id, reply);
    ResponseUtil.created(res, response, 'تم نشر ردك بنجاح');
  } catch (error) {
    next(error);
  }
});

// ── Store Enhancement: Banner & Logo Management ──────────────────────────────────
// GET  /api/v1/sellers/me/store/enhancement
router.get('/me/store/enhancement', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const seller = await getSeller(req.user!.userId);
    const store = seller.stores[0];
    if (!store) throw new AppError('لا يوجد متجر مسجل', 404);

    const enhancement = await prisma.storeEnhancement.findUnique({
      where: { storeId: store.id },
    });

    ResponseUtil.success(res, enhancement ?? {
      storeId: store.id,
      bannerDesktop: null, bannerTablet: null, bannerMobile: null,
      bannerTitleAr: null, bannerTitleEn: null,
      bannerSubtitleAr: null, bannerSubtitleEn: null,
      bannerCtaTextAr: null, bannerCtaTextEn: null, bannerCtaUrl: null,
      logoOriginal: store.logo, logoThumbnail: null, logoSmall: null, logoMedium: null,
      followerCount: 0, followingCount: 0,
      joinedDate: store.createdAt,
      responseRate: null, responseTimeMinutes: null,
      totalSoldCount: 0,
    });
  } catch (error) {
    next(error);
  }
});

// PATCH /api/v1/sellers/me/store/enhancement  — Update text fields / CTA
router.patch('/me/store/enhancement', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const seller = await getSeller(req.user!.userId);
    const store = seller.stores[0];
    if (!store) throw new AppError('لا يوجد متجر مسجل', 404);

    const {
      bannerTitleAr, bannerTitleEn, bannerSubtitleAr, bannerSubtitleEn,
      bannerCtaTextAr, bannerCtaTextEn, bannerCtaUrl,
      responseRate, responseTimeMinutes,
    } = req.body;

    const enhancement = await prisma.storeEnhancement.upsert({
      where: { storeId: store.id },
      update: {
        ...(bannerTitleAr !== undefined && { bannerTitleAr }),
        ...(bannerTitleEn !== undefined && { bannerTitleEn }),
        ...(bannerSubtitleAr !== undefined && { bannerSubtitleAr }),
        ...(bannerSubtitleEn !== undefined && { bannerSubtitleEn }),
        ...(bannerCtaTextAr !== undefined && { bannerCtaTextAr }),
        ...(bannerCtaTextEn !== undefined && { bannerCtaTextEn }),
        ...(bannerCtaUrl !== undefined && { bannerCtaUrl }),
        ...(responseRate !== undefined && { responseRate: parseFloat(responseRate) }),
        ...(responseTimeMinutes !== undefined && { responseTimeMinutes: parseInt(responseTimeMinutes, 10) }),
      },
      create: {
        storeId: store.id,
        bannerTitleAr, bannerTitleEn, bannerSubtitleAr, bannerSubtitleEn,
        bannerCtaTextAr, bannerCtaTextEn, bannerCtaUrl,
        responseRate: responseRate ? parseFloat(responseRate) : null,
        responseTimeMinutes: responseTimeMinutes ? parseInt(responseTimeMinutes, 10) : null,
      },
    });

    // Invalidate storefront cache
    await Promise.all([
      redis.del(`storefront:${store.slug}`),
      redis.del(`storefront:${store.id}`),
    ]);

    ResponseUtil.success(res, enhancement, 'تم تحديث بيانات المتجر المحسّن بنجاح');
  } catch (error) {
    next(error);
  }
});

// POST /api/v1/sellers/me/store/banner — Upload banner image
// Accepts: device=desktop|tablet|mobile, imageUrl (pre-uploaded R2 URL or multipart)
router.post('/me/store/banner', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const seller = await getSeller(req.user!.userId);
    const store = seller.stores[0];
    if (!store) throw new AppError('لا يوجد متجر مسجل', 404);

    const { device = 'desktop', imageUrl } = req.body;
    if (!imageUrl) throw new AppError('imageUrl مطلوب', 400);
    if (!['desktop', 'tablet', 'mobile'].includes(device)) {
      throw new AppError('device يجب أن يكون: desktop, tablet, mobile', 400);
    }

    const fieldMap: Record<string, any> = {
      desktop: { bannerDesktop: imageUrl },
      tablet:  { bannerTablet: imageUrl },
      mobile:  { bannerMobile: imageUrl },
    };

    const enhancement = await prisma.storeEnhancement.upsert({
      where: { storeId: store.id },
      update: fieldMap[device],
      create: { storeId: store.id, ...fieldMap[device] },
    });

    await Promise.all([
      redis.del(`storefront:${store.slug}`),
      redis.del(`storefront:${store.id}`),
    ]);

    ResponseUtil.success(res, enhancement, `تم تحديث البانر (${device}) بنجاح`);
  } catch (error) {
    next(error);
  }
});

// DELETE /api/v1/sellers/me/store/banner/:device — Remove banner image
router.delete('/me/store/banner/:device', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const seller = await getSeller(req.user!.userId);
    const store = seller.stores[0];
    if (!store) throw new AppError('لا يوجد متجر مسجل', 404);

    const device = String(req.params.device);
    if (!['desktop', 'tablet', 'mobile'].includes(device)) {
      throw new AppError('device غير صحيح', 400);
    }

    const fieldMap: Record<string, any> = {
      desktop: { bannerDesktop: null },
      tablet:  { bannerTablet: null },
      mobile:  { bannerMobile: null },
    };

    await prisma.storeEnhancement.upsert({
      where: { storeId: store.id },
      update: fieldMap[device],
      create: { storeId: store.id },
    });

    await Promise.all([
      redis.del(`storefront:${store.slug}`),
      redis.del(`storefront:${store.id}`),
    ]);

    ResponseUtil.success(res, null, `تم حذف البانر (${device}) بنجاح`);
  } catch (error) {
    next(error);
  }
});

// POST /api/v1/sellers/me/store/logo — Upload logo (multi-size URLs provided by client after R2 upload)
// Expects: { logoOriginal, logoThumbnail, logoSmall, logoMedium } — all R2 URLs
// The Flutter seller app uploads to R2 first (via /upload endpoint), then calls this endpoint.
router.post('/me/store/logo', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const seller = await getSeller(req.user!.userId);
    const store = seller.stores[0];
    if (!store) throw new AppError('لا يوجد متجر مسجل', 404);

    const { logoOriginal, logoThumbnail, logoSmall, logoMedium } = req.body;
    if (!logoOriginal) throw new AppError('logoOriginal مطلوب', 400);

    const enhancement = await prisma.storeEnhancement.upsert({
      where: { storeId: store.id },
      update: {
        ...(logoOriginal   && { logoOriginal }),
        ...(logoThumbnail  && { logoThumbnail }),
        ...(logoSmall      && { logoSmall }),
        ...(logoMedium     && { logoMedium }),
      },
      create: {
        storeId: store.id,
        logoOriginal,
        logoThumbnail: logoThumbnail ?? null,
        logoSmall: logoSmall ?? null,
        logoMedium: logoMedium ?? null,
      },
    });

    // Update the main store logo field with the medium variant for backward compat
    await prisma.store.update({
      where: { id: store.id },
      data: { logo: logoMedium ?? logoSmall ?? logoOriginal },
    });

    await Promise.all([
      redis.del(`storefront:${store.slug}`),
      redis.del(`storefront:${store.id}`),
    ]);

    ResponseUtil.success(res, enhancement, 'تم تحديث شعار المتجر بنجاح');
  } catch (error) {
    next(error);
  }
});

// DELETE /api/v1/sellers/me/store/logo — Remove logo
router.delete('/me/store/logo', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const seller = await getSeller(req.user!.userId);
    const store = seller.stores[0];
    if (!store) throw new AppError('لا يوجد متجر مسجل', 404);

    await prisma.storeEnhancement.upsert({
      where: { storeId: store.id },
      update: { logoOriginal: null, logoThumbnail: null, logoSmall: null, logoMedium: null },
      create: { storeId: store.id },
    });

    await prisma.store.update({ where: { id: store.id }, data: { logo: null } });

    await Promise.all([
      redis.del(`storefront:${store.slug}`),
      redis.del(`storefront:${store.id}`),
    ]);

    ResponseUtil.success(res, null, 'تم حذف شعار المتجر بنجاح');
  } catch (error) {
    next(error);
  }
});

export const sellerRoutes = router;


