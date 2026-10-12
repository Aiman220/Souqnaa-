import { Router, Request, Response, NextFunction } from 'express';
import { prisma } from '../../database/prisma';
import { authenticate } from '../../middleware/auth.middleware';
import { ResponseUtil } from '../../utils/response.util';
import { AppError } from '../../middleware/error.middleware';

const router = Router();
router.use(authenticate);

router.get('/', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const addresses = await prisma.address.findMany({
      where: { userId: req.user!.userId },
      include: {
        city: true,
        district: true,
        neighborhood: true,
      },
      orderBy: { isDefault: 'desc' },
    });
    ResponseUtil.success(res, addresses);
  } catch (error) {
    next(error);
  }
});

router.post('/', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const {
      type,
      recipientName,
      recipientPhone,
      phone,
      street,
      addressLine1,
      buildingNumber,
      building,
      apartmentNumber,
      floorNumber,
      postalCode,
      cityId,
      city,
      districtId,
      neighborhoodId,
      latitude,
      longitude,
      isDefault,
    } = req.body;

    let targetCityId = cityId;
    if (!targetCityId && city) {
      const matchedCity = await prisma.city.findFirst({
        where: {
          OR: [
            { id: String(city) },
            { nameAr: { contains: String(city), mode: 'insensitive' } },
            { nameEn: { contains: String(city), mode: 'insensitive' } },
          ],
        },
      });
      if (matchedCity) targetCityId = matchedCity.id;
    }

    if (!targetCityId) {
      const firstCity = await prisma.city.findFirst({ where: { isActive: true } });
      if (firstCity) targetCityId = firstCity.id;
    }

    if (isDefault) {
      await prisma.address.updateMany({
        where: { userId: req.user!.userId },
        data: { isDefault: false },
      });
    }

    let parsedType: any = 'HOME';
    const tStr = String(type || '').toUpperCase();
    if (tStr.includes('WORK')) parsedType = 'WORK';
    else if (tStr.includes('OTHER')) parsedType = 'OTHER';

    const address = await prisma.address.create({
      data: {
        userId: req.user!.userId,
        type: parsedType,
        recipientName: recipientName || 'المستلم',
        recipientPhone: recipientPhone || phone || '0500000000',
        street: street || addressLine1 || 'الشارع العام',
        buildingNumber: buildingNumber || building,
        apartmentNumber,
        floorNumber,
        postalCode,
        cityId: targetCityId,
        districtId: districtId || null,
        neighborhoodId: neighborhoodId || null,
        latitude: latitude ? parseFloat(String(latitude)) : null,
        longitude: longitude ? parseFloat(String(longitude)) : null,
        isDefault: isDefault ?? false,
      },
      include: { city: true, district: true, neighborhood: true },
    });

    ResponseUtil.created(res, address, 'Address added successfully');
  } catch (error) {
    next(error);
  }
});

router.get('/:id', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const id = String(req.params.id);
    const address = await prisma.address.findFirst({
      where: { id, userId: req.user!.userId },
      include: { city: true, district: true, neighborhood: true },
    });
    if (!address) throw new AppError('Address not found', 404);
    ResponseUtil.success(res, address);
  } catch (error) {
    next(error);
  }
});

router.put('/:id', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const id = String(req.params.id);
    const { isDefault, type, recipientPhone, phone, ...data } = req.body;

    if (isDefault) {
      await prisma.address.updateMany({
        where: { userId: req.user!.userId },
        data: { isDefault: false },
      });
    }

    let parsedType: any = undefined;
    if (type) {
      const tStr = String(type).toUpperCase();
      if (tStr.includes('WORK')) parsedType = 'WORK';
      else if (tStr.includes('OTHER')) parsedType = 'OTHER';
      else parsedType = 'HOME';
    }

    const updateData: any = {
      ...data,
      ...(recipientPhone || phone ? { recipientPhone: recipientPhone || phone } : {}),
      ...(parsedType ? { type: parsedType } : {}),
      ...(isDefault !== undefined ? { isDefault } : {}),
    };

    const address = await prisma.address.update({
      where: { id },
      data: updateData,
      include: { city: true, district: true, neighborhood: true },
    });

    ResponseUtil.success(res, address, 'Address updated successfully');
  } catch (error) {
    next(error);
  }
});

router.delete('/:id', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const id = String(req.params.id);
    await prisma.address.delete({
      where: { id },
    });
    ResponseUtil.success(res, null, 'Address deleted successfully');
  } catch (error) {
    next(error);
  }
});

const setDefaultHandler = async (req: Request, res: Response, next: NextFunction) => {
  try {
    const id = String(req.params.id);
    await prisma.address.updateMany({
      where: { userId: req.user!.userId },
      data: { isDefault: false },
    });

    const address = await prisma.address.update({
      where: { id },
      data: { isDefault: true },
    });

    ResponseUtil.success(res, address, 'Default address set');
  } catch (error) {
    next(error);
  }
};

router.patch('/:id/default', setDefaultHandler);
router.post('/:id/default', setDefaultHandler);

export const addressRoutes = router;
