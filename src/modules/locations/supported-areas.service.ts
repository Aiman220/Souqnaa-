/**
 * SOUQNAA — Supported Delivery Areas Authority & Normalization Engine
 *
 * Strictly enforces delivery to ONLY 10 designated locations in Yemen:
 * 1. صنعاء (Sanaa)
 * 2. صعدة (Saada)
 * 3. عمران (Amran)
 * 4. حجة (Hajjah)
 * 5. المحويت (Al Mahwit)
 * 6. ريمة (Raymah)
 * 7. ذمار (Dhamar)
 * 8. البيضاء (Al Bayda)
 * 9. الحديدة (Al Hudaydah)
 * 10. تعز – الحوبان (Taiz - Al Hawban) [Strictly Al Hawban area, NOT all Taiz Governorate]
 */

import { prisma } from '../../database/prisma';
import { normalizeArabic } from '../search/utils/arabic-normalizer.util';

export interface SupportedAreaDefinition {
  canonicalId: string;
  nameAr: string;
  nameEn: string;
  governorateAr: string;
  governorateEn: string;
  centerLat: number;
  centerLng: number;
  defaultMaxRadiusKm: number;
  aliases: string[];
}

export const STRICTLY_SUPPORTED_AREAS: SupportedAreaDefinition[] = [
  {
    canonicalId: 'loc-ye-sanaa',
    nameAr: 'صنعاء',
    nameEn: 'Sanaa',
    governorateAr: 'صنعاء',
    governorateEn: 'Sanaa',
    centerLat: 15.3694,
    centerLng: 44.1910,
    defaultMaxRadiusKm: 50.0,
    aliases: [
      'صنعاء',
      'صنعا',
      'امانة العاصمة',
      'أمانة العاصمة',
      'مدينة صنعاء',
      'محافظة صنعاء',
      'sanaa',
      "sana'a",
      'sana',
    ],
  },
  {
    canonicalId: 'loc-ye-saada',
    nameAr: 'صعدة',
    nameEn: 'Saada',
    governorateAr: 'صعدة',
    governorateEn: 'Saada',
    centerLat: 16.9402,
    centerLng: 43.7639,
    defaultMaxRadiusKm: 50.0,
    aliases: [
      'صعدة',
      'صعده',
      'مدينة صعدة',
      'مدينة صعده',
      'محافظة صعدة',
      'محافظة صعده',
      'saada',
      "sa'dah",
      'sadah',
    ],
  },
  {
    canonicalId: 'loc-ye-amran',
    nameAr: 'عمران',
    nameEn: 'Amran',
    governorateAr: 'عمران',
    governorateEn: 'Amran',
    centerLat: 15.6594,
    centerLng: 43.9439,
    defaultMaxRadiusKm: 50.0,
    aliases: [
      'عمران',
      'مدينة عمران',
      'محافظة عمران',
      'amran',
      'omran',
    ],
  },
  {
    canonicalId: 'loc-ye-hajjah',
    nameAr: 'حجة',
    nameEn: 'Hajjah',
    governorateAr: 'حجة',
    governorateEn: 'Hajjah',
    centerLat: 15.6942,
    centerLng: 43.6033,
    defaultMaxRadiusKm: 50.0,
    aliases: [
      'حجة',
      'حجه',
      'مدينة حجة',
      'مدينة حجه',
      'محافظة حجة',
      'محافظة حجه',
      'hajjah',
      'hajah',
    ],
  },
  {
    canonicalId: 'loc-ye-al-mahwit',
    nameAr: 'المحويت',
    nameEn: 'Al Mahwit',
    governorateAr: 'المحويت',
    governorateEn: 'Al Mahwit',
    centerLat: 15.4701,
    centerLng: 43.5448,
    defaultMaxRadiusKm: 50.0,
    aliases: [
      'المحويت',
      'محويت',
      'مدينة المحويت',
      'محافظة المحويت',
      'al mahwit',
      'mahwit',
      'al-mahwit',
    ],
  },
  {
    canonicalId: 'loc-ye-raymah',
    nameAr: 'ريمة',
    nameEn: 'Raymah',
    governorateAr: 'ريمة',
    governorateEn: 'Raymah',
    centerLat: 14.6300,
    centerLng: 43.7100,
    defaultMaxRadiusKm: 50.0,
    aliases: [
      'ريمة',
      'ريمه',
      'مدينة ريمة',
      'محافظة ريمة',
      'محافظة ريمه',
      'raymah',
      'remah',
      'rima',
    ],
  },
  {
    canonicalId: 'loc-ye-dhamar',
    nameAr: 'ذمار',
    nameEn: 'Dhamar',
    governorateAr: 'ذمار',
    governorateEn: 'Dhamar',
    centerLat: 14.5427,
    centerLng: 44.4051,
    defaultMaxRadiusKm: 50.0,
    aliases: [
      'ذمار',
      'مدينة ذمار',
      'محافظة ذمار',
      'dhamar',
      'thamar',
    ],
  },
  {
    canonicalId: 'loc-ye-al-bayda',
    nameAr: 'البيضاء',
    nameEn: 'Al Bayda',
    governorateAr: 'البيضاء',
    governorateEn: 'Al Bayda',
    centerLat: 13.9794,
    centerLng: 45.5728,
    defaultMaxRadiusKm: 50.0,
    aliases: [
      'البيضاء',
      'بيضاء',
      'مدينة البيضاء',
      'محافظة البيضاء',
      'al bayda',
      'al-bayda',
      'bayda',
    ],
  },
  {
    canonicalId: 'loc-ye-al-hudaydah',
    nameAr: 'الحديدة',
    nameEn: 'Al Hudaydah',
    governorateAr: 'الحديدة',
    governorateEn: 'Al Hudaydah',
    centerLat: 14.7978,
    centerLng: 42.9545,
    defaultMaxRadiusKm: 50.0,
    aliases: [
      'الحديدة',
      'الحديده',
      'حديدة',
      'حديده',
      'مدينة الحديدة',
      'مدينة الحديده',
      'محافظة الحديدة',
      'محافظة الحديده',
      'al hudaydah',
      'hodeidah',
      'al-hudaydah',
      'hudaydah',
    ],
  },
  {
    canonicalId: 'loc-ye-taiz-al-hawban',
    nameAr: 'تعز – الحوبان',
    nameEn: 'Taiz - Al Hawban',
    governorateAr: 'تعز',
    governorateEn: 'Taiz',
    centerLat: 13.6100,
    centerLng: 44.0600,
    defaultMaxRadiusKm: 25.0, // Specific district radius within Taiz governorate
    aliases: [
      'تعز – الحوبان',
      'تعز - الحوبان',
      'تعز-الحوبان',
      'الحوبان',
      'منطقة الحوبان',
      'حوبان',
      'الحوبان تعز',
      'تعز (الحوبان)',
      'تعز/الحوبان',
      'الحوبان، تعز',
      'al hawban',
      'taiz - al hawban',
      'taiz al hawban',
      'hawban',
    ],
  },
];

