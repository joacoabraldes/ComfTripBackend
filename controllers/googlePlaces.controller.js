'use strict';

const express = require('express');
const router = express.Router();

// Use whichever env var name you prefer
const GOOGLE_PLACES_API_KEY =
  process.env.GOOGLE_PLACES_API_KEY || process.env.GOOGLE_MAPS_API_KEY;

const PLACES_BASE = 'https://places.googleapis.com/v1';

// Tiny in-memory cache to reduce billing + latency (10 min)
const CACHE_TTL_MS = 10 * 60 * 1000;
const cache = new Map();

function cacheGet(key) {
  const hit = cache.get(key);
  if (!hit) return null;
  if (Date.now() > hit.expiresAt) {
    cache.delete(key);
    return null;
  }
  return hit.value;
}

function cacheSet(key, value) {
  cache.set(key, { value, expiresAt: Date.now() + CACHE_TTL_MS });
}

async function googleFetchJson(url, { method = 'GET', headers = {}, body } = {}) {
  const res = await fetch(url, {
    method,
    headers,
    body: body ? JSON.stringify(body) : undefined,
  });

  const text = await res.text();
  let data = null;
  try {
    data = text ? JSON.parse(text) : null;
  } catch {
    data = { raw: text };
  }

  if (!res.ok) {
    const err = new Error(`Google Places error ${res.status}`);
    err.status = res.status;
    err.data = data;
    throw err;
  }

  return data;
}

function buildTextQuery({ q, name, city, country }) {
  // Prefer `q`, otherwise build "name, city, country"
  if (q && String(q).trim()) return String(q).trim();

  const parts = [name, city, country]
    .map((x) => (x ? String(x).trim() : ''))
    .filter(Boolean);

  return parts.join(', ').trim();
}

function extractPlaceId(place) {
  // In Places API (New), responses may contain:
  // - id: "ChIJ...."
  // - name: "places/ChIJ...."
  if (place?.id) return place.id;
  if (place?.name && typeof place.name === 'string' && place.name.includes('/')) {
    return place.name.split('/').pop();
  }
  return null;
}

async function findPlaceByText(textQuery, languageCode) {
  // Text Search (New) is POST /v1/places:searchText and requires FieldMask :contentReference[oaicite:3]{index=3}
  const url = `${PLACES_BASE}/places:searchText`;

  const data = await googleFetchJson(url, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'X-Goog-Api-Key': GOOGLE_PLACES_API_KEY,
      // FieldMask is REQUIRED (no default fields) :contentReference[oaicite:4]{index=4}
      'X-Goog-FieldMask': 'places.id,places.name,places.displayName,places.formattedAddress',
    },
    body: {
      textQuery,
      // Keep it cheap: only ask for 1 result
      pageSize: 1, // supported; maxResultCount is deprecated :contentReference[oaicite:5]{index=5}
      ...(languageCode ? { languageCode } : {}),
    },
  });

  const place = Array.isArray(data?.places) ? data.places[0] : null;
  if (!place) return null;

  return {
    placeId: extractPlaceId(place),
    displayName: place?.displayName?.text ?? null,
    formattedAddress: place?.formattedAddress ?? null,
  };
}

async function getPlaceDetails(placeId, languageCode) {
  // Place Details (New) is GET /v1/places/PLACE_ID and requires FieldMask :contentReference[oaicite:6]{index=6}
  const params = new URLSearchParams();
  if (languageCode) params.set('languageCode', languageCode); // optional param :contentReference[oaicite:7]{index=7}

  const url = `${PLACES_BASE}/places/${encodeURIComponent(placeId)}${
    params.toString() ? `?${params.toString()}` : ''
  }`;

  return googleFetchJson(url, {
    method: 'GET',
    headers: {
      'Content-Type': 'application/json',
      'X-Goog-Api-Key': GOOGLE_PLACES_API_KEY,
      // FieldMask is REQUIRED :contentReference[oaicite:8]{index=8}
      'X-Goog-FieldMask':
        'id,displayName,formattedAddress,rating,userRatingCount,googleMapsUri,reviews',
    },
  });
}

function normalizeTop3Reviews(placeDetails) {
  const reviews = Array.isArray(placeDetails?.reviews) ? placeDetails.reviews : [];
  return reviews.slice(0, 3).map((r) => ({
    rating: r?.rating ?? null,
    text: r?.text?.text ?? null,
    languageCode: r?.text?.languageCode ?? r?.originalLanguageCode ?? null,
    publishTime: r?.publishTime ?? null,
    relativeTime: r?.relativePublishTimeDescription ?? null,
    author: {
      name: r?.authorAttribution?.displayName ?? null,
      uri: r?.authorAttribution?.uri ?? null,
      photoUri: r?.authorAttribution?.photoUri ?? null,
    },
  }));
}

/**
 * GET /api/google/reviews?name=...&city=...&country=...&q=...&lang=es
 * - Provide either `q` OR at least `name`.
 * - Returns up to 3 reviews.
 */
router.get('/reviews', async (req, res) => {
  try {
    if (!GOOGLE_PLACES_API_KEY) {
      return res.status(500).json({ message: 'Missing GOOGLE_PLACES_API_KEY' });
    }

    const { q, name, city, country } = req.query;
    const languageCode = (req.query.lang || 'es').toString(); // default to Spanish

    const textQuery = buildTextQuery({ q, name, city, country });
    if (!textQuery) return res.status(400).json({ message: 'Missing query (q or name)' });

    const cacheKey = `reviews:v1:${languageCode}:${textQuery.toLowerCase()}`;
    const cached = cacheGet(cacheKey);
    if (cached) return res.json({ cached: true, ...cached });

    const found = await findPlaceByText(textQuery, languageCode);
    if (!found?.placeId) {
      return res.status(404).json({ message: 'Place not found', query: textQuery });
    }

    const details = await getPlaceDetails(found.placeId, languageCode);

    const payload = {
      cached: false,
      query: textQuery,
      place: {
        id: details?.id ?? found.placeId,
        name: details?.displayName?.text ?? found.displayName,
        formattedAddress: details?.formattedAddress ?? found.formattedAddress,
        rating: details?.rating ?? null,
        userRatingCount: details?.userRatingCount ?? null,
        googleMapsUri: details?.googleMapsUri ?? null,
      },
      reviews: normalizeTop3Reviews(details),
    };

    cacheSet(cacheKey, payload);
    return res.json(payload);
  } catch (err) {
    console.error('GET /api/google/reviews error:', err?.data || err);
    return res.status(err?.status || 500).json({
      message: 'Error fetching place reviews',
      status: err?.status || 500,
      details: err?.data || null,
    });
  }
});

/**
 * POST /api/google/reviews
 * body: { q?: string, name?: string, city?: string, country?: string, lang?: string }
 */
router.post('/reviews', async (req, res) => {
  // same logic, just accept JSON body
  req.query = { ...req.query, ...req.body };
  return router.handle(req, res);
});

module.exports = router;
