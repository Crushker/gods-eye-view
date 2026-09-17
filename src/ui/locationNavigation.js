import * as Cesium from 'cesium';
import { createStateChannel } from '../app/stateChannel.js';
import { LocationControls } from './location.js';

/** Own destination selection, lookup, orbit and world-jump lifetime. */
export class LocationNavigation {
  constructor({
    viewer,
    placeSearch,
    services,
    elements,
    navigation,
    readCockpit,
    operations,
  }) {
    Object.assign(
      this,
      { viewer, placeSearch, services, navigation, readCockpit },
      elements,
      operations,
    );
    this._disposed = false;
    this._activeLocationId = null;
    this._expandedCityId = null;
    this._activePoiIndex = null;
    this._currentTarget = null;
    this._currentPoi = null;
    this._searchedLocationLabel = null;
    this._trafficTransitionTimer = null;
    this._globeResetPromise = null;
    this._cancelGlobeReset = null;
    this._worldJumpActive = false;
    this._favourites = this._loadFavourites();
    this.orbitController = new services.OrbitController(viewer);
    this._orbitIndicator = null;
    this._locationState = createStateChannel(
      () => this._locationLookup?.getState() || null,
    );
    this._locationState.subscribe(
      ({ state, change }) => this._handleLocationSearchState(state, change),
      { emitCurrent: false },
    );
  }
  get cockpitView() {
    return this.readCockpit();
  }
  get _navigationGeneration() {
    return this.navigation._navigationGeneration;
  }
  get _activeLocationSearchGeneration() {
    return this.navigation._activeLocationSearchGeneration;
  }
  set _activeLocationSearchGeneration(value) {
    this.navigation._activeLocationSearchGeneration = value;
  }

  setOrbit(enabled) {
    const active = !!this.orbitController?.active;
    if (typeof enabled === 'boolean' && enabled === active) {
      return { ok: true, orbiting: active };
    }
    if (enabled === false) {
      this._stopOrbit();
      return { ok: true, orbiting: false };
    }
    if (!this._currentTarget) {
      return {
        ok: false,
        orbiting: false,
        error: 'No active landmark to orbit — fly to a landmark first',
      };
    }
    this._toggleOrbit();
    return { ok: true, orbiting: !!this.orbitController?.active };
  }

  subscribeLocationSearch(listener, options) {
    return this._locationState.subscribe(listener, options);
  }

  _handleLocationSearchState(state, change) {
    if (this._disposed || !change) return;
    if (change.type === 'started')
      this._activeLocationSearchGeneration = change.generation;
    else if (change.type === 'found') {
      this._searchedLocationLabel = state.destination.label || state.query;
      this._setActiveLocation(null);
      this._currentPoi = null;
      this._collapsePOIRow();
      this._updateLocationMiniStatus();
    } else if (change.type === 'missing') this._showToast('Location not found');
    else if (change.type === 'failed') this._showToast('Search failed');
    else if (change.type === 'settled')
      this._settleLocationSearchUi(change.generation);
    else if (
      change.type === 'reset' &&
      this._activeLocationSearchGeneration !== null
    ) {
      this._settleLocationSearchUi(this._activeLocationSearchGeneration);
    }
  }