export interface LocationMatchResult {
  isSupported: boolean;
  area: SupportedAreaDefinition | null;
  canonicalCityId?: string;
  rejectionReasonAr?: string;
  rejectionReasonEn?: string;
}

export class SupportedAreasService {
  private static instance: SupportedAreasService;
  private dbCityMap: Map<string, string> = new Map(); // canonicalId -> db City.id
  private dbCityRecordMap: Map<string, any> = new Map(); // db City.id -> City record

  public static getInstance(): SupportedAreasService {
    if (!SupportedAreasService.instance) {
      SupportedAreasService.instance = new SupportedAreasService();
    }
    return SupportedAreasService.instance;
  }

  /**
   * Normalizes any input location string (Arabic / English) for robust comparison.
   * Strips tashkeel, standardizes alefs, converts dashes, normalizes whitespace.
   */
  public normalizeLocationString(input: string | null | undefined): string {
    if (!input) return '';
    let str = String(input).trim();
    // Standardize dash variants to ASCII dash
    str = str.replace(/[–—−]/g, '-');
    // Normalize Arabic diacritics, alef, etc.
    str = normalizeArabic(str);
    // Replace punctuation with space
    str = str.replace(/[,،/\\()]/g, ' ');
    // Collapse whitespace
    return str.replace(/\s+/g, ' ').trim().toLowerCase();
  }

