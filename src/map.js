// MelbMaps v0.4 — map, layers, search, identify, GPS.
// Extracted verbatim from the original index.html. Requires Leaflet and src/layers.js to load first.
  (function() {
    'use strict';

    const {
      LGAS, INITIAL_CENTER, INITIAL_ZOOM, INIT_BOUNDS,
      WMS_BASE, WFS_BASE,
      LAYER_ZONE, LAYER_OVERLAY, LAYER_PARCELS, LAYER_LOCALITY, LAYER_LGA,
      LAYER_ROADS, LAYER_WATER, LAYER_RAIL,
      normaliseCode, getZoneDescription, getOverlayDescription
    } = window.MelbMapsLayers;

    // ====================================================================
    // STATE — single source of truth
    // ====================================================================
    // Default preset is "planning": zones + overlays + parcels + suburbs ON.
    const state = {
      zones: true, overlays: true, suburbs: true, parcels: true, roads: false, water: false, rail: false, aerial: false, gps: false
    };
    let gpsMarker = null;
    let gpsWatchId = null;
    let searchMarker = null;
    let selectedTapMarker = null;
    let selectedParcelLayer = null;
    let officialSuburbLayer = null;
    const selectedSuburbs = new Map(); // key -> { highlight, label, name }

    // LGA runtime state (populated after WFS load)
    const lgaData = new Map(); // key -> { feature, leafletLayer, bounds, labelMarker }
    let combinedLgaBounds = null;
    let activeLgaKey = null;   // null = "all" / overview state
    let dynamicSuburbs = [];   // [{ name, center, layer }] derived from WFS
    let lastTaglineKey = '';   // throttle helper

    // ====================================================================
    // MAP + PANES
    // ====================================================================
    const map = L.map('map', {
      center: INITIAL_CENTER,
      zoom: INITIAL_ZOOM,
      minZoom: 10,
      maxZoom: 19,
      zoomSnap: 0.25,
      zoomDelta: 0.5,
      doubleClickZoom: false,
      maxBounds: INIT_BOUNDS,
      maxBoundsViscosity: 0.45,
      zoomControl: false,
      attributionControl: true
    });
    L.control.zoom({ position: 'topright' }).addTo(map);

    // Softer double-tap/double-click zoom for mobile. Leaflet's default jumps by
    // a full zoom level, which feels too aggressive in a property/planning map.
    map.on('dblclick', (e) => {
      L.DomEvent.stop(e);
      map.setZoomAround(e.latlng, Math.min(map.getZoom() + 0.5, map.getMaxZoom()), { animate: true });
    });

    // One-finger precision zoom: double-tap, hold the second tap, then drag.
    // Drag down = zoom in. Drag up = zoom out. This is useful on mobile when
    // checking parcels with one hand and is gentler than pinch zoom.
    installDoubleTapDragZoom(map);

    map.createPane('outlinePane');
    map.getPane('outlinePane').style.zIndex = 680;
    map.createPane('lgaPane');
    map.getPane('lgaPane').style.zIndex = 715;
    map.getPane('lgaPane').style.pointerEvents = 'none';
    map.createPane('highlightPane');
    map.getPane('highlightPane').style.zIndex = 720;

    // ====================================================================
    // BASEMAPS
    // ====================================================================
    const osmLayer = L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', {
      maxZoom: 19, attribution: '© OpenStreetMap'
    });
    const aerialLayer = L.tileLayer(
      'https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}',
      { maxZoom: 19, attribution: '© Esri, Maxar' }
    );
    osmLayer.addTo(map);

    // ====================================================================
    // WMS LAYERS
    // ====================================================================
    const zoneLayer = L.tileLayer.wms(WMS_BASE, {
      layers: LAYER_ZONE, format: 'image/png', transparent: true,
      opacity: 0.6, version: '1.1.1', attribution: 'Vicmap Planning · DTP'
    });
    const overlayLayer = L.tileLayer.wms(WMS_BASE, {
      layers: LAYER_OVERLAY, format: 'image/png', transparent: true,
      opacity: 0.5, version: '1.1.1', attribution: 'Vicmap Planning · DTP'
    });
    const parcelLayer = L.tileLayer.wms(WMS_BASE, {
      layers: LAYER_PARCELS, format: 'image/png', transparent: true,
      opacity: 0.9, version: '1.3.0', styles: '',
      attribution: 'Vicmap Property · DTP'
    });
    const suburbOutlineLayer = L.tileLayer.wms(WMS_BASE, {
      layers: LAYER_LOCALITY, format: 'image/png', transparent: true,
      opacity: 1.0, version: '1.3.0', styles: '',
      attribution: 'Vicmap Admin Locality · DTP'
    });
    const roadLayer = L.tileLayer.wms(WMS_BASE, {
      layers: LAYER_ROADS, format: 'image/png', transparent: true,
      opacity: 0.85, version: '1.3.0', styles: '',
      attribution: 'Vicmap Transport · DTP'
    });
    const waterLayer = L.tileLayer.wms(WMS_BASE, {
      layers: LAYER_WATER, format: 'image/png', transparent: true,
      opacity: 0.9, version: '1.3.0', styles: '',
      attribution: 'Vicmap Hydro · DTP'
    });
    const railLayer = L.tileLayer.wms(WMS_BASE, {
      layers: LAYER_RAIL, format: 'image/png', transparent: true,
      opacity: 0.9, version: '1.3.0', styles: '',
      attribution: 'Vicmap Transport Rail · DTP'
    });
    // Localities are on by default to match the layer state
    suburbOutlineLayer.addTo(map);

    // ====================================================================
    // LGA OUTLINES — three LGAs loaded via WFS, with hybrid switcher
    // ====================================================================
    // Style helpers — active LGA renders bold amber, inactive ones dim.
    function lgaStyle(active) {
      return {
        color: '#fbbf24',
        weight: active ? 6 : 3,
        opacity: active ? 1.0 : 0.28,
        fill: false,
        dashArray: active ? '12, 7' : '6, 6',
        lineCap: 'round',
        lineJoin: 'round'
      };
    }

    async function loadOneLga(lga) {
      const params = new URLSearchParams({
        service: 'WFS', version: '1.0.0', request: 'GetFeature',
        typeName: LAYER_LGA, outputFormat: 'application/json',
        CQL_FILTER: lga.wfsFilter
      });
      const res = await fetch(`${WFS_BASE}?${params}`);
      if (!res.ok) throw new Error('HTTP ' + res.status);
      const data = await res.json();
      if (!data.features || !data.features.length) throw new Error('No feature for ' + lga.key);
      const feature = data.features[0];
      const leafletLayer = L.geoJSON(feature, {
        pane: 'lgaPane',
        style: lgaStyle(false),
        interactive: false
      }).addTo(map);
      const bounds = leafletLayer.getBounds();
      const center = bounds.getCenter();
      const labelMarker = L.marker(center, {
        pane: 'lgaPane',
        icon: L.divIcon({
          className: '',
          html: `<div class="lga-label">${escapeHtml(lga.label)}</div>`,
          iconSize: [200, 28], iconAnchor: [100, 14]
        }),
        interactive: false
      }).addTo(map);
      lgaData.set(lga.key, { feature, leafletLayer, bounds, labelMarker, config: lga });
    }

    async function loadAllLgas() {
      try {
        await Promise.all(LGAS.map(lga => loadOneLga(lga).catch(err => {
          console.warn('LGA load failed for', lga.key, err);
        })));
        if (!lgaData.size) {
          console.warn('No LGAs loaded — map will run without boundaries');
          return;
        }
        // Combined bounds for default view + pan lock
        combinedLgaBounds = null;
        lgaData.forEach(entry => {
          combinedLgaBounds = combinedLgaBounds ? combinedLgaBounds.extend(entry.bounds) : L.latLngBounds(entry.bounds.getSouthWest(), entry.bounds.getNorthEast());
        });
        // Apply tighter pan lock — combined bounds with a small buffer
        const padded = combinedLgaBounds.pad(0.05);
        map.setMaxBounds(padded);
        // Fit view to all three (default "all" state)
        map.fitBounds(combinedLgaBounds, { padding: [20, 20], animate: false });
        applyLgaFocus(null, { skipFly: true }); // null = overview, no LGA dimmed
        updateTagline();
      } catch (err) {
        console.warn('LGA boundary load failed:', err);
      }
    }
    loadAllLgas();

    // Hybrid switcher: flies viewport to one LGA, dims the others. null = overview (all equal).
    function applyLgaFocus(key, opts = {}) {
      activeLgaKey = key;
      lgaData.forEach((entry, k) => {
        const isActive = key === null ? false : (k === key);
        entry.leafletLayer.setStyle(lgaStyle(isActive));
      });
      // Sync button states
      document.querySelectorAll('.lga-btn').forEach(btn => {
        btn.classList.toggle('active', btn.dataset.lga === key);
      });
      if (opts.skipFly) return;
      // Fly to the target LGA, or back to overview
      if (key && lgaData.has(key)) {
        map.flyToBounds(lgaData.get(key).bounds, { padding: [30, 30], duration: 0.8, maxZoom: 14 });
      } else if (combinedLgaBounds) {
        map.flyToBounds(combinedLgaBounds, { padding: [20, 20], duration: 0.8 });
      }
    }

    // Point-in-polygon (ray casting) for ring of [lng, lat] coords
    function pointInRing(lng, lat, ring) {
      let inside = false;
      for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
        const xi = ring[i][0], yi = ring[i][1];
        const xj = ring[j][0], yj = ring[j][1];
        const intersect = ((yi > lat) !== (yj > lat)) &&
                          (lng < (xj - xi) * (lat - yi) / ((yj - yi) || 1e-12) + xi);
        if (intersect) inside = !inside;
      }
      return inside;
    }
    function pointInFeature(lng, lat, feature) {
      const g = feature && feature.geometry;
      if (!g) return false;
      if (g.type === 'Polygon') {
        if (!g.coordinates.length) return false;
        if (!pointInRing(lng, lat, g.coordinates[0])) return false;
        // holes
        for (let i = 1; i < g.coordinates.length; i++) {
          if (pointInRing(lng, lat, g.coordinates[i])) return false;
        }
        return true;
      } else if (g.type === 'MultiPolygon') {
        return (g.coordinates || []).some(poly => {
          if (!poly.length) return false;
          if (!pointInRing(lng, lat, poly[0])) return false;
          for (let i = 1; i < poly.length; i++) {
            if (pointInRing(lng, lat, poly[i])) return false;
          }
          return true;
        });
      }
      return false;
    }
    function lgaAt(latlng) {
      for (const [key, entry] of lgaData) {
        if (pointInFeature(latlng.lng, latlng.lat, entry.feature)) {
          return entry.config;
        }
      }
      return null;
    }

    // Update header tagline based on map view
    function updateTagline() {
      if (!lgaData.size) return;
      const center = map.getCenter();
      const bounds = map.getBounds();
      // Check which LGAs are visible (intersection with viewport)
      const visibleLgas = [];
      lgaData.forEach((entry, key) => {
        if (bounds.intersects(entry.bounds)) visibleLgas.push(entry.config);
      });
      const centerLga = lgaAt(center);
      let text;
      let key;
      if (visibleLgas.length === LGAS.length) {
        text = LGAS.map(l => l.name).join(' · ');
        key = 'all';
      } else if (centerLga) {
        text = centerLga.name;
        key = centerLga.key;
      } else if (visibleLgas.length) {
        text = visibleLgas.map(l => l.name).join(' · ');
        key = 'vis:' + visibleLgas.map(l => l.key).join(',');
      } else {
        text = 'Western Melbourne';
        key = 'fallback';
      }
      if (key === lastTaglineKey) return;
      lastTaglineKey = key;
      document.getElementById('header-scope').textContent = text;
    }

    // Throttle tagline updates to one per 400ms
    let taglineThrottleTimer = null;
    function scheduleTaglineUpdate() {
      if (taglineThrottleTimer) return;
      taglineThrottleTimer = setTimeout(() => {
        taglineThrottleTimer = null;
        updateTagline();
      }, 400);
    }
    map.on('moveend', scheduleTaglineUpdate);

    // Wire up LGA switcher buttons
    document.querySelectorAll('.lga-btn').forEach(btn => {
      btn.addEventListener('click', () => {
        const key = btn.dataset.lga;
        // Tapping the active LGA returns to overview
        if (activeLgaKey === key) {
          applyLgaFocus(null);
          showToast('Showing all 3 councils');
        } else {
          const entry = lgaData.get(key);
          if (!entry) {
            showToast('LGA not loaded yet');
            return;
          }
          applyLgaFocus(key);
          showToast(entry.config.name);
        }
      });
    });

    // ====================================================================
    // SUBURB VECTOR POLYGONS — derived from Vicmap WFS, no hardcoded list
    // ====================================================================
    async function loadSuburbVectors() {
      // Query a broad bbox that covers all three LGAs; filter to those intersecting the LGAs.
      const params = new URLSearchParams({
        service: 'WFS', version: '1.0.0', request: 'GetFeature',
        typeName: LAYER_LOCALITY, outputFormat: 'application/json',
        bbox: '144.700,-37.910,145.030,-37.620,EPSG:4326'
      });
      try {
        const res = await fetch(`${WFS_BASE}?${params}`);
        if (!res.ok) throw new Error('HTTP ' + res.status);
        const data = await res.json();
        if (!data.features || !data.features.length) throw new Error('Empty');

        // If LGA data is loaded, filter localities to those intersecting any LGA.
        // If LGAs haven't loaded yet, show everything in the bbox (graceful fallback).
        const filtered = lgaData.size ? data.features.filter(f => featureIntersectsAnyLga(f)) : data.features;

        officialSuburbLayer = L.geoJSON({ type: 'FeatureCollection', features: filtered }, {
          pane: 'outlinePane',
          style: { color: '#fbbf24', weight: 1.4, opacity: 0.58, fill: false },
          onEachFeature: (feature, layer) => {
            const name = suburbNameFrom(feature.properties);
            if (name) {
              layer.bindTooltip(name, { sticky: true, direction: 'top', className: 'suburb-label' });
              layer.on('click', () => toggleSuburbHighlight(feature, layer, name));
              // Build dynamic suburb list with computed centroid
              const center = layer.getBounds().getCenter();
              dynamicSuburbs.push({ name, center: [center.lat, center.lng], layer });
            }
          }
        });
        // Sort A-Z and de-duplicate by uppercase name
        const seen = new Set();
        dynamicSuburbs = dynamicSuburbs
          .filter(s => {
            const k = s.name.toUpperCase();
            if (seen.has(k)) return false;
            seen.add(k);
            return true;
          })
          .sort((a, b) => a.name.localeCompare(b.name));
        renderSuburbList();
        if (state.suburbs) officialSuburbLayer.addTo(map);
      } catch (err) {
        console.warn('Suburb vector load failed; WMS outlines remain visible.', err);
      }
    }

    // Sample a feature's polygon vertices and test if any fall inside any loaded LGA.
    // Cheap intersection approximation — fine for filtering ~100 locality polygons.
    function featureIntersectsAnyLga(feature) {
      const g = feature.geometry;
      if (!g) return false;
      const sample = (coords) => {
        // coords is an array of rings for Polygon, or array of polygons for MultiPolygon
        const rings = g.type === 'Polygon' ? [coords[0]] : coords.map(p => p[0]);
        for (const ring of rings) {
          for (let i = 0; i < ring.length; i += Math.max(1, Math.floor(ring.length / 12))) {
            const [lng, lat] = ring[i];
            for (const [, entry] of lgaData) {
              if (pointInFeature(lng, lat, entry.feature)) return true;
            }
          }
        }
        return false;
      };
      try {
        return sample(g.coordinates);
      } catch (e) {
        return false;
      }
    }

    // Defer suburb load until LGAs have loaded (so the filter works).
    // If LGAs fail, suburbs will fall back to showing the full bbox.
    setTimeout(loadSuburbVectors, 800);

    function suburbNameFrom(props) {
      if (!props) return null;
      return findProp(props, ['locality_name','LOCALITY_NAME','locality','LOCALITY','name','NAME','vic_loca_2','VIC_LOCA_2']);
    }

    function toggleSuburbHighlight(feature, sourceLayer, name) {
      const key = name.replace(' (part)', '').toUpperCase();
      if (selectedSuburbs.has(key)) {
        const existing = selectedSuburbs.get(key);
        if (existing.highlight) map.removeLayer(existing.highlight);
        if (existing.label) map.removeLayer(existing.label);
        selectedSuburbs.delete(key);
        markSuburbBtn(key, false);
        showToast('Deselected ' + name);
        return;
      }
      const highlight = L.geoJSON(feature, {
        pane: 'highlightPane',
        style: {
          color: '#fbbf24', weight: 4, opacity: 1,
          fill: true, fillColor: '#fbbf24', fillOpacity: 0.12,
          dashArray: '8, 5'
        },
        interactive: false
      }).addTo(map);
      const center = sourceLayer ? sourceLayer.getBounds().getCenter() : highlight.getBounds().getCenter();
      const label = L.marker(center, {
        pane: 'highlightPane',
        icon: L.divIcon({
          className: '',
          html: `<div class="suburb-label">${escapeHtml(name)}</div>`,
          iconSize: [140, 24], iconAnchor: [70, 12]
        }),
        interactive: false
      }).addTo(map);
      selectedSuburbs.set(key, { highlight, label, name });
      markSuburbBtn(key, true);
      map.flyToBounds(highlight.getBounds(), { padding: [30, 30], maxZoom: 15, duration: 0.8 });
      showToast('Selected ' + name);
    }

    function markSuburbBtn(key, active) {
      document.querySelectorAll('#suburb-list .suburb-btn').forEach(btn => {
        const btnKey = btn.dataset.suburb.replace(' (part)', '').toUpperCase();
        if (btnKey === key) btn.classList.toggle('active', active);
      });
    }

    function clearAllSuburbHighlights() {
      selectedSuburbs.forEach(item => {
        if (item.highlight) map.removeLayer(item.highlight);
        if (item.label) map.removeLayer(item.label);
      });
      selectedSuburbs.clear();
      document.querySelectorAll('#suburb-list .suburb-btn').forEach(btn => btn.classList.remove('active'));
    }

    function showTapTarget(latlng) {
      if (selectedTapMarker) map.removeLayer(selectedTapMarker);
      selectedTapMarker = L.marker(latlng, {
        pane: 'highlightPane',
        icon: L.divIcon({
          className: '',
          html: '<div class="tap-target-marker"></div>',
          iconSize: [34, 34],
          iconAnchor: [17, 17]
        }),
        interactive: false,
        keyboard: false
      }).addTo(map);
    }

    function clearTapTarget() {
      if (selectedTapMarker) {
        map.removeLayer(selectedTapMarker);
        selectedTapMarker = null;
      }
    }

    // ====================================================================
    // LAYER CONTROLS + PRESETS
    // ====================================================================
    const presets = {
      planning: { zones: true,  overlays: true,  suburbs: true, parcels: true,  roads: false, water: false, rail: false, aerial: false },
      property: { zones: false, overlays: false, suburbs: true, parcels: true,  roads: false, water: false, rail: false, aerial: false },
      context:  { zones: false, overlays: false, suburbs: true, parcels: false, roads: true,  water: true,  rail: true,  aerial: false }
    };
    let activePreset = 'planning';

    document.querySelectorAll('[data-layer-toggle]').forEach(input => {
      input.addEventListener('change', () => {
        setLayer(input.dataset.layerToggle, input.checked, { manual: true });
      });
    });
    document.querySelectorAll('[data-preset]').forEach(btn => {
      btn.addEventListener('click', () => applyPreset(btn.dataset.preset));
    });

    document.getElementById('layers-btn').addEventListener('click', showLayersSheet);
    document.getElementById('layers-close').addEventListener('click', hideLayersSheet);
    document.getElementById('layers-backdrop').addEventListener('click', hideLayersSheet);
    document.getElementById('gps-btn').addEventListener('click', () => setLayer('gps', !state.gps, { manual: true }));

    syncLayerControls();
    updateStatus();

    // Apply initial layer state to the map — WMS layers default to "not on map" so we
    // need to add the ones the default preset has enabled. Force flag bypasses the
    // "state already matches" early-return in setLayer.
    ['zones', 'overlays', 'parcels', 'suburbs'].forEach(name => {
      if (state[name]) setLayer(name, true, { silent: true, force: true });
    });

    function applyPreset(name) {
      const preset = presets[name];
      if (!preset) return;
      activePreset = name;
      Object.keys(preset).forEach(layerName => setLayer(layerName, preset[layerName], { silent: true }));
      syncLayerControls();
      updateStatus();
      showToast(name.charAt(0).toUpperCase() + name.slice(1) + ' mode');
    }

    function setLayer(name, value, opts = {}) {
      const next = Boolean(value);
      if (state[name] === next && !opts.force) {
        syncLayerControls();
        return;
      }
      state[name] = next;

      if (name === 'zones') {
        state.zones ? zoneLayer.addTo(map) : map.removeLayer(zoneLayer);
      } else if (name === 'overlays') {
        state.overlays ? overlayLayer.addTo(map) : map.removeLayer(overlayLayer);
      } else if (name === 'suburbs') {
        if (state.suburbs) {
          suburbOutlineLayer.addTo(map);
          if (officialSuburbLayer) officialSuburbLayer.addTo(map);
        } else {
          map.removeLayer(suburbOutlineLayer);
          if (officialSuburbLayer && map.hasLayer(officialSuburbLayer)) map.removeLayer(officialSuburbLayer);
          clearAllSuburbHighlights();
        }
      } else if (name === 'parcels') {
        if (state.parcels) {
          parcelLayer.addTo(map);
          if (!opts.silent) showToast('Tap a parcel to identify');
        } else {
          map.removeLayer(parcelLayer);
          if (selectedParcelLayer) { map.removeLayer(selectedParcelLayer); selectedParcelLayer = null; }
        }
      } else if (name === 'roads') {
        state.roads ? roadLayer.addTo(map) : map.removeLayer(roadLayer);
      } else if (name === 'water') {
        state.water ? waterLayer.addTo(map) : map.removeLayer(waterLayer);
      } else if (name === 'rail') {
        state.rail ? railLayer.addTo(map) : map.removeLayer(railLayer);
      } else if (name === 'aerial') {
        if (state.aerial) {
          map.removeLayer(osmLayer);
          aerialLayer.addTo(map);
        } else {
          map.removeLayer(aerialLayer);
          osmLayer.addTo(map);
        }
      } else if (name === 'gps') {
        state.gps ? startGPS() : stopGPS();
      }

      if (opts.manual) activePreset = null;
      syncLayerControls();
      updateStatus();
    }

    function syncLayerControls() {
      document.querySelectorAll('[data-layer-toggle]').forEach(input => {
        const name = input.dataset.layerToggle;
        input.checked = Boolean(state[name]);
      });
      document.getElementById('gps-btn').classList.toggle('active', state.gps);
      document.querySelectorAll('[data-preset]').forEach(btn => {
        btn.classList.toggle('active', btn.dataset.preset === activePreset);
      });
    }

    function showLayersSheet() {
      document.getElementById('layers-sheet').classList.add('show');
      document.getElementById('layers-backdrop').classList.add('show');
    }
    function hideLayersSheet() {
      document.getElementById('layers-sheet').classList.remove('show');
      document.getElementById('layers-backdrop').classList.remove('show');
    }

    function updateStatus() {
      const active = Object.keys(state).filter(k => state[k]);
      document.getElementById('status-label').textContent =
        active.length === 0 ? 'READY' : active.length + ' ACTIVE';
    }

    function installDoubleTapDragZoom(mapInstance) {
      const container = mapInstance.getContainer();
      let lastTapTime = 0;
      let lastTapPoint = null;
      let dragZoom = null;
      let ignoreNextClickUntil = 0;
      const DOUBLE_TAP_MS = 420;
      const DOUBLE_TAP_PX = 42;
      const DRAG_START_PX = 8;
      const ZOOM_PX_PER_LEVEL = 140;

      function pointFromTouch(touch) {
        return L.point(touch.clientX, touch.clientY);
      }

      function pointDistance(a, b) {
        if (!a || !b) return Infinity;
        const dx = a.x - b.x;
        const dy = a.y - b.y;
        return Math.sqrt(dx * dx + dy * dy);
      }

      function clampZoom(z) {
        return Math.max(mapInstance.getMinZoom(), Math.min(mapInstance.getMaxZoom(), z));
      }

      function stopTouch(ev) {
        ev.preventDefault();
        if (ev.stopPropagation) ev.stopPropagation();
        if (ev.stopImmediatePropagation) ev.stopImmediatePropagation();
      }

      function finishDragZoom(ev) {
        if (!dragZoom) return;
        const dz = dragZoom.currentZoom - dragZoom.startZoom;
        const wasDragging = Math.abs(dz) > 0.03 || dragZoom.moved;
        const anchor = dragZoom.anchorLatLng;
        const startZoom = dragZoom.startZoom;
        dragZoom = null;
        if (mapInstance.dragging) mapInstance.dragging.enable();

        // If the second tap was not dragged, treat it as a gentle double-tap zoom.
        if (!wasDragging) {
          mapInstance.setZoomAround(anchor, clampZoom(startZoom + 0.5), { animate: true });
        }
        ignoreNextClickUntil = Date.now() + 450;
        if (ev) stopTouch(ev);
      }

      // Capture-phase listeners are used so Leaflet's normal touch drag/double-tap
      // handlers do not consume the gesture before this custom one sees it.
      container.addEventListener('touchstart', (ev) => {
        if (ev.touches.length !== 1) {
          finishDragZoom(ev);
          return;
        }

        const touch = ev.touches[0];
        const now = Date.now();
        const point = pointFromTouch(touch);
        const isDoubleTap = now - lastTapTime < DOUBLE_TAP_MS && pointDistance(point, lastTapPoint) < DOUBLE_TAP_PX;

        if (!isDoubleTap) {
          lastTapTime = now;
          lastTapPoint = point;
          return;
        }

        const containerPoint = mapInstance.mouseEventToContainerPoint(touch);
        const anchorLatLng = mapInstance.containerPointToLatLng(containerPoint);
        dragZoom = {
          startPoint: point,
          startY: touch.clientY,
          startZoom: mapInstance.getZoom(),
          currentZoom: mapInstance.getZoom(),
          anchorLatLng,
          moved: false
        };
        lastTapTime = 0;
        lastTapPoint = null;
        if (mapInstance.dragging) mapInstance.dragging.disable();
        showToast('Drag down to zoom in · up to zoom out', 1200);
        stopTouch(ev);
      }, { passive: false, capture: true });

      container.addEventListener('touchmove', (ev) => {
        if (!dragZoom || ev.touches.length !== 1) return;
        const touch = ev.touches[0];
        const point = pointFromTouch(touch);
        const yDrag = touch.clientY - dragZoom.startY; // positive = dragging down

        if (Math.abs(yDrag) >= DRAG_START_PX || pointDistance(point, dragZoom.startPoint) >= DRAG_START_PX) {
          dragZoom.moved = true;
        }

        if (dragZoom.moved) {
          const targetZoom = clampZoom(dragZoom.startZoom + (yDrag / ZOOM_PX_PER_LEVEL));
          dragZoom.currentZoom = targetZoom;
          mapInstance.setZoomAround(dragZoom.anchorLatLng, targetZoom, { animate: false });
        }
        stopTouch(ev);
      }, { passive: false, capture: true });

      container.addEventListener('touchend', (ev) => finishDragZoom(ev), { passive: false, capture: true });
      container.addEventListener('touchcancel', (ev) => finishDragZoom(ev), { passive: false, capture: true });

      // Prevent the synthetic click that mobile browsers may emit after this gesture
      // from triggering map identify immediately after zooming.
      container.addEventListener('click', (ev) => {
        if (Date.now() < ignoreNextClickUntil) stopTouch(ev);
      }, { passive: false, capture: true });
    }

    // ====================================================================
    // SEARCH (Nominatim, biased to the three LGAs)
    // ====================================================================
    const searchInput = document.getElementById('address-search');
    const searchButton = document.getElementById('address-search-btn');
    const searchResults = document.getElementById('search-results');

    function cleanLabel(s) {
      if (!s) return 'Search result';
      return s
        .replace(/, City of (Brimbank|Moonee Valley|Maribyrnong), Victoria, Australia/, '')
        .replace(/, (Brimbank|Moonee Valley|Maribyrnong) City, Victoria, Australia/, '')
        .replace(', Victoria, Australia', '')
        .replace(', Australia', '');
    }

    async function searchAddress() {
      const raw = searchInput.value.trim();
      if (!raw) { showToast('Enter an address or suburb'); return; }
      searchButton.textContent = '...';
      searchResults.classList.remove('show');
      searchResults.innerHTML = '';
      const qLower = raw.toLowerCase();
      const attempts = [raw];
      if (!qLower.includes('vic') && !qLower.includes('victoria') && !qLower.includes('australia')) {
        attempts.push(`${raw}, VIC, Australia`);
      }
      try {
        let results = [];
        for (const q of attempts) {
          const p = new URLSearchParams({
            format: 'jsonv2', q, limit: '5', countrycodes: 'au',
            addressdetails: '1',
            // Broad viewbox covering all three LGAs
            viewbox: '144.700,-37.620,145.030,-37.910',
            bounded: '0'
          });
          const r = await fetch(`https://nominatim.openstreetmap.org/search?${p}`, { headers: { 'Accept': 'application/json' } });
          if (!r.ok) continue;
          results = await r.json();
          if (results && results.length) break;
        }
        if (!results || !results.length) {
          showToast('No address found — try suburb + postcode');
          return;
        }
        renderSearchResults(results);
      } catch (e) {
        showToast('Search unavailable');
      } finally {
        searchButton.textContent = 'Go';
      }
    }

    function renderSearchResults(results) {
      searchResults.innerHTML = results.map((r, i) => `
        <button class="search-result" data-i="${i}">
          <div class="search-result-main">${escapeHtml(cleanLabel(r.display_name))}</div>
          <div class="search-result-sub">${escapeHtml([r.type, r.class].filter(Boolean).join(' · ') || 'Location')}</div>
        </button>
      `).join('');
      searchResults.querySelectorAll('.search-result').forEach(btn => {
        btn.addEventListener('click', () => goToSearchResult(results[Number(btn.dataset.i)]));
      });
      searchResults.classList.add('show');
      if (results.length === 1) goToSearchResult(results[0]);
    }

    function goToSearchResult(r) {
      const lat = Number(r.lat), lon = Number(r.lon);
      if (!Number.isFinite(lat) || !Number.isFinite(lon)) { showToast('Invalid result'); return; }
      const ll = [lat, lon];
      if (searchMarker) map.removeLayer(searchMarker);
      searchMarker = L.marker(ll, {
        icon: L.divIcon({
          className: '',
          html: '<div class="search-marker"></div>',
          iconSize: [18, 18], iconAnchor: [9, 18]
        })
      }).addTo(map);
      const bbox = r.boundingbox;
      if (bbox && bbox.length === 4) {
        const b = L.latLngBounds([Number(bbox[0]), Number(bbox[2])], [Number(bbox[1]), Number(bbox[3])]);
        map.flyToBounds(b, { padding: [36, 36], maxZoom: 17, duration: 0.8 });
      } else {
        map.flyTo(ll, 17, { duration: 0.8 });
      }
      searchResults.classList.remove('show');
      searchInput.value = cleanLabel(r.display_name);
      showToast('Location found');
    }

    searchButton.addEventListener('click', searchAddress);
    searchInput.addEventListener('keydown', e => {
      if (e.key === 'Enter') searchAddress();
      if (e.key === 'Escape') searchResults.classList.remove('show');
    });
    map.on('click', () => searchResults.classList.remove('show'));

    // ====================================================================
    // SUBURB BROWSER PANEL
    // ====================================================================
    const suburbToggle = document.getElementById('suburb-toggle');
    const suburbPanel = document.getElementById('suburb-panel');
    const suburbList = document.getElementById('suburb-list');

    // renderSuburbList is called after loadSuburbVectors populates dynamicSuburbs
    function renderSuburbList() {
      if (!dynamicSuburbs.length) {
        suburbList.innerHTML = '<div style="padding:12px;color:var(--text-mute);font-family:DM Mono,monospace;font-size:10px;letter-spacing:0.08em;text-transform:uppercase;">Loading localities…</div>';
        return;
      }
      suburbList.innerHTML = dynamicSuburbs.map(s =>
        `<button class="suburb-btn" data-suburb="${escapeHtml(s.name)}">${escapeHtml(s.name)}</button>`
      ).join('');
      suburbList.querySelectorAll('.suburb-btn').forEach(btn => {
        btn.addEventListener('click', () => suburbBtnClick(btn.dataset.suburb));
      });
    }
    renderSuburbList(); // initial "loading" state

    suburbToggle.addEventListener('click', () => {
      suburbPanel.classList.toggle('show');
      suburbToggle.classList.toggle('active', suburbPanel.classList.contains('show'));
    });

    document.getElementById('clear-suburbs').addEventListener('click', () => {
      clearAllSuburbHighlights();
      showToast('Suburb selections cleared');
    });

    function suburbBtnClick(name) {
      if (!state.suburbs) setLayer('suburbs', true, { manual: true });
      const cleanName = name.replace(' (part)', '').toUpperCase();
      if (officialSuburbLayer) {
        let match = null;
        officialSuburbLayer.eachLayer(layer => {
          const props = layer.feature?.properties || {};
          const featureName = (suburbNameFrom(props) || '').toString().toUpperCase().replace(' (PART)', '');
          if (featureName === cleanName) match = layer;
        });
        if (match) {
          toggleSuburbHighlight(match.feature, match, name);
          return;
        }
      }
      // Fallback: pan to computed centroid if vector match fails
      const s = dynamicSuburbs.find(x => x.name === name);
      if (s) {
        map.flyTo(s.center, 15, { duration: 0.8 });
        showToast('Panned to ' + name);
      }
    }

    // ====================================================================
    // UTILITY BUTTONS
    // ====================================================================
    document.getElementById('reset-view-btn').addEventListener('click', () => {
      if (combinedLgaBounds) {
        applyLgaFocus(null);
        map.flyToBounds(combinedLgaBounds, { padding: [20, 20], duration: 0.8 });
      } else {
        map.flyTo(INITIAL_CENTER, INITIAL_ZOOM, { duration: 0.8 });
      }
      hideSheet();
      showToast('Map reset');
    });

    document.getElementById('clear-all-btn').addEventListener('click', () => {
      if (searchMarker) { map.removeLayer(searchMarker); searchMarker = null; }
      clearTapTarget();
      if (selectedParcelLayer) { map.removeLayer(selectedParcelLayer); selectedParcelLayer = null; }
      clearAllSuburbHighlights();
      searchResults.classList.remove('show');
      searchResults.innerHTML = '';
      searchInput.value = '';
      hideSheet();
      showToast('Selections cleared');
    });

    // ====================================================================
    // TAP TO IDENTIFY
    // ====================================================================
    map.on('click', async (e) => {
      if (!state.zones && !state.overlays && !state.parcels) {
        showToast('Enable Zones, Overlays, or Parcels first');
        return;
      }
      showTapTarget(e.latlng);
      showToast('Selection marked');
      showSheet(e.latlng);
      document.getElementById('sheet-body').innerHTML = '<div class="sheet-empty">Querying Vicmap and address…</div>';
      const tasks = [
        state.zones    ? queryWMS(LAYER_ZONE, e.latlng)    : Promise.resolve(null),
        state.overlays ? queryWMS(LAYER_OVERLAY, e.latlng) : Promise.resolve(null),
        state.parcels  ? queryWMS(LAYER_PARCELS, e.latlng) : Promise.resolve(null),
        reverseGeocode(e.latlng)
      ];
      const [zoneRes, overlayRes, parcelRes, addressRes] = await Promise.all(tasks);
      renderIdentifyResults(zoneRes, overlayRes, parcelRes, e.latlng, addressRes);
    });

    async function queryWMS(layerName, latlng) {
      const point = map.latLngToContainerPoint(latlng);
      const size = map.getSize();
      const bounds = map.getBounds();
      const bbox = [bounds.getWest(), bounds.getSouth(), bounds.getEast(), bounds.getNorth()].join(',');
      const params = new URLSearchParams({
        service: 'WMS', version: '1.1.1', request: 'GetFeatureInfo',
        layers: layerName, query_layers: layerName,
        info_format: 'application/json', feature_count: '3',
        x: Math.round(point.x), y: Math.round(point.y),
        srs: 'EPSG:4326',
        width: Math.round(size.x), height: Math.round(size.y),
        bbox
      });
      try {
        const res = await fetch(`${WMS_BASE}?${params}`);
        if (!res.ok) return { error: 'HTTP ' + res.status };
        const data = await res.json();
        return { features: data.features || [] };
      } catch (err) {
        return { error: err.message || 'Network error' };
      }
    }

    async function reverseGeocode(latlng) {
      const params = new URLSearchParams({
        format: 'jsonv2',
        lat: latlng.lat.toFixed(7),
        lon: latlng.lng.toFixed(7),
        zoom: '18',
        addressdetails: '1'
      });
      try {
        const res = await fetch(`https://nominatim.openstreetmap.org/reverse?${params}`, {
          headers: { 'Accept': 'application/json' }
        });
        if (!res.ok) return { error: 'HTTP ' + res.status };
        const data = await res.json();
        const address = data.display_name ? cleanLabel(data.display_name) : '';
        const parts = data.address || {};
        const locality = parts.suburb || parts.city_district || parts.town || parts.city || parts.village || '';
        return { address, locality, raw: data };
      } catch (err) {
        return { error: err.message || 'Address lookup failed' };
      }
    }

    function findProp(props, candidates) {
      if (!props) return null;
      for (const c of candidates) {
        for (const k of Object.keys(props)) {
          if (k.toLowerCase() === c.toLowerCase()) return props[k];
        }
      }
      return null;
    }

    function uniqueByZone(features) {
      const seen = new Set();
      return (features || []).filter(f => {
        const p = f.properties || {};
        const code = findProp(p, ['ZONE_CODE','zone_code','ZONE','zone','CODE','code']) || '';
        const key = normaliseCode(code);
        if (seen.has(key)) return false;
        seen.add(key);
        return true;
      }).slice(0, 3);
    }

    function uniqueByOverlay(features) {
      const seen = new Set();
      return (features || []).map(f => {
        const p = f.properties || {};
        return {
          code: findProp(p, ['ZONE_CODE','zone_code','OVERLAY_CODE','overlay_code','CODE','code']) || '',
          desc: findProp(p, ['ZONE_DESC','zone_desc','OVERLAY_DESC','overlay_desc','DESCRIPTION','description']) || ''
        };
      }).filter(t => {
        if (!t.code) return false;
        const key = normaliseCode(t.code);
        if (seen.has(key)) return false;
        seen.add(key);
        return true;
      }).slice(0, 6);
    }

    function highlightParcel(feature) {
      if (!feature || !feature.geometry) return;
      if (selectedParcelLayer) map.removeLayer(selectedParcelLayer);
      try {
        selectedParcelLayer = L.geoJSON(feature, {
          pane: 'highlightPane',
          style: {
            color: '#60a5fa', weight: 4, opacity: 1,
            fill: true, fillColor: '#60a5fa', fillOpacity: 0.12,
            dashArray: '5, 4'
          },
          interactive: false
        }).addTo(map);
      } catch (err) {
        console.warn('Parcel highlight failed', err);
      }
    }

    function parcelAreaSqm(feature) {
      if (!feature || !feature.geometry) return null;
      try {
        const geom = feature.geometry;
        let area = 0;
        if (geom.type === 'Polygon') {
          area = polygonAreaSqm(geom.coordinates);
        } else if (geom.type === 'MultiPolygon') {
          area = geom.coordinates.reduce((sum, poly) => sum + polygonAreaSqm(poly), 0);
        } else {
          return null;
        }
        return Number.isFinite(area) && area > 0 ? area : null;
      } catch (err) {
        console.warn('Parcel area calculation failed', err);
        return null;
      }
    }

    function polygonAreaSqm(rings) {
      if (!Array.isArray(rings) || !rings.length) return 0;
      let area = Math.abs(ringAreaSqm(rings[0]));
      for (let i = 1; i < rings.length; i++) area -= Math.abs(ringAreaSqm(rings[i]));
      return Math.max(0, area);
    }

    function ringAreaSqm(coords) {
      // Approximate geodesic area on WGS84 using the Chamberlain-Duquette spherical method.
      // Good enough for parcel-scale display, but still verify with official title/survey sources.
      if (!Array.isArray(coords) || coords.length < 3) return 0;
      const radius = 6378137; // metres
      const toRad = Math.PI / 180;
      let sum = 0;
      for (let i = 0; i < coords.length; i++) {
        const [lon1, lat1] = coords[i];
        const [lon2, lat2] = coords[(i + 1) % coords.length];
        sum += ((lon2 - lon1) * toRad) * (2 + Math.sin(lat1 * toRad) + Math.sin(lat2 * toRad));
      }
      return Math.abs(sum * radius * radius / 2);
    }

    function formatArea(sqm) {
      if (!Number.isFinite(sqm) || sqm <= 0) return '';
      const roundedSqm = sqm >= 1000 ? Math.round(sqm).toLocaleString('en-AU') : Math.round(sqm).toLocaleString('en-AU');
      const hectares = sqm / 10000;
      const hectareText = hectares >= 1 ? hectares.toFixed(2) : hectares.toFixed(3);
      return `${roundedSqm} m² · ${hectareText} ha`;
    }

    // Render
    function renderIdentifyResults(zoneRes, overlayRes, parcelRes, latlng, addressRes) {
      const body = document.getElementById('sheet-body');
      let html = '';

      // Summary card at top
      html += renderSummary(zoneRes, overlayRes, parcelRes, latlng, addressRes);

      // Zones detail
      if (state.zones) {
        html += `<div class="sheet-section"><div class="sheet-label">Planning Zone</div>`;
        if (!zoneRes) {
          html += emptyMsg();
        } else if (zoneRes.error) {
          html += errorMsg(zoneRes.error);
        } else if (!zoneRes.features.length) {
          html += '<div class="sheet-empty">No zone data at this point</div>';
        } else {
          const feats = uniqueByZone(zoneRes.features);
          feats.forEach(f => {
            const p = f.properties || {};
            const code = findProp(p, ['ZONE_CODE','zone_code','ZONE','zone','CODE','code']) || '—';
            const desc = findProp(p, ['ZONE_DESC','zone_desc','DESCRIPTION','description','ZONE_NUM_DESC','zone_num_desc']) || '';
            const lga  = findProp(p, ['LGA','lga','LGA_NAME','lga_name','SCHEME_NAME','scheme_name']) || '';
            html += `<div><span class="sheet-tag zone">${escapeHtml(code)}</span></div>`;
            if (desc) html += `<div class="sheet-desc">${escapeHtml(desc)}</div>`;
            html += `<div class="zone-explainer"><strong>What this means:</strong> ${escapeHtml(getZoneDescription(code))}</div>`;
            html += `<div class="zone-warning">Summary only — check VicPlan before relying on it</div>`;
            if (lga) html += `<div class="sheet-desc" style="font-size:11px;color:var(--text-mute)">${escapeHtml(lga)}</div>`;
          });
        }
        html += '</div>';
      }

      // Overlays detail
      if (state.overlays) {
        html += `<div class="sheet-section"><div class="sheet-label">Overlays</div>`;
        if (!overlayRes) {
          html += emptyMsg();
        } else if (overlayRes.error) {
          html += errorMsg(overlayRes.error);
        } else if (!overlayRes.features.length) {
          html += '<div class="sheet-empty">No overlays at this point</div>';
        } else {
          const tags = uniqueByOverlay(overlayRes.features);
          html += '<div>' + tags.map(t =>
            `<span class="sheet-tag overlay" title="${escapeHtml(t.desc)}">${escapeHtml(t.code)}</span>`
          ).join('') + '</div>';
          html += '<div class="sheet-desc">';
          tags.forEach(t => {
            html += `<div style="margin-bottom:10px"><b style="color:var(--text)">${escapeHtml(t.code)}</b>`;
            if (t.desc) html += ` — ${escapeHtml(t.desc)}`;
            html += `<div class="zone-explainer"><strong>What this means:</strong> ${escapeHtml(getOverlayDescription(t.code))}</div>`;
            html += `<div class="zone-warning">Summary only — check VicPlan before relying on it</div>`;
            html += '</div>';
          });
          html += '</div>';
        }
        html += '</div>';
      }

      // Parcels detail
      if (state.parcels) {
        html += `<div class="sheet-section"><div class="sheet-label">Property Parcel</div>`;
        if (!parcelRes) {
          html += emptyMsg();
        } else if (parcelRes.error) {
          html += errorMsg(parcelRes.error);
        } else if (!parcelRes.features.length) {
          html += '<div class="sheet-empty">No parcel returned at this point</div>';
        } else {
          const f = parcelRes.features[0];
          const p = f.properties || {};
          const spi  = findProp(p, ['SPI','spi','PROP_PFI','prop_pfi','PFI','pfi','PARCEL_PFI','parcel_pfi']) || '—';
          const desc = findProp(p, ['PARCEL_DESCRIPTION','parcel_description','DESC','desc','LOT_NUMBER','lot_number','LOTNO','lotno']) || '';
          const addr = findProp(p, ['ADDRESS','address','FULL_ADDRESS','full_address','PROPERTY_ADDRESS','property_address']) || '';
          const areaText = formatArea(parcelAreaSqm(f));
          html += `<div><span class="sheet-tag zone">Parcel</span></div>`;
          html += `<div class="sheet-desc"><b style="color:var(--text)">Identifier:</b> ${escapeHtml(spi)}</div>`;
          if (areaText) html += `<div class="sheet-desc"><b style="color:var(--text)">Approx. parcel area:</b> ${escapeHtml(areaText)}</div>`;
          const nearestAddress = addr || (addressRes && addressRes.address) || '';
          if (desc) html += `<div class="sheet-desc">${escapeHtml(desc)}</div>`;
          if (nearestAddress) html += `<div class="sheet-desc"><b style="color:var(--text)">Nearest address:</b> ${escapeHtml(nearestAddress)}</div>`;
          if (addressRes && addressRes.error) html += `<div class="sheet-desc" style="font-size:11px;color:var(--text-mute)">Address lookup unavailable</div>`;
          html += '<div class="zone-warning">Parcel summary only — area is calculated from mapped geometry and should be verified through title/survey/property sources</div>';
          highlightParcel(f);
        }
        html += '</div>';
      }

      body.innerHTML = html;
    }

    function renderSummary(zoneRes, overlayRes, parcelRes, latlng, addressRes) {
      const zoneP = firstProps(zoneRes);
      const overlayFs = uniqueByOverlay(overlayRes && overlayRes.features);
      const parcelP = firstProps(parcelRes);

      const zoneCode = findProp(zoneP, ['ZONE_CODE','zone_code','ZONE','zone','CODE','code']) || '';
      const zoneDesc = findProp(zoneP, ['ZONE_DESC','zone_desc','DESCRIPTION','description']) || '';
      const parcelId = findProp(parcelP, ['SPI','spi','PROP_PFI','prop_pfi','PFI','pfi','PARCEL_PFI','parcel_pfi']) || '';
      const parcelAddr = findProp(parcelP, ['ADDRESS','address','FULL_ADDRESS','full_address','PROPERTY_ADDRESS','property_address']) || '';
      const parcelFeature = parcelRes && parcelRes.features && parcelRes.features.length ? parcelRes.features[0] : null;
      const parcelAreaText = formatArea(parcelAreaSqm(parcelFeature));
      const addressText = parcelAddr || (addressRes && addressRes.address) || '';
      // Dynamic LGA lookup — falls back to address locality, then "—"
      const tappedLga = lgaAt(latlng);
      const lgaDisplay = tappedLga ? tappedLga.name : '—';
      const localityText = (addressRes && addressRes.locality) || lgaDisplay;

      const lat = latlng.lat.toFixed(6);
      const lng = latlng.lng.toFixed(6);

      const title = addressText || (zoneCode ? 'Selected property area' : 'Selected location');
      const subLine = addressText ? `${lat}, ${lng} · ${localityText}` : `${lat}, ${lng} · ${lgaDisplay}`;
      const zoneText = zoneCode ? `${zoneCode}${zoneDesc ? ' · ' + zoneDesc : ''}` : (state.zones ? 'None returned' : 'Enable Zones');
      const overlayText = overlayFs.length ? overlayFs.map(o => o.code).join(', ') : (state.overlays ? 'None returned' : 'Enable Overlays');
      const parcelText = parcelId || (state.parcels ? 'Not returned' : 'Enable Parcels');
      const areaDisplay = parcelAreaText || (state.parcels ? 'Area unavailable' : 'Enable Parcels');
      const addressDisplay = addressText || (addressRes && addressRes.error ? 'Address lookup unavailable' : 'Looking up by selected point');

      return `
        <div class="property-summary">
          <div class="property-summary-title">${escapeHtml(title)}</div>
          <div class="property-summary-sub">${escapeHtml(subLine)}</div>
          <div class="summary-grid">
            <div class="summary-item wide">
              <div class="summary-label">Nearest Address</div>
              <div class="summary-value ${addressText ? '' : 'dim'}">${escapeHtml(addressDisplay)}</div>
            </div>
            <div class="summary-item">
              <div class="summary-label">Zone</div>
              <div class="summary-value ${zoneCode ? '' : 'dim'}">${escapeHtml(zoneText)}</div>
            </div>
            <div class="summary-item">
              <div class="summary-label">Overlays</div>
              <div class="summary-value ${overlayFs.length ? '' : 'dim'}">${escapeHtml(overlayText)}</div>
            </div>
            <div class="summary-item">
              <div class="summary-label">Parcel</div>
              <div class="summary-value ${parcelId ? '' : 'dim'}">${escapeHtml(parcelText)}</div>
            </div>
            <div class="summary-item">
              <div class="summary-label">Approx. Area</div>
              <div class="summary-value ${parcelAreaText ? '' : 'dim'}">${escapeHtml(areaDisplay)}</div>
            </div>
            <div class="summary-item">
              <div class="summary-label">LGA</div>
              <div class="summary-value ${tappedLga ? '' : 'dim'}">${escapeHtml(lgaDisplay)}</div>
            </div>
          </div>
          <div class="summary-links">
            <a class="summary-link primary" target="_blank" rel="noopener" href="https://mapshare.vic.gov.au/vicplan/?center=${lng},${lat}&z=18">VicPlan</a>
            <a class="summary-link" target="_blank" rel="noopener" href="https://www.google.com/maps?q=${lat},${lng}">Maps</a>
            <a class="summary-link" target="_blank" rel="noopener" href="https://www.google.com/maps?layer=c&cbll=${lat},${lng}">Street</a>
            <a class="summary-link" target="_blank" rel="noopener" href="https://www.openstreetmap.org/#map=19/${lat}/${lng}">OSM</a>
          </div>
        </div>
      `;
    }

    function firstProps(res) {
      return res && res.features && res.features.length ? (res.features[0].properties || {}) : {};
    }
    function emptyMsg() { return '<div class="sheet-empty">—</div>'; }
    function errorMsg(m) { return `<div class="sheet-empty" style="color:var(--text-dim)">Query failed · ${escapeHtml(m)}<br><span style="opacity:0.6">Try the VicPlan link below</span></div>`; }

    function escapeHtml(s) {
      if (s === null || s === undefined) return '';
      return String(s).replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
    }

    // ====================================================================
    // SHEET
    // ====================================================================
    function showSheet(latlng) {
      document.getElementById('sheet-coords').textContent = `${latlng.lat.toFixed(5)}, ${latlng.lng.toFixed(5)}`;
      const sheet = document.getElementById('sheet');
      sheet.classList.add('show', 'mini');
      sheet.classList.remove('expanded');
      document.getElementById('sheet-backdrop').classList.remove('show');
      document.getElementById('sheet-mode-hint').textContent = 'Tap to expand';
    }
    function expandSheet() {
      const sheet = document.getElementById('sheet');
      if (!sheet.classList.contains('show')) return;
      sheet.classList.remove('mini');
      sheet.classList.add('expanded');
      document.getElementById('sheet-backdrop').classList.add('show');
      document.getElementById('sheet-mode-hint').textContent = 'Tap to minimise';
    }
    function minimiseSheet() {
      const sheet = document.getElementById('sheet');
      if (!sheet.classList.contains('show')) return;
      sheet.classList.add('mini');
      sheet.classList.remove('expanded');
      document.getElementById('sheet-backdrop').classList.remove('show');
      document.getElementById('sheet-mode-hint').textContent = 'Tap to expand';
    }
    function toggleSheetSize() {
      const sheet = document.getElementById('sheet');
      if (!sheet.classList.contains('show')) return;
      sheet.classList.contains('expanded') ? minimiseSheet() : expandSheet();
    }
    function hideSheet() {
      const sheet = document.getElementById('sheet');
      sheet.classList.remove('show', 'mini', 'expanded');
      document.getElementById('sheet-backdrop').classList.remove('show');
    }
    document.getElementById('sheet-backdrop').addEventListener('click', minimiseSheet);
    document.getElementById('sheet-header').addEventListener('click', toggleSheetSize);

    // ====================================================================
    // TOAST
    // ====================================================================
    let toastTimer;
    function showToast(msg, ms = 2200) {
      const t = document.getElementById('toast');
      t.textContent = msg;
      t.classList.add('show');
      clearTimeout(toastTimer);
      toastTimer = setTimeout(() => t.classList.remove('show'), ms);
    }

    // ====================================================================
    // GPS
    // ====================================================================
    function startGPS() {
      if (!navigator.geolocation) {
        showToast('Geolocation not supported');
        state.gps = false;
        document.getElementById('gps-btn').classList.remove('active');
        return;
      }
      const chip = document.getElementById('gps-btn');
      chip.classList.add('loading');
      showToast('Getting location…');
      gpsWatchId = navigator.geolocation.watchPosition(
        pos => {
          chip.classList.remove('loading');
          const ll = [pos.coords.latitude, pos.coords.longitude];
          const inBounds = combinedLgaBounds ? combinedLgaBounds.contains(ll) : true;
          if (!inBounds) showToast('You are outside the three-LGA area');
          if (gpsMarker) {
            gpsMarker.setLatLng(ll);
          } else {
            gpsMarker = L.marker(ll, {
              icon: L.divIcon({
                className: '',
                html: '<div class="gps-pulse"></div>',
                iconSize: [14, 14], iconAnchor: [7, 7]
              })
            }).addTo(map);
            if (inBounds) map.setView(ll, 17);
          }
        },
        err => {
          chip.classList.remove('loading');
          showToast('Location: ' + (err.code === 1 ? 'permission denied' : 'unavailable'));
          state.gps = false;
          chip.classList.remove('active');
        },
        { enableHighAccuracy: true, timeout: 10000, maximumAge: 5000 }
      );
    }
    function stopGPS() {
      if (gpsWatchId !== null) { navigator.geolocation.clearWatch(gpsWatchId); gpsWatchId = null; }
      if (gpsMarker) { map.removeLayer(gpsMarker); gpsMarker = null; }
    }
  })();