  _initLocationBar() {
    const { CITY_POIS, searchAndFlyTo, LocationSearch } = this.services;
    this._locationControls?.destroy();
    this._locationLookupUnsubscribe?.();
    this._locationLookup?.destroy();
    this._locationLookup = new LocationSearch({
      input: this._locationSearch,
      begin: () => this._beginDeferredNavigation('location'),
      isCurrent: (generation) =>
        !this._disposed && generation === this._navigationGeneration,
      beforeFly: (generation) => this._reassertNavigationHandoff(generation),
      search: (query, options) =>
        searchAndFlyTo(this.viewer, query, {
          placeSearch: this.placeSearch,
          ...options,
        }),
      onError: (error) => console.error('[Search] Geocoding failed:', error),
    });
    this._locationLookupUnsubscribe = this._locationLookup.subscribe(
      ({ initial, change }) => {
        this._locationState.publish(initial ? { type: 'reset' } : change);
      },
    );
    this._locationControls = new LocationControls({
      elements: {
        pills: this._locationPills,
        poiRow: this._poiRow,
        divider: this._locationBarDivider,
        search: this._locationSearch,
        searchToggle: this._searchToggle,
        resetButtons: [this._resetGlobeBtn, this._cockpitResetGlobeBtn],
        statusCity: this._locationMiniCity,
        statusPoi: this._locationMiniPoi,
        favourites: this._locationFavourites,
        favouritesToggle: this._locationFavouritesToggle,
        favouriteAdd: this._locationFavouriteAdd,
        favouriteForm: this._locationFavouriteForm,
        favouriteName: this._locationFavouriteName,
      },
      cities: CITY_POIS,
      getExpandedCity: () => this._expandedCityId,
      onCity: (id) => this._onCityPillClick(id),
      onPoi: (id, index) => this._onPoiClick(id, index),
      onSearch: (query) => this._locationLookup.run(query),
      onReset: () => this.resetToGlobeView(),
      onAddFavourite: (name) => this._addFavourite(name),
      onFavourite: (favourite) => this._goFavourite(favourite),
      onRemoveFavourite: (id) => this._removeFavourite(id),
    });
    this._locationControls.renderFavourites(this._favourites);
    this._initFlightSearch();
  }

  /**
   * Keep flight-search providers mutually exclusive. The live layer remains
   * responsible for rendering/following contacts; this form merely hands it a
   * user-supplied callsign or transponder identity. FlightAware is deliberately
   * not treated as a fallback: it will receive its own server-side lookup once
   * a Personal AeroAPI key is configured.
   */
  _initFlightSearch() {
    const form = this._flightSearchForm;
    if (!form) return;
    this._flightSearchSubmit = async (event) => {
      event.preventDefault();
      const query = String(this._flightSearchInput?.value || '')
        .trim()
        .toUpperCase()
        .replace(/\s+/g, '');
      if (!query) {
        this._setFlightSearchStatus('Enter a flight number or callsign first.');
        this._flightSearchInput?.focus();
        return;
      }
      const provider = this._flightProvider?.value || 'opensky';
      if (provider === 'flightaware') {
        clearTimeout(this._flightAwareRefreshTimer);
        await this._lookupFlightAware(query);
        return;
      }
      clearTimeout(this._flightAwareRefreshTimer);

      this._setFlightSearchStatus(`Looking for ${query} in live OpenSky / ADS-B contacts…`);
      try {
        await this.navigation.getDataManager?.()?.setEnabled('flights', true, {
          origin: 'user',
        });
        // A search can be the first action that enables Flights. Refresh before
        // inspecting the record map so a real aircraft is not reported missing
        // merely because the normal polling timer has not reached its first tick.
        await this.services.flightsLayer?.update?.(this.viewer);
        const match = this.services.flightsLayer?.findByQuery?.(query);
        if (!match) {
          this._setFlightSearchStatus(
            `No live match for ${query} yet. Try again after departure, or choose FlightAware for a scheduled flight.`,
          );
          return;
        }
        const followed = this.services.flightsLayer.trackById?.(match.icao24, {
          origin: 'user',
        });
        if (!followed) {
          this._setFlightSearchStatus(`Found ${query}, but its latest position is no longer available.`);
          return;
        }
        // A selected entity can already be tracked (for example after a second
        // press of TRACK). Reapplying its canonical frame guarantees that a
        // flight search always also moves the viewer to the selected aircraft.
        this.services.flightsLayer.refocusTrackedById?.(match.icao24, {
          origin: 'user',
        });
        this._setFlightSearchStatus(`Following ${match.callsign || query} live.`);
        this._showToast(`Following ${match.callsign || query}`);
      } catch {
        this._setFlightSearchStatus('Live flight source is temporarily unavailable. Please try again.');
      }
    };
    form.addEventListener('submit', this._flightSearchSubmit);
    this._flightIncomingSubmit = () => {
      if (this._flightAwareInboundId) void this._lookupFlightAware(this._flightAwareInboundId, { incoming: true });
    };
    this._flightIncomingTrack?.addEventListener('click', this._flightIncomingSubmit);
  }

