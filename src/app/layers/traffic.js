import { createTrafficLayer } from '../../layers/traffic/index.js';
import * as credits from '../../data/dataCredits.js';
import * as render from '../../renderGovernor.js';
import * as picking from '../../data/pickRegistry.js';
import * as readout from '../../data/trackedReadout.js';

/** Construct one layer using the application scene owners and a supplied source. */
export function createApplicationTraffic({ source }) {
  return createTrafficLayer({
    source,
    services: { credits, render, picking, readout },
  });
}
