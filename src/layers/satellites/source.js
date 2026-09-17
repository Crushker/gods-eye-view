import { celestrakTleUrl } from '../../data/spaceProviderRequests.js';

const GROUPS = new Set([
  'stations',
  'visual',
  'gps-ops',
  'glo-ops',
  'galileo',
  'geo',
  'starlink',
]);

/**
 * Read catalog text through the same-origin proxy first.  CelesTrak explicitly
 * supports CORS for its public TLE catalogue, so a visitor's browser can make
 * a safe read-only fallback request when a cloud host's shared egress address
 * is throttled or blocked.  This is deliberately limited to the public TLE
 * feed; credentials and all private providers remain server-side.
 */
export function createSatelliteSource({
  fetchImpl = (...args) => globalThis.fetch(...args),
} = {}) {
  return {
    async readGroup(group, { signal } = {}) {
      if (!GROUPS.has(group)) throw new TypeError('Unknown satellite group');
      signal?.throwIfAborted();
      let response;
      try {
        response = await fetchImpl(`/api/celestrak/${group}`, { signal });
      } catch {
        response = null;
      }
      if (!response?.ok) {
        signal?.throwIfAborted();
        response = await fetchImpl(celestrakTleUrl(group).toString(), {
          signal,
        });
      }
      const text = response.ok ? await response.text() : '';
      signal?.throwIfAborted();
      return { ok: response.ok, status: response.status, text };
    },
  };
}