  _setFlightSearchStatus(message) {
    if (this._flightSearchStatus) this._flightSearchStatus.textContent = message;
  }

  async _lookupFlightAware(ident, { incoming = false } = {}) {
    this._setFlightSearchStatus(`Looking up ${ident} with FlightAware…`);
    this._flightIncomingTrack.hidden = true;
    try {
      const response = await fetch(`/api/flightaware?ident=${encodeURIComponent(ident)}`);
      const payload = await response.json().catch(() => ({}));
      if (response.status === 503 && payload.error === 'key_required') {
        this._setFlightSearchStatus('FlightAware needs an AeroAPI key. Open POWER UP and save FLIGHTAWARE_API_KEY.');
        return;
      }
      if (!response.ok || !payload.found || !payload.flight) {
        this._setFlightSearchStatus(`FlightAware could not find ${ident} right now.`);
        return;
      }
      const flight = payload.flight;
      const route = `${flight.origin?.code || '—'} → ${flight.destination?.code || '—'}`;
      const when = flight.actualOut || flight.estimatedOut || flight.scheduledOut;
      this._setFlightSearchStatus(`${flight.ident || ident} · ${route} · ${flight.status}${when ? ` · ${new Date(when).toLocaleString()}` : ''}`);
      this._flightAwareInboundId = flight.inboundFlightId || null;
      if (!incoming && this._flightAwareInboundId && this._flightIncomingTrack) {
        this._flightIncomingTrack.hidden = false;
        this._flightIncomingTrack.textContent = 'TRACK INCOMING AIRCRAFT';
      }
      if (Number.isFinite(flight.latitude) && Number.isFinite(flight.longitude))
        this._followFlightAware(flight);
      else this._scheduleFlightAwareRefresh(flight.id || ident, 60_000);
    } catch {
      this._setFlightSearchStatus('FlightAware is temporarily unavailable. Please try again.');
    }
  }

  _followFlightAware(flight) {
    this._flightAwarePosition = Cesium.Cartesian3.fromDegrees(
      flight.longitude,
      flight.latitude,
      Math.max(0, Number(flight.altitudeFt || 0) * 0.3048),
    );
    if (!this._flightAwareEntity) {
      this._flightAwareEntity = this.viewer.entities.add({
        id: 'flightaware-tracked-flight',
        position: new Cesium.CallbackProperty(() => this._flightAwarePosition, false),
        point: { pixelSize: 12, color: Cesium.Color.CYAN, outlineColor: Cesium.Color.WHITE, outlineWidth: 2 },
        label: { text: flight.ident || 'FLIGHT', font: '12px sans-serif', fillColor: Cesium.Color.WHITE, pixelOffset: new Cesium.Cartesian2(0, -18) },
      });
      this._flightAwareEntity.viewFrom = new Cesium.Cartesian3(0, -14_000, 7_000);
    } else if (this._flightAwareEntity.label) {
      this._flightAwareEntity.label.text = flight.ident || 'FLIGHT';
    }
    this.viewer.camera.cancelFlight();
    this.viewer.trackedEntity = this._flightAwareEntity;
    this._showToast(`Following ${flight.ident || 'FlightAware flight'}`);
    this._scheduleFlightAwareRefresh(flight.id || flight.ident, 30_000);
  }

