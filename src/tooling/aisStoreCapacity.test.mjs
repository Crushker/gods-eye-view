import test from 'node:test';
import assert from 'node:assert/strict';
import {
  AISSTREAM_CACHE_MAX,
  ingestAisStreamEnvelope,
  aisStreamRows,
} from '../../server/providers/vessels/ais-store.js';

test('static-only AIS records are bounded and old metadata is evicted', () => {
  for (let index = 0; index <= AISSTREAM_CACHE_MAX; index++) {
    ingestAisStreamEnvelope({
      MessageType: 'ShipStaticData',
      MetaData: { MMSI: String(100_000_000 + index) },
      Message: {
        ShipStaticData: {
          UserID: 100_000_000 + index,
          Name: `VESSEL ${index}`,
        },
      },
    });
  }

  ingestAisStreamEnvelope({
    MessageType: 'PositionReport',
    MetaData: {
      MMSI: '100000000',
      latitude: 19.26,
      longitude: 72.98,
      time_utc: new Date().toISOString(),
    },
    Message: { PositionReport: { UserID: 100000000 } },
  });

  assert.equal(
    aisStreamRows(AISSTREAM_CACHE_MAX)[0].name,
    'MMSI 100000000',
    'metadata older than the bounded live cache must not stay resident forever',
  );
});
