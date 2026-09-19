import * as Cesium from 'cesium';
import {
  bindTrackingClickGesture,
  isTrackingClickGesture,
  isTrackingSelectionGesture,
} from '../../data/trackingClickGesture.js';

/** Follow one rendered traffic simulation, never an identified real vehicle. */
export function createTracking({
  state,
  services,
  parts,
  createHandler = (canvas) => new Cesium.ScreenSpaceEventHandler(canvas),
}) {
  let selected = null;
  let entity = null;
  let handler = null;
  let removeChanged = null;
  let sequence = 0;
  let lastLabel = '';
  const dots = new Map();
  const picking = services.picking;

  function registerDot(dot) {
    dot.id = `traffic:vehicle:${++sequence}`;
    dot.point.id = dot.id;
    dots.set(dot.id, dot);
  }

  function getTrackedInfo() {
    if (!selected) return null;
    const stopped =
      Date.now() < selected.stoppedUntil || selected.creep?.moving === false;
    return {
      id: selected.id,
      simulated: true,
      speedKmh: stopped ? 0 : selected.mps * 3.6,
      roadType: selected.road.type,
      flowBased: Boolean(
        state._liveMode && selected.road.flow && !state._flowError,
      ),
    };
  }

  function updateReadout() {
    const info = getTrackedInfo();
    if (!info || !entity) return;
    const details = [
      `${Math.round(info.speedKmh)} km/h simulated · ${info.roadType || 'road'}`,
      info.flowBased ? 'Animation based on TomTom flow' : 'Simulated traffic',
      'Escape to stop following',
    ];
    const label = details.join('\n');
    if (label === lastLabel) return;
    lastLabel = label;
    entity.gevLabelModel = {
      title: 'Following vehicle · SIMULATED',
      details,
      accent: '#39d0ff',
    };
    services.readout?.refreshTrackedReadout(entity);
  }

  function stopTracking() {
    const previous = entity;
    if (!previous) return false;
    // Clear local ownership before raising Cesium's synchronous change event.
    selected = null;
    entity = null;
    lastLabel = '';
    const viewer = state._viewer;
    if (viewer.trackedEntity === previous) {
      viewer.trackedEntity = undefined;
      viewer.camera.lookAtTransform(Cesium.Matrix4.IDENTITY);
    }
    viewer.entities.remove(previous);
    viewer.scene.requestRender();
    return true;
  }

  function trackVehicle(id) {
    const dot = dots.get(id);
    const viewer = state._viewer;
    if (!state._enabled || !dot || !viewer) return false;
    if (dot === selected) return true;
    stopTracking();
    // Keep this simulation's identity stable while following. A delayed road
    // request must not respawn every dot underneath the selected target.
    clearTimeout(state._fetchTimeout);
    clearTimeout(state._retryTimer);
    state._retryTimer = null;
    parts.ingestion.cancelActiveFetch();
    state._loadGeneration++;
    state._fetching = false;
    state._flowPending = 0;
    selected = dot;
    entity = viewer.entities.add({
      id: `${dot.id}:follow`,
      name: 'Simulated street vehicle',
      position: new Cesium.CallbackPositionProperty(
        (_time, result) => Cesium.Cartesian3.clone(dot.point.position, result),
        false,
      ),
      trackingReferenceFrame: Cesium.TrackingReferenceFrame.ENU,
      viewFrom: new Cesium.Cartesian3(0, -180, 140),
      point: {
        pixelSize: 13,
        color: Cesium.Color.CYAN,
        outlineColor: Cesium.Color.BLACK,
        outlineWidth: 2,
        disableDepthTestDistance: Number.POSITIVE_INFINITY,
      },
    });
    entity.gevSelectionOrigin = 'user';
    entity.gevTrackedId = dot.id;
    entity.gevDisplayPosition = () => dot.point.position;
    updateReadout();
    viewer.camera.cancelFlight();
    viewer.trackedEntity = entity;
    viewer.scene.requestRender();
    return true;
  }

  function onClick(click, gesture) {
    if (!isTrackingSelectionGesture(gesture)) return;
    if (globalThis.document?.body?.classList.contains('cockpit-mode')) return;
    const picked = state._viewer.scene.pick(click.position);
    if (entity && picked?.id === entity) return;
    const id = picking.resolvePickId(picked);
    if (dots.has(id)) {
      trackVehicle(id);
      return;
    }
    if (picking.isOwnedByOtherLayer('traffic', id)) return;
    if (isTrackingClickGesture(gesture)) stopTracking();
  }

  function onKeyDown(event) {
    if (event.key === 'Escape') stopTracking();
  }

  function enable(viewer) {
    // Portable/headless consumers can render traffic without installing input.
    if (handler || !picking) return;
    picking.registerPickOwner(
      'traffic',
      (id) => dots.has(id) || id === entity?.id,
    );
    handler = createHandler(viewer.scene.canvas);
    bindTrackingClickGesture(handler, onClick);
    removeChanged = viewer.trackedEntityChanged.addEventListener(() => {
      if (entity && viewer.trackedEntity !== entity) stopTracking();
    });
    globalThis.document?.addEventListener('keydown', onKeyDown);
  }

  function clear() {
    stopTracking();
    dots.clear();
  }

  function disable() {
    clear();
    handler?.destroy();
    handler = null;
    removeChanged?.();
    removeChanged = null;
    globalThis.document?.removeEventListener('keydown', onKeyDown);
    picking?.unregisterPickOwner('traffic');
  }

  return {
    registerDot,
    updateReadout,
    enable,
    disable,
    clear,
    onClick,
    isTracking: () => Boolean(entity),
    endRoad: (dot) => {
      if (dot === selected) stopTracking();
    },
    methods: { trackVehicle, stopTracking, getTrackedInfo },
  };
}
