/**
 * GeoService — factory that resolves the active geo providers from env config.
 *
 * §35: If Geoapify becomes unavailable, the backend returns a controlled error.
 * Do NOT silently invent a distance.
 *
 * §36: Architecture supports switching to:
 *  - Paid Geoapify
 *  - Self-hosted routing / geocoding infrastructure
 *  - Another provider
 * without changing Flutter business logic.
 */

import { config } from '../../config';
import type { GeocodingProvider, RoutingProvider } from './providers/map.provider';
import { GeoapifyGeocodingProvider, GeoapifyRoutingProvider } from './providers/geoapify.provider';

// ──────────────────────────────────────────────────────────────────────────────
// Provider registry — add new providers here
// ──────────────────────────────────────────────────────────────────────────────

type ProviderName = 'geoapify';

const geocodingProviders: Record<ProviderName, () => GeocodingProvider> = {
  geoapify: () => new GeoapifyGeocodingProvider(),
};

const routingProviders: Record<ProviderName, () => RoutingProvider> = {
  geoapify: () => new GeoapifyRoutingProvider(),
};

// ──────────────────────────────────────────────────────────────────────────────
// Singleton instances
// ──────────────────────────────────────────────────────────────────────────────

let _geocodingProvider: GeocodingProvider | null = null;
let _routingProvider: RoutingProvider | null = null;

function resolveGeocodingProvider(): GeocodingProvider {
  if (_geocodingProvider) return _geocodingProvider;

  const name = config.geo.geocodingProvider as ProviderName;
  const factory = geocodingProviders[name];

  if (!factory) {
    throw new Error(`Unknown geocoding provider: "${name}". Supported: ${Object.keys(geocodingProviders).join(', ')}`);
  }

  _geocodingProvider = factory();
  console.log(`[GeoService] Geocoding provider resolved: ${_geocodingProvider.providerName}`);
  return _geocodingProvider;
}

function resolveRoutingProvider(): RoutingProvider {
  if (_routingProvider) return _routingProvider;

  const name = config.geo.routingProvider as ProviderName;
  const factory = routingProviders[name];

  if (!factory) {
    throw new Error(`Unknown routing provider: "${name}". Supported: ${Object.keys(routingProviders).join(', ')}`);
  }

  _routingProvider = factory();
  console.log(`[GeoService] Routing provider resolved: ${_routingProvider.providerName}`);
  return _routingProvider;
}

// ──────────────────────────────────────────────────────────────────────────────
// Public API
// ──────────────────────────────────────────────────────────────────────────────

export const geoService = {
  /**
   * Returns the active geocoding provider.
   * Throws a descriptive error if the provider is not configured.
   */
  geocoding(): GeocodingProvider {
    return resolveGeocodingProvider();
  },

  /**
   * Returns the active routing provider.
   * Throws a descriptive error if the provider is not configured.
   */
  routing(): RoutingProvider {
    return resolveRoutingProvider();
  },

  /**
   * Reset singletons — useful for testing or hot-reloading provider config.
   */
  reset(): void {
    _geocodingProvider = null;
    _routingProvider = null;
  },

  /** Whether a real Geoapify API key is configured */
  isConfigured(): boolean {
    const key = config.geo.geoapifyApiKey;
    return Boolean(
      key &&
      key !== 'your_geoapify_api_key_here' &&
      key !== 'YOUR_KEY' &&
      key.trim().length > 10
    );
  },
};