  /**
   * Evaluates whether an input location string represents one of the 10 supported areas.
   * Strictly enforces that "تعز" WITHOUT "الحوبان" is REJECTED.
   */
  public matchSupportedArea(input: string | null | undefined): LocationMatchResult {
    if (!input) {
      return {
        isSupported: false,
        area: null,
        rejectionReasonAr: 'يرجى تحديد مدينة أو منطقة توصيل مدعومة',
        rejectionReasonEn: 'Please select a supported delivery city or area',
      };
    }

    const normalized = this.normalizeLocationString(input);

    // CRITICAL: Check Taiz restriction first
    const mentionsTaiz = normalized.includes('تعز') || normalized.includes('taiz');
    const mentionsHawban =
      normalized.includes('حوبان') ||
      normalized.includes('hawban') ||
      normalized.includes('houban');

    if (mentionsTaiz && !mentionsHawban) {
      return {
        isSupported: false,
        area: null,
        rejectionReasonAr:
          'التوصيل في محافظة تعز مقتصر حصراً على منطقة "الحوبان" فقط. باقي مناطق ومدينة تعز غير مشمولة حالياً.',
        rejectionReasonEn:
          'Delivery in Taiz Governorate is strictly restricted to "Al Hawban" area only. Other Taiz areas are currently not serviceable.',
      };
    }

    if (mentionsHawban) {
      const hawbanArea = STRICTLY_SUPPORTED_AREAS.find((a) => a.canonicalId === 'loc-ye-taiz-al-hawban')!;
      return {
        isSupported: true,
        area: hawbanArea,
        canonicalCityId: this.dbCityMap.get(hawbanArea.canonicalId) || hawbanArea.canonicalId,
      };
    }

    // Check all other supported areas
    for (const area of STRICTLY_SUPPORTED_AREAS) {
      // Direct canonical ID match
      if (area.canonicalId === input || normalized === area.canonicalId.toLowerCase()) {
        return {
          isSupported: true,
          area,
          canonicalCityId: this.dbCityMap.get(area.canonicalId) || area.canonicalId,
        };
      }

      if (area.canonicalId === 'loc-ye-taiz-al-hawban') continue;

      for (const alias of area.aliases) {
        const normAlias = this.normalizeLocationString(alias);
        if (normalized === normAlias || normalized.includes(normAlias) || normAlias.includes(normalized)) {
          return {
            isSupported: true,
            area,
            canonicalCityId: this.dbCityMap.get(area.canonicalId) || area.canonicalId,
          };
        }
      }
    }

    // Not in the 10 supported areas
    return {
      isSupported: false,
      area: null,
      rejectionReasonAr:
        'عذراً، هذه المنطقة غير مشمولة بنطاق التوصيل حالياً. التوصيل متاح حصراً في: صنعاء، صعدة، عمران، حجة، المحويت، ريمة، ذمار، البيضاء، الحديدة، تعز – الحوبان.',
      rejectionReasonEn:
        'Sorry, this location is outside the supported delivery areas. Service is strictly available in: Sanaa, Saada, Amran, Hajjah, Al Mahwit, Raymah, Dhamar, Al Bayda, Al Hudaydah, Taiz - Al Hawban.',
    };
  }

  /**
   * Geodesic distance in kilometers between two coordinates using Haversine formula.
   */
  public calculateGeodesicDistanceKm(lat1: number, lon1: number, lat2: number, lon2: number): number {
    const R = 6371; // Earth's radius in km
    const dLat = (lat2 - lat1) * (Math.PI / 180);
    const dLon = (lon2 - lon1) * (Math.PI / 180);
    const a =
      Math.sin(dLat / 2) * Math.sin(dLat / 2) +
      Math.cos(lat1 * (Math.PI / 180)) * Math.cos(lat2 * (Math.PI / 180)) *
      Math.sin(dLon / 2) * Math.sin(dLon / 2);
    const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
    return Math.round(R * c * 100) / 100;
  }

  /**
   * Finds the nearest supported area for given coordinates and checks if it falls
   * within the area's service radius.
   */
  public findSupportedAreaByCoordinates(
    lat: number,
    lng: number,
    maxToleranceKm: number = 75.0
  ): { area: SupportedAreaDefinition | null; distanceKm: number } {
    let nearestArea: SupportedAreaDefinition | null = null;
    let minDistance = Infinity;

    for (const area of STRICTLY_SUPPORTED_AREAS) {
      const dist = this.calculateGeodesicDistanceKm(lat, lng, area.centerLat, area.centerLng);
      if (dist < minDistance) {
        minDistance = dist;
        nearestArea = area;
      }
    }

    if (nearestArea && minDistance <= (nearestArea.defaultMaxRadiusKm || maxToleranceKm)) {
      return { area: nearestArea, distanceKm: minDistance };
    }

    return { area: null, distanceKm: minDistance };
  }

  /**
   * Validates whether an address record (with city, district, lat, lng) is within the supported areas.
   */
  public isAddressSupported(address: {
    cityId?: string | null;
    city?: { nameAr?: string | null; nameEn?: string | null } | string | null;
    district?: { nameAr?: string | null; nameEn?: string | null } | string | null;
    street?: string | null;
    latitude?: number | null;
    longitude?: number | null;
  }): LocationMatchResult {
    // 1. If coordinates are provided, check coordinates against Taiz city center vs Al Hawban
    if (address.latitude && address.longitude) {
      const lat = address.latitude;
      const lng = address.longitude;

      // Special Taiz coordinates check:
      // Taiz City Center is around (13.5776, 44.0175). Al Hawban is northeast (13.6100, 44.0600)
      const distToHawban = this.calculateGeodesicDistanceKm(lat, lng, 13.6100, 44.0600);
      const distToTaizCenter = this.calculateGeodesicDistanceKm(lat, lng, 13.5776, 44.0175);

      // If clearly inside Taiz city center and outside Hawban radius (e.g. > 15km from Hawban)
      if (distToTaizCenter < 10.0 && distToHawban > 10.0) {
        return {
          isSupported: false,
          area: null,
          rejectionReasonAr:
            'التوصيل في محافظة تعز مقتصر حصراً على منطقة "الحوبان" فقط. الموقع المحدد خارج نطاق الحوبان.',
          rejectionReasonEn:
            'Delivery in Taiz is strictly limited to Al Hawban area. The selected map pin is outside Al Hawban.',
        };
      }
    }

    // 2. Match city and district names
    const cityName =
      typeof address.city === 'string'
        ? address.city
        : address.city?.nameAr || address.city?.nameEn || '';

    const districtName =
      typeof address.district === 'string'
        ? address.district
        : address.district?.nameAr || address.district?.nameEn || '';

    const streetName = address.street || '';
    const combined = `${cityName} ${districtName} ${streetName}`.trim();

    return this.matchSupportedArea(combined || cityName);
  }

