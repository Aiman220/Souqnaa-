/**
 * Map / Geo provider abstractions.
 *
 * These interfaces decouple the application from any specific geo provider.
 * To swap Geoapify for another provider, implement these interfaces and update
 * the factory in geo.service.ts — no application code needs to change.
 */

// ──────────────────────────────────────────────────────────────────────────────
// Shared types
// ──────────────────────────────────────────────────────────────────────────────

export interface GeoCoordinates {
  lat: number;
  lng: number;
}

export interface GeocodingResult {
  formattedAddress: string;
  country: string | null;
  countryCode: string | null;
  state: string | null; // governorate / region
  city: string | null;
  district: string | null;
  street: string | null;
  houseNumber: string | null;
  postcode: string | null;
  lat: number;
  lng: number;
  confidence: number; // 0–1 confidence score
}

export interface RouteResult {
  distanceMeters: number;
  distanceKm: number;
  durationSeconds: number;
  durationMinutes: number;
  provider: string;
}

export interface GeoProviderError {
  code:
    | 'PROVIDER_UNAVAILABLE'
    | 'RATE_LIMITED'
    | 'TIMEOUT'
    | 'NO_RESULTS'
    | 'NO_ROUTE_FOUND'
    | 'INVALID_COORDINATES'
    | 'UNKNOWN';
  message: string;
  providerName: string;
}

// ──────────────────────────────────────────────────────────────────────────────
// Provider interfaces
// ──────────────────────────────────────────────────────────────────────────────

/**
 * Geocoding provider — converts text queries to/from coordinates.
 */
export interface GeocodingProvider {
  readonly providerName: string;

  /** Forward geocoding: text → coordinates + structured address */
  geocode(query: string, options?: { limit?: number; lang?: string }): Promise<GeocodingResult[]>;

  /** Reverse geocoding: coordinates → structured address */
  reverseGeocode(lat: number, lng: number, options?: { lang?: string }): Promise<GeocodingResult | null>;
}

/**
 * Routing provider — computes routes between two points.
 * Uses DRIVING mode for delivery distance calculations.
 */
export interface RoutingProvider {
  readonly providerName: string;

  /** Calculate driving route between origin and destination */
  getDrivingRoute(origin: GeoCoordinates, destination: GeoCoordinates): Promise<RouteResult>;
}
