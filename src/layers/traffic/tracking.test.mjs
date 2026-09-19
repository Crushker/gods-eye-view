import test from 'node:test';
import assert from 'node:assert/strict';
import * as Cesium from 'cesium';
import * as picking from '../../data/pickRegistry.js';
import { createTracking } from './tracking.js';
import { createAnimation } from './animation.js';
import { createViewport } from './viewport.js';

function setup() {
  let tracked;
  let resets = 0;
  const viewer = {
    entities: new Cesium.EntityCollection(),
    trackedEntityChanged: new Cesium.Event(),
    get trackedEntity() {
      return tracked;
    },
    set trackedEntity(value) {
      tracked = value;
      this.trackedEntityChanged.raiseEvent(value);
    },
    camera: {
      cancelFlight() {},
      lookAtTransform() {
        resets++;
      },
    },
    scene: {
      requestRender() {},
      pick() {
        return null;
      },
    },
  };
  const state = { _viewer: viewer, _enabled: true, _loadGeneration: 1 };
  const parts = {
    ingestion: { cancelActiveFetch() {} },
    rendering: { removeHeatLines() {} },
  };
  const tracking = createTracking({
    state,
    parts,
    services: { picking },
    createHandler: () => ({ setInputAction() {}, destroy() {} }),
  });
  parts.tracking = tracking;
  tracking.enable(viewer);
  const road = {
    type: 'primary',
    waypoints: [
      Cesium.Cartesian3.fromDegrees(72.98, 19.26, 10),
      Cesium.Cartesian3.fromDegrees(72.981, 19.26, 10),
    ],
    segmentDist: [100],
  };
  function addDot() {
    const dot = {
      road,
      point: { position: Cesium.Cartesian3.clone(road.waypoints[0]) },
      mps: 10,
      stoppedUntil: 0,
      waypoints: road.waypoints,
      segmentDist: road.segmentDist,
      numSegments: 1,
      segIdx: 0,
      t: 0.5,
      direction: 1,
    };
    tracking.registerDot(dot);
    return dot;
  }
  return { viewer, state, parts, tracking, addDot, resets: () => resets };
}

test('a vehicle follows its moving position and switches without leaving entities behind', () => {
  const h = setup();
  try {
    const first = h.addDot();
    const second = h.addDot();
    assert.equal(h.tracking.methods.trackVehicle(first.id), true);
    first.point.position = Cesium.Cartesian3.fromDegrees(72.982, 19.26, 10);
    assert.deepEqual(
      h.viewer.trackedEntity.position.getValue(Cesium.JulianDate.now()),
      first.point.position,
    );
    assert.equal(
      h.viewer.trackedEntity.trackingReferenceFrame,
      Cesium.TrackingReferenceFrame.ENU,
    );
    h.tracking.methods.trackVehicle(second.id);
    assert.equal(h.viewer.entities.values.length, 1);
    assert.equal(h.tracking.methods.getTrackedInfo().id, second.id);
    h.tracking.methods.stopTracking();
    assert.equal(h.viewer.trackedEntity, undefined);
    assert.equal(h.viewer.entities.values.length, 0);
  } finally {
    h.tracking.disable();
  }
});

test('data claims remain simulated even with a healthy TomTom feed; stopped dots report zero', () => {
  const h = setup();
  try {
    const dot = h.addDot();
    h.state._liveMode = true;
    dot.road.flow = { level: 0.8 };
    h.tracking.methods.trackVehicle(dot.id);
    assert.equal(h.tracking.methods.getTrackedInfo().simulated, true);
    assert.equal(h.tracking.methods.getTrackedInfo().flowBased, true);
    assert.match(h.viewer.trackedEntity.gevLabelModel.title, /SIMULATED/);
    dot.stoppedUntil = Date.now() + 1000;
    assert.equal(h.tracking.methods.getTrackedInfo().speedKmh, 0);
    h.state._flowError = 'Unavailable';
    assert.equal(h.tracking.methods.getTrackedInfo().flowBased, false);
  } finally {
    h.tracking.disable();
  }
});

test('camera ownership changes clean up vehicle follow without moving the new camera', () => {
  const h = setup();
  try {
    h.tracking.methods.trackVehicle(h.addDot().id);
    const aircraft = new Cesium.Entity();
    h.viewer.trackedEntity = aircraft;
    assert.equal(h.tracking.methods.getTrackedInfo(), null);
    assert.equal(h.viewer.trackedEntity, aircraft);
    assert.equal(h.resets(), 0);
    assert.equal(h.viewer.entities.values.length, 0);
    h.tracking.methods.trackVehicle(h.addDot().id);
    h.viewer.trackedEntity = undefined; // explicit navigation
    assert.equal(h.tracking.isTracking(), false);
  } finally {
    h.tracking.disable();
  }
});

test('drag gestures and sibling picks preserve follow; blank clicks release it', () => {
  const h = setup();
  try {
    const dot = h.addDot();
    h.tracking.methods.trackVehicle(dot.id);
    h.tracking.onClick({}, { travelPx: 20, durationMs: 100 });
    assert.equal(h.tracking.isTracking(), true);
    picking.registerPickOwner('test-aircraft', (id) => id === 'aircraft');
    h.viewer.scene.pick = () => ({ id: 'aircraft' });
    h.tracking.onClick({}, { travelPx: 0, durationMs: 100 });
    assert.equal(h.tracking.isTracking(), true);
    assert.equal(picking.isOwnedByOtherLayer('flights', dot.id), true);
    h.viewer.scene.pick = () => null;
    h.tracking.onClick({}, { travelPx: 0, durationMs: 100 });
    assert.equal(h.tracking.isTracking(), false);
  } finally {
    picking.unregisterPickOwner('test-aircraft');
    h.tracking.disable();
  }
});

test('following prevents camera-triggered road respawns and clearing dots releases tracking', () => {
  const h = setup();
  try {
    h.tracking.methods.trackVehicle(h.addDot().id);
    createViewport({ state: h.state, parts: h.parts }).onCameraChanged();
    assert.equal(h.state._fetchTimeout, undefined);
    createAnimation({ state: h.state, parts: h.parts }).clearDots();
    assert.equal(h.viewer.trackedEntity, undefined);
    assert.equal(h.viewer.entities.values.length, 0);
  } finally {
    h.tracking.disable();
  }
});

for (const direction of [1, -1]) {
  test(`road-end recycling releases the camera before the position jumps (${direction})`, () => {
    const h = setup();
    try {
      const dot = h.addDot();
      dot.direction = direction;
      dot.t = direction === 1 ? 0.9999 : 0.0001;
      h.state._dots = [dot];
      h.state._scratchLerp = new Cesium.Cartesian3();
      h.tracking.methods.trackVehicle(dot.id);
      createAnimation({ state: h.state, parts: h.parts }).animate();
      assert.equal(h.tracking.isTracking(), false);
      assert.equal(h.viewer.trackedEntity, undefined);
    } finally {
      h.tracking.disable();
    }
  });
}
