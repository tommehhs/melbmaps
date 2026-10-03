# MelbMaps

A mobile-first planning map for three western Melbourne councils: **Brimbank, Moonee Valley and Maribyrnong**. Tap anywhere to see the planning zone, overlays, parcel, approximate parcel area, council and nearest address, with links out to VicPlan, Google Maps, Street View and OpenStreetMap.

Built with vanilla JavaScript and [Leaflet](https://leafletjs.com/) on live Vicmap WMS/WFS data. No framework, no build step. A Brimbank Spatial product.

**Version:** v0.4 (the untouched single-file original is tagged `v0.4-original`).

## Features

- Planning zones, overlays and property parcels from Vicmap (WMS)
- Tap-to-identify with plain-English zone and overlay explanations and a property summary card
- Parcel outline highlight and approximate area (m² and ha)
- Council switcher: flies to one council and dims the other two; tap again to return to all three
- Header shows which council you're looking at (point-in-polygon, no extra requests)
- Locality browser, built from Vicmap locality data and filtered to the three councils
- Presets: **Planning** (default), **Property**, **Context**
- Extra layers: roads, watercourses, rail, aerial imagery
- Address search (Nominatim), GPS, Reset and Clear buttons
- One-finger zoom: double-tap, hold, then drag down to zoom in or up to zoom out

## Project structure

```
index.html        Page markup; loads Leaflet, then src/layers.js, then src/map.js
src/styles.css    All styles (dark theme, Geologica + DM Mono, amber accent)
src/layers.js     Config: council list, Vicmap endpoints and layer names, zone/overlay descriptions
src/map.js        Map, layers, presets, search, identify, GPS
docs/vicmap-layers.md   Vicmap layer names and their verification status
```

To change which councils are covered, edit the `LGAS` array at the top of `src/layers.js`. Nothing else needs to change.

## Run it locally

No install needed. Either:

- open `index.html` directly in a browser, or
- serve the folder: `python3 -m http.server 8000`, then open http://localhost:8000

An internet connection is required; all map data loads live from Vicmap, OpenStreetMap, Esri and Nominatim.

## Deploy (Cloudflare Pages)

1. Cloudflare dashboard → Workers & Pages → your MelbMaps project → **Create deployment**.
2. Upload the **whole folder** (`index.html` plus the `src/` folder). The page no longer works as a single file on its own.
3. Or connect this GitHub repo to Cloudflare Pages: build command blank, output directory `/`. Every push to `main` then redeploys automatically.

## Configuration and secrets

None. Every data source is public and needs no API key, so there is no `.env` file. If a keyed service is added later, put the key in a `.env` file (already gitignored) and list the variable name here.

## Data sources

- Vicmap Planning, Property, Admin, Transport and Hydro via `https://opendata.maps.vic.gov.au/geoserver/wms` and `/wfs` (Department of Transport and Planning)
- OpenStreetMap tiles and Nominatim geocoding
- Esri World Imagery (aerial)

Zone and overlay explanations are summaries only. Check VicPlan and the planning scheme before relying on them.

## Known issues

Carried over unchanged from v0.4. None were fixed during the migration.

1. **Roads, Water and Rail layers may be blank.** Their layer names (`open-data-platform:tr_road`, `hy_watercourse`, `tr_rail`) were never confirmed against Vicmap. See `docs/vicmap-layers.md`.
2. **Locality list can include localities outside the three councils.** It loads on a fixed 800 ms timer rather than waiting for the council boundaries. On a slow connection the council filter is skipped.
3. **Header shows "Western Melbourne" until council boundaries load**, and stays that way if they fail to load.
4. **Status counter is misleading.** It counts GPS and Aerial as active layers, and isn't refreshed when GPS fails.
5. **Unused CSS** for old chip and utility-button controls (`.chips`, `.chip`, `.utility-controls`, `.utility-btn`) is still in `src/styles.css`.
6. **Nominatim usage limits.** Search and reverse geocoding call the public Nominatim API directly (about 1 request per second allowed). Heavy use could get the site blocked.
7. **Parcel area is approximate.** It's calculated from mapped geometry with a spherical formula, as the app itself notes.

## Backlog — v0.5

Verify each new Vicmap layer name with GetCapabilities before building (see `docs/vicmap-layers.md`).

- [ ] Building footprints
- [ ] Easements
- [ ] Features of interest (separate toggles for schools, hospitals, emergency services)
- [ ] Postcode boundaries
- [ ] Buffer tool (fixed radii: 100 m, 250 m, 500 m)

Parked idea: a cut-down Suburb Explorer (single suburb such as Keilor East, selected by `?suburb=` URL parameter).