  _scheduleFlightAwareRefresh(reference, delayMs) {
    clearTimeout(this._flightAwareRefreshTimer);
    if (!reference || this._disposed) return;
    this._flightAwareRefreshTimer = setTimeout(() => {
      void this._lookupFlightAware(reference);
    }, delayMs);
  }

  _beginWorldJumpTransition() {
    const { suspendDetection, trafficLayer } = this.services;
    clearTimeout(this._trafficTransitionTimer);
    this._worldJumpActive = true;
    trafficLayer.beginWorldJump?.();
    suspendDetection('intercity');
  }

  _endWorldJumpTransition() {
    const { resumeDetection, trafficLayer } = this.services;
    clearTimeout(this._trafficTransitionTimer);
    this._worldJumpActive = false;
    this._trafficTransitionTimer = null;
    trafficLayer.endWorldJump?.();
    resumeDetection();
    this._updateTrafficSyncChip(true);
  }

  _flyWithTransition(cityChanged, flyAction) {
    return this._runExplicitNavigation('location', () => {
      if (!cityChanged) return flyAction({});
      let completed = false;
      const finalize = () => {
        if (completed || this._disposed) return;
        completed = true;
        this._endWorldJumpTransition();
        this._syncCameraToLocation();
      };
      const result = flyAction({
        onStart: () => this._beginWorldJumpTransition(),
        onComplete: finalize,
      });
      this._trafficTransitionTimer = window.setTimeout(finalize, 5200);
      return result;
    });
  }

  _onCityPillClick(cityId) {
    const { CITY_POIS, flyToPresetLocation } = this.services;
    if (this._expandedCityId === cityId) {
      // Same city clicked again — toggle collapse
      this._collapsePOIRow();
      return;
    }

    const isCityChanged =
      this._activeLocationId && this._activeLocationId !== cityId;
    const result = this._flyWithTransition(!!isCityChanged, (hooks) =>
      flyToPresetLocation(this.viewer, cityId, hooks),
    );
    if (result === false) return;
    this._expandPOIRow(cityId);
    this._setActiveLocation(cityId);
    this._activePoiIndex = 0;
    this._updatePoiHighlight();

    // Track current target + POI for orbit
    if (result) {
      this._currentTarget = result.targetPosition;
      this._currentPoi = CITY_POIS[cityId].pois[0];
    }
    this._updateLocationMiniStatus();
  }

  _onPoiClick(cityId, poiIndex) {
    const { CITY_POIS, flyToPOI } = this.services;
    const isCityChanged =
      this._activeLocationId && this._activeLocationId !== cityId;
    const result = this._flyWithTransition(!!isCityChanged, (hooks) =>
      flyToPOI(this.viewer, cityId, poiIndex, hooks),
    );
    if (result === false) return;
    this._setActiveLocation(cityId);
    this._activePoiIndex = poiIndex;
    this._updatePoiHighlight();

    // Track current target + POI for orbit
    if (result) {
      this._currentTarget = result.targetPosition;
      this._currentPoi = CITY_POIS[cityId].pois[poiIndex];
    }
    this._updateLocationMiniStatus();
  }

  _expandPOIRow(cityId) {
    const { CITY_POIS } = this.services;
    if (!CITY_POIS[cityId]) return;
    this._expandedCityId = cityId;
    this._locationControls.showPois(cityId);
  }

  _collapsePOIRow() {
    this._expandedCityId = null;
    this._activePoiIndex = null;
    this._locationControls.hidePois();
  }

  _updatePoiHighlight() {
    this._locationControls.highlightPoi(this._activePoiIndex);
  }

  clearSearchedLocation() {
    if (this._searchedLocationLabel === null) return;
    this._searchedLocationLabel = null;
    this._updateLocationMiniStatus();
  }

