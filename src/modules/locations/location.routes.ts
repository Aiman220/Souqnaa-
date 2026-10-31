import { Router, Request, Response, NextFunction } from 'express';
import { prisma } from '../../database/prisma';
import { ResponseUtil } from '../../utils/response.util';
import { AppError } from '../../middleware/error.middleware';
import { geoService } from '../../services/geo/geo.service';
import { supportedAreasService } from './supported-areas.service';
import { RemoteConfigService } from '../remote-config/remote-config.service';
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

router.get('/supported-areas', async (req: Request, res: Response, next: NextFunction) => {
  try {
    await supportedAreasService.ensureDatabaseSync();
    const areas = supportedAreasService.getSupportedAreasList();
    ResponseUtil.success(res, areas);
  } catch (error) {
    next(error);
  }
});

router.get('/cities', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const { countryId, supportedOnly } = req.query;
    const isCityDiscoveryEnabled = await RemoteConfigService.getInstance().isFeatureActive('city_based_product_discovery');
    const shouldFilterSupported = isCityDiscoveryEnabled || supportedOnly === 'true';

    if (shouldFilterSupported) {
      await supportedAreasService.ensureDatabaseSync();
      const supportedList = supportedAreasService.getSupportedAreasList();
      return ResponseUtil.success(res, supportedList);
    }

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

    // Strictly supported 10 delivery locations fallback in Yemen
    const defaultCities = [
      { nameAr: 'صنعاء', nameEn: 'Sanaa', lat: 15.3694, lng: 44.1910 },
      { nameAr: 'صعدة', nameEn: 'Saada', lat: 16.9402, lng: 43.7639 },
      { nameAr: 'عمران', nameEn: 'Amran', lat: 15.6594, lng: 43.9439 },
      { nameAr: 'حجة', nameEn: 'Hajjah', lat: 15.6942, lng: 43.6033 },
      { nameAr: 'المحويت', nameEn: 'Al Mahwit', lat: 15.4700, lng: 43.5447 },
      { nameAr: 'ريمة', nameEn: 'Raymah', lat: 14.6300, lng: 43.7100 },
      { nameAr: 'ذمار', nameEn: 'Dhamar', lat: 14.5428, lng: 44.4056 },
      { nameAr: 'البيضاء', nameEn: 'Al Bayda', lat: 13.9856, lng: 45.5728 },
      { nameAr: 'الحديدة', nameEn: 'Al Hudaydah', lat: 14.7979, lng: 42.9545 },
      { nameAr: 'تعز – الحوبان', nameEn: 'Taiz - Al Hawban', lat: 13.6100, lng: 44.0600 },
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
// GET /api/v1/locations/tiles/:z/:x/:y.png — Secure backend proxy for map tiles
// Ensures third-party Geoapify API keys are never exposed in client URLs or responses
// ──────────────────────────────────────────────────────────────────────────────
router.get('/tiles/:z/:x/:y.png', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const { z, x, y } = req.params;
    const zNum = parseInt(String(z), 10);
    const xNum = parseInt(String(x), 10);
    const yNum = parseInt(String(y), 10);

    // Validate zoom and coordinates to prevent SSRF / resource exhaustion
    if (isNaN(zNum) || isNaN(xNum) || isNaN(yNum) || zNum < 0 || zNum > 20 || xNum < 0 || yNum < 0) {
      return res.status(400).send('Invalid tile coordinates');
    }

    const maxCoord = Math.pow(2, zNum);
    if (xNum >= maxCoord || yNum >= maxCoord) {
      return res.status(400).send('Tile coordinate out of bounds');
    }

    const apiKey = config.geo.geoapifyApiKey;
    const upstreamUrl = apiKey
      ? `https://maps.geoapify.com/v1/tile/osm-bright/${zNum}/${xNum}/${yNum}.png?apiKey=${apiKey}`
      : `https://tile.openstreetmap.org/${zNum}/${xNum}/${yNum}.png`;

    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 6000);

    const upstreamRes = await fetch(upstreamUrl, {
      signal: controller.signal,
      headers: {
        'User-Agent': 'SOUQNA-MapProxy/1.0 (support@souqnaa.com)',
      },
    });
    clearTimeout(timeout);

    if (!upstreamRes.ok) {
      return res.status(502).send('Upstream tile service unavailable');
    }

    const buffer = Buffer.from(await upstreamRes.arrayBuffer());
    res.setHeader('Content-Type', 'image/png');
    res.setHeader('Cache-Control', 'public, max-age=86400, stale-while-revalidate=604800');
    return res.send(buffer);
  } catch (err) {
    next(err);
  }
});

// ──────────────────────────────────────────────────────────────────────────────
// GET /api/v1/locations/map-config — returns tile URL template to Flutter
// §8 & §34: Key remains securely on server; Flutter receives server proxy or public tile URL
// ──────────────────────────────────────────────────────────────────────────────
router.get('/map-config', async (req: Request, res: Response) => {
  const isConfigured = geoService.isConfigured();

  // Dynamically resolve base URL from the incoming request so clients always connect
  // to the reachable server instance (works seamlessly in Render, production domain, LAN IP, or localhost).
  let resolvedBaseUrl = config.domains.apiBaseUrl;
  const host = req.get('x-forwarded-host') || req.get('host');
  if (host) {
    const proto = req.get('x-forwarded-proto') || req.protocol || (req.secure ? 'https' : 'http');
    resolvedBaseUrl = `${proto}://${host}${config.apiPrefix}`;
  } else if (process.env.RENDER_EXTERNAL_URL) {
    resolvedBaseUrl = `${process.env.RENDER_EXTERNAL_URL.replace(/\/+$/, '')}${config.apiPrefix}`;
  }

  ResponseUtil.success(res, {
    tileUrlTemplate: isConfigured
      ? `${resolvedBaseUrl}/locations/tiles/{z}/{x}/{y}.png`
      : 'https://tile.openstreetmap.org/{z}/{x}/{y}.png',
    subdomains: isConfigured ? ['a', 'b', 'c', 'd'] : ['a', 'b', 'c'],
    provider: isConfigured ? 'souqna-secure-tiles' : 'osm-standard',
    attribution: isConfigured
      ? '© OpenStreetMap contributors | © Geoapify'
      : '© OpenStreetMap contributors',
    isConfigured,
  });
});

export const locationRoutes = router;


