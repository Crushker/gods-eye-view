/** Visible, keyboard-accessible exit for street-vehicle following. */
export function createTrafficFollowControls({ viewer, trafficLayer }) {
  const panel = document.createElement('div');
  panel.className = 'traffic-follow-controls';
  panel.setAttribute('role', 'region');
  panel.setAttribute('aria-label', 'Vehicle following');
  const label = document.createElement('span');
  label.textContent = 'Following simulated vehicle';
  const stop = document.createElement('button');
  stop.type = 'button';
  stop.textContent = 'Stop following (Esc)';
  stop.addEventListener('click', () => trafficLayer.stopTracking());
  panel.append(label, stop);
  document.body.append(panel);
  const refresh = () => {
    const info = trafficLayer.getTrackedInfo?.();
    panel.hidden = !info || viewer.trackedEntity?.gevTrackedId !== info.id;
  };
  const removeChanged = viewer.trackedEntityChanged.addEventListener(refresh);
  refresh();
  return {
    destroy() {
      removeChanged();
      panel.remove();
    },
  };
}
