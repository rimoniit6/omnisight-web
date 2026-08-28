/**
 * Free reverse geocoding via OpenStreetMap Nominatim.
 *
 * Usage policy compliance:
 *   - Max 1 request/second (polite user-agent required)
 *   - In-memory cache reduces repeated lookups
 *   - Results cached for 24 hours (coordinates don't change addresses often)
 *   - Never called in tight loops — only on demand for display
 *
 * No API key required. No paid service.
 */

interface NominatimResult {
  display_name: string;
  address?: {
    city?: string;
    town?: string;
    village?: string;
    county?: string;
    state?: string;
    country?: string;
    suburb?: string;
    neighbourhood?: string;
  };
}

interface GeocodeResult {
  /** Short address label (e.g. "Naogaon, Rajshahi, Bangladesh") */
  shortAddress: string;
  /** Full display name from Nominatim */
  displayName: string;
  /** City/town/village name */
  city: string | null;
  /** District/county */
  district: string | null;
  /** State/division */
  division: string | null;
  /** Country */
  country: string | null;
}

// In-memory cache: coordinate key → result + timestamp
const cache = new Map<string, { result: GeocodeResult; ts: number }>();
const CACHE_TTL_MS = 24 * 60 * 60 * 1000; // 24 hours
const REQUEST_INTERVAL_MS = 1100; // 1.1 seconds between requests (Nominatim: 1 req/s)
let lastRequestTime = 0;

function cacheKey(lat: number, lng: number): string {
  // Round to 3 decimal places (~100m precision) for cache efficiency
  return `${lat.toFixed(3)},${lng.toFixed(3)}`;
}

/**
 * Reverse geocode a coordinate to an address label.
 * Returns null on failure (network, rate limit, invalid coordinates).
 * Results are cached for 24 hours.
 */
export async function reverseGeocode(
  latitude: number,
  longitude: number
): Promise<GeocodeResult | null> {
  // Validate coordinates
  if (!Number.isFinite(latitude) || latitude < -90 || latitude > 90) return null;
  if (!Number.isFinite(longitude) || longitude < -180 || longitude > 180) return null;

  const key = cacheKey(latitude, longitude);
  const cached = cache.get(key);
  if (cached && Date.now() - cached.ts < CACHE_TTL_MS) {
    return cached.result;
  }

  // Rate limit: 1 request per 1.1 seconds
  const now = Date.now();
  const waitMs = Math.max(0, REQUEST_INTERVAL_MS - (now - lastRequestTime));
  if (waitMs > 0) {
    await new Promise((resolve) => setTimeout(resolve, waitMs));
  }
  lastRequestTime = Date.now();

  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 5000);
    const url = `https://nominatim.openstreetmap.org/reverse?format=json&lat=${latitude}&lon=${longitude}&zoom=18&addressdetails=1`;
    const res = await fetch(url, {
      signal: controller.signal,
      headers: {
        'User-Agent': 'OmniSight-Admin/1.0 (workforce-monitoring)',
        'Accept-Language': 'en',
      },
    });
    clearTimeout(timer);

    if (!res.ok) return null;
    const data = (await res.json()) as NominatimResult;
    if (!data.display_name) return null;

    const addr = data.address ?? {};
    const city = addr.city || addr.town || addr.village || null;
    const district = addr.county || null;
    const division = addr.state || null;
    const country = addr.country || null;

    // Build short address: "City, District, Division, Country"
    const parts = [city, district, division, country].filter(Boolean);
    const shortAddress = parts.join(', ') || data.display_name;

    const result: GeocodeResult = {
      shortAddress,
      displayName: data.display_name,
      city,
      district,
      division,
      country,
    };

    cache.set(key, { result, ts: Date.now() });
    return result;
  } catch {
    return null;
  }
}
