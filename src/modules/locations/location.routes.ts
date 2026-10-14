import { Router, Request, Response, NextFunction } from 'express';
import { prisma } from '../../database/prisma';
import { ResponseUtil } from '../../utils/response.util';
import { AppError } from '../../middleware/error.middleware';
import { geoService } from '../../services/geo/geo.service';
import { config } from '../../config';

const router = Router();

// ──────────────────────────────────────────────────────────────────────────────
// Geographic lookup endpoints (no auth required — public data)
// ──────────────────────────────────────────────────────────────────────────────

router.get('/countries', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const countries = await prisma.country.findMany({
      where: { isActive: true },
      include: { cities: { where: { isActive: true } } },
    });
    ResponseUtil.success(res, countries);
  } catch (error) {
    next(error);
  }
});

router.get('/cities', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const { countryId } = req.query;
    const cities = await prisma.city.findMany({
      where: {
        isActive: true,
        ...(countryId ? { countryId: String(countryId) } : {}),
      },
      include: { districts: { where: { isActive: true } } },
    });
    ResponseUtil.success(res, cities);
  } catch (error) {
    next(error);
  }
});

router.get('/districts', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const { cityId } = req.query;
    const districts = await prisma.district.findMany({
      where: {
        isActive: true,
        ...(cityId ? { cityId: String(cityId) } : {}),
      },
      include: { neighborhoods: { where: { isActive: true } } },
    });
    ResponseUtil.success(res, districts);
  } catch (error) {
    next(error);
  }
});

router.get('/neighborhoods', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const { districtId } = req.query;
    const neighborhoods = await prisma.neighborhood.findMany({
      where: {
        isActive: true,
        ...(districtId ? { districtId: String(districtId) } : {}),
      },
    });
    ResponseUtil.success(res, neighborhoods);
  } catch (error) {
    next(error);
  }
});

// ──────────────────────────────────────────────────────────────────────────────
// GET /api/v1/locations/geocode — forward geocoding (text → coordinates)
// §7: Implement debouncing hint via Cache-Control header
// §38: Uses Geoapify (proper provider), not public Nominatim
// ──────────────────────────────────────────────────────────────────────────────

router.get('/geocode', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const { q, limit = '5', lang = 'ar' } = req.query;

    if (!q || String(q).trim().length < 2) {
      throw new AppError('Query parameter "q" must be at least 2 characters', 400);
    }

    const queryStr = String(q).trim();

    if (geoService.isConfigured()) {
      const results = await geoService.geocoding().geocode(queryStr, {
        limit: Math.min(parseInt(String(limit), 10) || 5, 10),
        lang: String(lang),
      });

      res.setHeader('Cache-Control', 'public, max-age=300, stale-while-revalidate=60');
      return ResponseUtil.success(res, results);
    }

    // Local Database Fallback Search
    const cities = await prisma.city.findMany({
      where: {
        OR: [
          { nameAr: { contains: queryStr, mode: 'insensitive' } },
          { nameEn: { contains: queryStr, mode: 'insensitive' } },
        ],
      },
      take: 5,
    });

    if (cities.length > 0) {
      const results = cities.map((c) => ({
        formattedAddress: `${c.nameAr}، اليمن`,
        lat: c.latitude ?? 15.3694,
        lng: c.longitude ?? 44.1910,
        country: 'اليمن',
        countryCode: 'YE',
        city: c.nameAr,
        confidence: 0.9,
      }));
      return ResponseUtil.success(res, results);
    }

    // Built-in Yemeni major cities fallback
    const defaultCities = [
      { nameAr: 'صنعاء', nameEn: 'Sanaa', lat: 15.3694, lng: 44.1910 },
      { nameAr: 'عدن', nameEn: 'Aden', lat: 12.7855, lng: 45.0187 },
      { nameAr: 'تعز', nameEn: 'Taiz', lat: 13.5776, lng: 44.0175 },
      { nameAr: 'الحديدة', nameEn: 'Hodeidah', lat: 14.7978, lng: 42.9545 },
      { nameAr: 'إب', nameEn: 'Ibb', lat: 13.9667, lng: 44.1833 },
      { nameAr: 'المكلا', nameEn: 'Mukalla', lat: 14.5425, lng: 49.1242 },
      { nameAr: 'ذمار', nameEn: 'Dhamar', lat: 14.5427, lng: 44.4051 },
      { nameAr: 'سيئون', nameEn: 'Sayun', lat: 15.9389, lng: 48.7881 },
      { nameAr: 'مأرب', nameEn: 'Marib', lat: 15.4608, lng: 45.3242 },
    ];

    const matched = defaultCities.filter(
      (c) => c.nameAr.includes(queryStr) || c.nameEn.toLowerCase().includes(queryStr.toLowerCase())
    );

    const fallbackResults = (matched.length > 0 ? matched : [defaultCities[0]]).map((c) => ({
      formattedAddress: `${c.nameAr}، اليمن`,
      lat: c.lat,
      lng: c.lng,
      country: 'اليمن',
      countryCode: 'YE',
      city: c.nameAr,
      confidence: 0.8,
    }));

    return ResponseUtil.success(res, fallbackResults);

  } catch (error) {
    next(error);
  }
});

