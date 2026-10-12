import https from 'https';
import { config } from '../../../config';
import type {
  GeocodingProvider,
  GeocodingResult,
  GeoCoordinates,
  RouteResult,
  RoutingProvider,
} from './map.provider';

// ──────────────────────────────────────────────────────────────────────────────
// Observability helpers (§34 — log provider usage, never log API key)
// ──────────────────────────────────────────────────────────────────────────────

interface ProviderLogEntry {
  provider: string;
  operation: string;
  requestId: string;
  durationMs: number;
  success: boolean;
  errorCode?: string;
}

function logProviderCall(entry: ProviderLogEntry): void {
  const status = entry.success ? '✅' : '❌';
  console.log(
    `[GEO] ${status} provider=${entry.provider} op=${entry.operation} ` +
    `req=${entry.requestId} dur=${entry.durationMs}ms` +
    (entry.errorCode ? ` err=${entry.errorCode}` : ''),
  );
}

let _reqCounter = 0;
function newRequestId(): string {
  return `geo-${Date.now()}-${++_reqCounter}`;
}

// ──────────────────────────────────────────────────────────────────────────────
// Simple HTTPS fetch helper (no extra dependencies)
// ──────────────────────────────────────────────────────────────────────────────

function httpsGet(url: string, timeoutMs = 8000): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const req = https.get(url, { timeout: timeoutMs }, (res) => {
      let data = '';
      res.on('data', (chunk) => (data += chunk));
      res.on('end', () => {
        try {
          resolve(JSON.parse(data));
        } catch {
          reject(new Error(`Invalid JSON from ${new URL(url).hostname}`));
        }
      });
    });
    req.on('error', reject);
    req.on('timeout', () => {
      req.destroy();
      reject(new Error('Request timed out'));
    });
  });
}

// ──────────────────────────────────────────────────────────────────────────────
// Geoapify Geocoding Provider
// ──────────────────────────────────────────────────────────────────────────────

export class GeoapifyGeocodingProvider implements GeocodingProvider {
  readonly providerName = 'geoapify';
  private readonly apiKey: string;

  constructor() {
    this.apiKey = config.geo.geoapifyApiKey;
  }

  async geocode(
    query: string,
    options: { limit?: number; lang?: string } = {},
  ): Promise<GeocodingResult[]> {
    const requestId = newRequestId();
    const start = Date.now();

    try {
      const params = new URLSearchParams({
        text: query,
        limit: String(options.limit ?? 5),
        lang: options.lang ?? 'ar',
        apiKey: this.apiKey,
      });

      const url = `https://api.geoapify.com/v1/geocode/search?${params}`;
      const data = await httpsGet(url) as any;

      const results: GeocodingResult[] = (data?.features ?? []).map(
        (f: any) => this._mapFeatureToResult(f),
      );

      logProviderCall({ provider: this.providerName, operation: 'geocode', requestId, durationMs: Date.now() - start, success: true });
      return results;
    } catch (err: any) {
      logProviderCall({ provider: this.providerName, operation: 'geocode', requestId, durationMs: Date.now() - start, success: false, errorCode: err?.message ?? 'UNKNOWN' });
      throw err;
    }
  }

  async reverseGeocode(
    lat: number,
    lng: number,
    options: { lang?: string } = {},
  ): Promise<GeocodingResult | null> {
    const requestId = newRequestId();
    const start = Date.now();

    try {
      const params = new URLSearchParams({
        lat: String(lat),
        lon: String(lng),
        lang: options.lang ?? 'ar',
        apiKey: this.apiKey,
      });

      const url = `https://api.geoapify.com/v1/geocode/reverse?${params}`;
      const data = await httpsGet(url) as any;

      const features: any[] = data?.features ?? [];
      if (features.length === 0) {
        logProviderCall({ provider: this.providerName, operation: 'reverseGeocode', requestId, durationMs: Date.now() - start, success: true });
        return null;
      }

      const result = this._mapFeatureToResult(features[0]);
      logProviderCall({ provider: this.providerName, operation: 'reverseGeocode', requestId, durationMs: Date.now() - start, success: true });
      return result;
    } catch (err: any) {
      logProviderCall({ provider: this.providerName, operation: 'reverseGeocode', requestId, durationMs: Date.now() - start, success: false, errorCode: err?.message ?? 'UNKNOWN' });
      throw err;
    }
  }

  private _mapFeatureToResult(feature: any): GeocodingResult {
    const p = feature?.properties ?? {};
    return {
      formattedAddress: p.formatted ?? '',
      country: p.country ?? null,
      countryCode: p.country_code ?? null,
      state: p.state ?? p.county ?? null,
      city: p.city ?? p.town ?? p.village ?? null,
      district: p.district ?? p.suburb ?? null,
      street: p.street ?? null,
      houseNumber: p.housenumber ?? null,
      postcode: p.postcode ?? null,
      lat: feature?.geometry?.coordinates?.[1] ?? p.lat ?? 0,
      lng: feature?.geometry?.coordinates?.[0] ?? p.lon ?? 0,
      confidence: p.rank?.confidence ?? 0.5,
    };
  }
}

// ──────────────────────────────────────────────────────────────────────────────
// Geoapify Routing Provider
// ──────────────────────────────────────────────────────────────────────────────

export class GeoapifyRoutingProvider implements RoutingProvider {
  readonly providerName = 'geoapify';
  private readonly apiKey: string;

  constructor() {
    this.apiKey = config.geo.geoapifyApiKey;
  }

  async getDrivingRoute(origin: GeoCoordinates, destination: GeoCoordinates): Promise<RouteResult> {
    const requestId = newRequestId();
    const start = Date.now();

    this._validateCoordinates(origin, 'origin');
    this._validateCoordinates(destination, 'destination');

    try {
      const params = new URLSearchParams({
        waypoints: `${origin.lat},${origin.lng}|${destination.lat},${destination.lng}`,
        mode: 'drive',
        apiKey: this.apiKey,
      });

      const url = `https://api.geoapify.com/v1/routing?${params}`;
      const data = await httpsGet(url) as any;

      const features: any[] = data?.features ?? [];
      if (features.length === 0) {
        throw Object.assign(new Error('No route found between the given coordinates'), { code: 'NO_ROUTE_FOUND' });
      }

      const props = features[0]?.properties ?? {};
      const distanceMeters: number = props.distance ?? 0;
      const durationSeconds: number = props.time ?? 0;

      const result: RouteResult = {
        distanceMeters,
        distanceKm: Math.round((distanceMeters / 1000) * 100) / 100,
        durationSeconds,
        durationMinutes: Math.round(durationSeconds / 60),
        provider: this.providerName,
      };

      logProviderCall({ provider: this.providerName, operation: 'getDrivingRoute', requestId, durationMs: Date.now() - start, success: true });
      return result;
    } catch (err: any) {
      logProviderCall({ provider: this.providerName, operation: 'getDrivingRoute', requestId, durationMs: Date.now() - start, success: false, errorCode: err?.code ?? err?.message ?? 'UNKNOWN' });
      throw err;
    }
  }

  private _validateCoordinates(coords: GeoCoordinates, label: string): void {
    if (
      typeof coords.lat !== 'number' || typeof coords.lng !== 'number' ||
      isNaN(coords.lat) || isNaN(coords.lng) ||
      coords.lat < -90 || coords.lat > 90 ||
      coords.lng < -180 || coords.lng > 180
    ) {
      throw Object.assign(
        new Error(`Invalid coordinates for ${label}: lat=${coords.lat}, lng=${coords.lng}`),
        { code: 'INVALID_COORDINATES' },
      );
    }
  }
}