  /**
   * Synchronizes database records: ensures Yemen country ('YE') and all 10 canonical City records exist.
   * Maps existing DB cities to canonical definitions without corrupting existing foreign keys.
   */
  public async ensureDatabaseSync(): Promise<void> {
    try {
      // 1. Ensure Country YE exists
      let yemen = await prisma.country.findFirst({
        where: { code: 'YE' },
      });

      if (!yemen) {
        yemen = await prisma.country.create({
          data: {
            code: 'YE',
            nameAr: 'الجمهورية اليمنية',
            nameEn: 'Yemen',
            currency: 'YER',
            phoneCode: '+967',
            isActive: true,
          },
        });
      }

      // 2. Load existing cities
      const existingCities = await prisma.city.findMany();

      for (const area of STRICTLY_SUPPORTED_AREAS) {
        // Try to find existing matching city in database
        let matchedCity = existingCities.find((c) => {
          if (c.id === area.canonicalId) return true;
          const normAr = this.normalizeLocationString(c.nameAr);
          const normEn = this.normalizeLocationString(c.nameEn);
          const areaNormAr = this.normalizeLocationString(area.nameAr);
          const areaNormEn = this.normalizeLocationString(area.nameEn);

          // For Taiz - Al Hawban, require Hawban
          if (area.canonicalId === 'loc-ye-taiz-al-hawban') {
            return (
              (normAr.includes('حوبان') || normEn.includes('hawban')) &&
              (normAr.includes('تعز') || normEn.includes('taiz') || normAr === 'الحوبان')
            );
          }

          // For others, exact or alias match
          return normAr === areaNormAr || normEn === areaNormEn;
        });

        if (matchedCity) {
          // Update missing coordinates or activate
          if (
            matchedCity.latitude == null ||
            matchedCity.longitude == null ||
            !matchedCity.isActive ||
            matchedCity.countryId !== yemen.id
          ) {
            matchedCity = await prisma.city.update({
              where: { id: matchedCity.id },
              data: {
                latitude: matchedCity.latitude ?? area.centerLat,
                longitude: matchedCity.longitude ?? area.centerLng,
                countryId: yemen.id,
                isActive: true,
              },
            });
          }
          this.dbCityMap.set(area.canonicalId, matchedCity.id);
          this.dbCityRecordMap.set(matchedCity.id, matchedCity);
        } else {
          // Create canonical city
          const newCity = await prisma.city.create({
            data: {
              id: area.canonicalId,
              countryId: yemen.id,
              nameAr: area.nameAr,
              nameEn: area.nameEn,
              latitude: area.centerLat,
              longitude: area.centerLng,
              isActive: true,
            },
          });
          this.dbCityMap.set(area.canonicalId, newCity.id);
          this.dbCityRecordMap.set(newCity.id, newCity);
        }
      }
    } catch (err) {
      console.warn('[SupportedAreasService] Database sync warning:', err);
    }
  }

  /**
   * Returns list of canonical supported areas formatted for API consumers.
   */
  public getSupportedAreasList() {
    return STRICTLY_SUPPORTED_AREAS.map((a) => ({
      id: this.dbCityMap.get(a.canonicalId) || a.canonicalId,
      canonicalId: a.canonicalId,
      nameAr: a.nameAr,
      nameEn: a.nameEn,
      governorateAr: a.governorateAr,
      governorateEn: a.governorateEn,
      latitude: a.centerLat,
      longitude: a.centerLng,
      maxDeliveryRadiusKm: a.defaultMaxRadiusKm,
      isStrictlySupported: true,
    }));
  }

  /**
   * Lookup canonical ID by database City ID or name.
   */
  public resolveCanonicalId(cityIdOrName: string): string | null {
    if (!cityIdOrName) return null;
    const match = this.matchSupportedArea(cityIdOrName);
    return match.area?.canonicalId ?? null;
  }
}

export const supportedAreasService = SupportedAreasService.getInstance();
