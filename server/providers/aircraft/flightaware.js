import { coalesceProxyRequest, readResponseJsonCapped } from '../common/http.js';
import { makeRateLimiter } from '../common/rate-limit.js';

const CACHE_TTL_MS = 30_000;
const MAX_RESPONSE_BYTES = 512 * 1024;
const inFlight = new Map();
const cache = new Map();

function clientKey(req) {
  return String(req.socket?.remoteAddress || 'unknown');
}

function normalizeAirport(airport) {
  if (!airport || typeof airport !== 'object') return null;
  return {
    code: airport.code_iata || airport.code_icao || airport.code || null,
    name: airport.name || airport.city || null,
  };
}

function normalizeFlight(raw) {
  if (!raw || typeof raw !== 'object') return null;
  const latitude = Number(raw.latitude);
  const longitude = Number(raw.longitude);
  return {
    id: raw.fa_flight_id || null,
    ident: raw.ident_iata || raw.ident_icao || raw.ident || null,
    status: raw.status || 'Unknown',
    origin: normalizeAirport(raw.origin),
    destination: normalizeAirport(raw.destination),
    scheduledOut: raw.scheduled_out || null,
    estimatedOut: raw.estimated_out || null,
    actualOut: raw.actual_out || null,
    scheduledIn: raw.scheduled_in || null,
    estimatedIn: raw.estimated_in || null,
    actualIn: raw.actual_in || null,
    latitude: Number.isFinite(latitude) ? latitude : null,
    longitude: Number.isFinite(longitude) ? longitude : null,
    altitudeFt: Number.isFinite(Number(raw.altitude)) ? Number(raw.altitude) : null,
    groundspeedKts: Number.isFinite(Number(raw.groundspeed)) ? Number(raw.groundspeed) : null,
    heading: Number.isFinite(Number(raw.heading)) ? Number(raw.heading) : null,
    inboundFlightId: raw.inbound_fa_flight_id || null,
  };
}

function queryIdent(req) {
  const url = new URL(req.url || '/', 'http://localhost');
  const ident = String(url.searchParams.get('ident') || '').trim().toUpperCase();
  return /^[A-Z0-9-]{2,64}$/.test(ident) ? ident : null;
}

/** Server-only AeroAPI broker. It returns a small, safe flight shape only. */
export function flightAwareProxy({ fetchImpl = fetch } = {}) {
  const maxPerMinute = Math.max(1, Number(process.env.GEV_RATELIMIT_FLIGHTAWARE_PER_MIN) || 12);
  const allow = makeRateLimiter({ windowMs: 60_000, max: maxPerMinute, globalMax: maxPerMinute * 40 });
  const send = (res, status, payload) => {
    if (res.headersSent) return;
    res.writeHead(status, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
    res.end(JSON.stringify(payload));
  };
  const lookup = async (ident) => {
    const now = Date.now();
    const cached = cache.get(ident);
    if (cached && now - cached.at < CACHE_TTL_MS) return cached.payload;
    const work = coalesceProxyRequest(inFlight, ident, async () => {
      const response = await fetchImpl(
        `https://aeroapi.flightaware.com/aeroapi/flights/${encodeURIComponent(ident)}?max_pages=1`,
        { headers: { 'x-apikey': process.env.FLIGHTAWARE_API_KEY }, signal: AbortSignal.timeout(8000) },
      );
      if (!response.ok) throw Object.assign(new Error('upstream unavailable'), { status: response.status });
      const body = await readResponseJsonCapped(response, MAX_RESPONSE_BYTES);
      const flights = Array.isArray(body?.flights) ? body.flights.map(normalizeFlight).filter(Boolean) : [];
      const payload = { found: flights.length > 0, flight: flights[0] || null };
      cache.set(ident, { at: Date.now(), payload });
      if (cache.size > 128) cache.delete(cache.keys().next().value);
      return payload;
    });
    return work.promise;
  };
  const install = (server) => {
    server.middlewares.use('/api/flightaware', async (req, res) => {
      if (req.method !== 'GET') return send(res, 405, { error: 'method_not_allowed' });
      if (!process.env.FLIGHTAWARE_API_KEY) return send(res, 503, { error: 'key_required' });
      if (!allow(clientKey(req))) return send(res, 429, { error: 'rate_limited' });
      const ident = queryIdent(req);
      if (!ident) return send(res, 400, { error: 'invalid_flight_identifier' });
      try { return send(res, 200, await lookup(ident)); }
      catch (error) {
        const status = error?.status === 404 ? 404 : 502;
        return send(res, status, { error: status === 404 ? 'not_found' : 'provider_unavailable' });
      }
    });
  };
  return {
    name: 'flightaware-proxy',
    configureServer: install,
    configurePreviewServer: install,
  };
}