// ──────────────────────────────────────────────────────────────────────────────
// GET /api/v1/locations/reverse-geocode — reverse geocoding (lat/lng → address)
// Replaces the mock implementation with real Geoapify call
// §6: Returns structured address info to assist the customer
// ──────────────────────────────────────────────────────────────────────────────

router.get('/reverse-geocode', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const { lat, lng, lang = 'ar' } = req.query;

    const latNum = parseFloat(String(lat));
    const lngNum = parseFloat(String(lng));

    if (isNaN(latNum) || isNaN(lngNum) || latNum < -90 || latNum > 90 || lngNum < -180 || lngNum > 180) {
      throw new AppError('Invalid coordinates. lat must be -90 to 90, lng must be -180 to 180', 400);
    }

    if (geoService.isConfigured()) {
      const result = await geoService.geocoding().reverseGeocode(latNum, lngNum, { lang: String(lang) });
      if (result) {
        return ResponseUtil.success(res, {
          ...result,
          latitude: latNum,
          longitude: lngNum,
        });
      }
    }

    // Fallback: structured response with user-friendly label (no raw coordinates)
    return ResponseUtil.success(res, {
      formattedAddress: 'الموقع المحدد على الخريطة',
      lat: latNum,
      lng: lngNum,
      latitude: latNum,
      longitude: lngNum,
      country: 'اليمن',
      countryCode: 'YE',
      city: 'صنعاء',
      confidence: 0.5,
    });
  } catch (error) {
    next(error);
  }
});

// POST variant for reverse geocode (Flutter often uses POST for body params)
router.post('/reverse-geocode', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const { lat, lng, latitude, longitude, lang = 'ar' } = req.body;

    const latNum = parseFloat(String(lat ?? latitude));
    const lngNum = parseFloat(String(lng ?? longitude));

    if (isNaN(latNum) || isNaN(lngNum)) {
      throw new AppError('Request body must include lat/lng or latitude/longitude', 400);
    }

    if (geoService.isConfigured()) {
      const result = await geoService.geocoding().reverseGeocode(latNum, lngNum, { lang: String(lang) });
      if (result) {
        return ResponseUtil.success(res, { ...result, latitude: latNum, longitude: lngNum });
      }
    }

    // Fallback: structured response with user-friendly label (no raw coordinates)
    return ResponseUtil.success(res, {
      formattedAddress: 'الموقع المحدد على الخريطة',
      lat: latNum,
      lng: lngNum,
      latitude: latNum,
      longitude: lngNum,
      country: 'اليمن',
      countryCode: 'YE',
      city: 'صنعاء',
      confidence: 0.5,
    });
  } catch (error) {
    next(error);
  }
});

// ──────────────────────────────────────────────────────────────────────────────
// GET /api/v1/locations/map-config — returns tile URL template to Flutter
// §8: Key remains on server; Flutter gets the rendered URL template
// ──────────────────────────────────────────────────────────────────────────────

router.get('/map-config', async (req: Request, res: Response) => {
  const isConfigured = geoService.isConfigured();
  ResponseUtil.success(res, {
    tileUrlTemplate: isConfigured
      ? config.geo.geoapifyTileUrl
      : 'https://{s}.basemaps.cartocdn.com/rastertiles/voyager/{z}/{x}/{y}.png',
    subdomains: ['a', 'b', 'c', 'd'],
    provider: isConfigured ? config.geo.geocodingProvider : 'carto-osm',
    attribution: isConfigured
      ? '© OpenStreetMap contributors | © Geoapify'
      : '© OpenStreetMap contributors | © CARTO',
    isConfigured,
  });
});


export const locationRoutes = router;