  _setActiveLocation(locationId) {
    this._activeLocationId = locationId;
    // A preset city is now what the camera is framed on, so any earlier
    // free-text destination has been superseded. Clearing only on a real id
    // leaves the search path's own _setActiveLocation(null) untouched.
    if (locationId) this._searchedLocationLabel = null;
    this._locationControls?.highlightCity(locationId);
    this._updateLocationMiniStatus();
  }

  _updateLocationMiniStatus() {
    const { CITY_POIS } = this.services;
    this._locationControls?.renderStatus({
      city: this._activeLocationId ? CITY_POIS[this._activeLocationId] : null,
      currentPoi: this._currentPoi,
      searchedLabel: this._searchedLocationLabel,
    });
  }

  _syncCameraToLocation() {
    // Camera catalogues are regional. Never leave a feed selected merely
    // because it is the closest camera on a different continent.
    this.services.cctvLayer?.selectNearbyToViewer?.(35);
  }

  _loadFavourites() {
    try {
      const value = JSON.parse(localStorage.getItem('gev-location-favourites') || '[]');
      return Array.isArray(value)
        ? value.filter((entry) => entry && Number.isFinite(entry.lat) && Number.isFinite(entry.lon) && typeof entry.name === 'string')
        : [];
    } catch { return []; }
  }

  _saveFavourites() {
    try { localStorage.setItem('gev-location-favourites', JSON.stringify(this._favourites)); } catch { /* storage unavailable */ }
    this._locationControls?.renderFavourites(this._favourites);
  }

  _addFavourite(name) {
    const carto = this.viewer.camera.positionCartographic;
    if (!carto) return false;
    const lat = Number(Cesium.Math.toDegrees(carto.latitude).toFixed(6));
    const lon = Number(Cesium.Math.toDegrees(carto.longitude).toFixed(6));
    const label = String(name || '').trim() || `Location ${lat.toFixed(3)}, ${lon.toFixed(3)}`;
    this._favourites.push({ id: `${Date.now()}-${Math.random().toString(36).slice(2, 7)}`, name: label, lat, lon });
    this._saveFavourites();
    this._showToast(`Saved ${label}`);
    return true;
  }

  _removeFavourite(id) {
    this._favourites = this._favourites.filter((favourite) => favourite.id !== id);
    this._saveFavourites();
  }

  _goFavourite(favourite) {
    const { flyToLandmark } = this.services;
    if (!favourite || typeof flyToLandmark !== 'function') return;
    this._flyWithTransition(true, (hooks) => flyToLandmark(this.viewer, favourite.lat, favourite.lon, {
      range: 800, pitch: -30, heading: 0, buildingHeight: 0, ...hooks,
    }));
    this._searchedLocationLabel = favourite.name;
    this._setActiveLocation(null);
  }

  _initOrbit() {
    this._orbitIndicator = this._locationControls.createOrbitIndicator();
  }

  _toggleOrbit() {
    if (!this._currentTarget) {
      this._showToast('Fly to a POI first');
      return;
    }

    const isActive = this.orbitController.toggle(this._currentTarget, {
      radius: this._currentPoi?.alt || 500,
      pitch: this._currentPoi?.pitch || -30,
    });

    this._orbitIndicator.classList.toggle('active', isActive);
  }

  _stopOrbit() {
    if (this.orbitController.active) {
      this.orbitController.stop();
      this._orbitIndicator.classList.remove('active');
    }
  }

  resetToGlobeView() {
    const {
      GLOBE_VIEW,
      flyToGlobeView,
      interruptCameraMotion,
      flightsLayer,
      militaryFlightsLayer,
      satellitesLayer,
      aisLiveVesselsLayer,
      militaryAwarenessLayer,
      rocketLaunchesLayer,
    } = this.services;
    if (this._disposed)
      return Promise.resolve({
        ok: false,
        action: 'zoom_to_globe',
        cancelled: true,
      });
    if (this._globeResetPromise) return this._globeResetPromise;
    this._stampNavigation();
    interruptCameraMotion('reset-globe');
    this._stopOrbit();
    this.cockpitView?.exit({ restoreTracking: false });
    try {
      militaryAwarenessLayer.releaseCameraOwnership?.({ origin: 'tool' });
    } catch {
      // Keep reset available if Context has not initialized completely.
      try {
        flightsLayer.stopTracking?.({ origin: 'tool' });
      } catch {
        /* best-effort release */
      }
      try {
        militaryFlightsLayer.stopTracking?.({ origin: 'tool' });
      } catch {
        /* best-effort release */
      }
      try {
        aisLiveVesselsLayer.clearSelection?.();
      } catch {
        /* best-effort release */
      }
    }
    try {
      satellitesLayer.stopTracking?.({ origin: 'tool' });
    } catch {
      /* best-effort release */
    }
    try {
      rocketLaunchesLayer.releaseCameraOwnership?.();
    } catch {
      /* best-effort release */
    }
    this.viewer.trackedEntity = undefined;
    this.viewer.camera.cancelFlight();
    this.viewer.camera.lookAtTransform(Cesium.Matrix4.IDENTITY);
    this._beginWorldJumpTransition();

    let resolveReset;
    const resetPromise = new Promise((resolve) => {
      resolveReset = resolve;
    });
    this._globeResetPromise = resetPromise;
    let settled = false;
    let timer = null;
    const finish = (cancelled = false) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      this._endWorldJumpTransition();
      const carto = this.viewer.camera.positionCartographic;
      const result = {
        ok: !cancelled,
        action: 'zoom_to_globe',
        cancelled,
        heightKm: Math.round(GLOBE_VIEW.heightM / 1000),
        centeredOn: {
          latitude: Number(Cesium.Math.toDegrees(carto.latitude).toFixed(2)),
          longitude: Number(Cesium.Math.toDegrees(carto.longitude).toFixed(2)),
        },
      };
      this._resetGlobeBtn?.setAttribute(
        'aria-label',
        'Reset to full globe view',
      );
      this._cockpitResetGlobeBtn?.setAttribute(
        'aria-label',
        'Reset cockpit to full globe view',
      );
      this._globeResetPromise = null;
      this._cancelGlobeReset = null;
      resolveReset(result);
    };
    this._cancelGlobeReset = () => finish(true);
    timer = window.setTimeout(() => {
      const height = this.viewer.camera.positionCartographic?.height;
      finish(
        !Number.isFinite(height) ||
          Math.abs(height - GLOBE_VIEW.heightM) > 1000,
      );
    }, 4200);
    this._resetGlobeBtn?.setAttribute(
      'aria-label',
      'Resetting to full globe view',
    );
    this._cockpitResetGlobeBtn?.setAttribute(
      'aria-label',
      'Resetting cockpit to full globe view',
    );
    const target = flyToGlobeView(this.viewer, {
      onComplete: () => finish(false),
      onCancel: () => finish(true),
    });
    if (!target) finish(true);
    return resetPromise;
  }

  /** Revoke callbacks and settle owned camera work before the viewer is released. */
  destroy() {
    this._flightSearchForm?.removeEventListener('submit', this._flightSearchSubmit);
    this._flightIncomingTrack?.removeEventListener('click', this._flightIncomingSubmit);
    clearTimeout(this._flightAwareRefreshTimer);
    if (this._flightAwareEntity) this.viewer.entities.remove(this._flightAwareEntity);
    if (this._disposed) return;
    this._disposed = true;
    this._locationState.destroy();
    this._locationLookupUnsubscribe?.();
    this._locationLookupUnsubscribe = null;
    this._locationLookup?.destroy();
    this._locationControls?.destroy();
    this._cancelGlobeReset?.();
    this._cancelGlobeReset = null;
    if (this._worldJumpActive) this._endWorldJumpTransition();
    clearTimeout(this._trafficTransitionTimer);
    this._trafficTransitionTimer = null;
    this.orbitController?.stop();
  }
}
