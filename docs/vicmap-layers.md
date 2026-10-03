# Vicmap layer names

Endpoints (both used by MelbMaps):

- WMS: `https://opendata.maps.vic.gov.au/geoserver/wms`
- WFS: `https://opendata.maps.vic.gov.au/geoserver/wfs`

## Confirmed working

These were confirmed working in the deployed app (v0.4 and earlier prototypes).

| Layer name | Used for | Service |
|---|---|---|
| `plan_zone` | Planning zones | WMS tiles + GetFeatureInfo |
| `plan_overlay` | Planning overlays | WMS tiles + GetFeatureInfo |
| `open-data-platform:property_view` | Property parcels | WMS tiles + GetFeatureInfo |
| `open-data-platform:locality_polygon` | Locality (suburb) boundaries | WMS tiles + WFS GeoJSON |
| `open-data-platform:lga_polygon` | Council boundaries (filtered by `lga_name`) | WFS GeoJSON |

## In the code but not confirmed

These are used by the Roads, Water and Rail toggles. They were never checked against GetCapabilities and may return blank tiles.

| Layer name | Used for |
|---|---|
| `open-data-platform:tr_road` | Roads |
| `open-data-platform:hy_watercourse` | Watercourses |
| `open-data-platform:tr_rail` | Rail and tram lines |

## v0.5 candidates (not yet verified)

| Feature | Candidate layer name | Status |
|---|---|---|
| Building footprints | `open-data-platform:building_polygon` | Seen in a partial GetCapabilities read on 3 Oct 2026; not tested |
| Easements | — | Not found yet |
| Features of interest | — | Not found yet |
| Postcode boundaries | — | Not found yet |

## How to verify a layer name

The full capabilities document is large. Search it for the name you need:

```
https://opendata.maps.vic.gov.au/geoserver/wms?service=WMS&version=1.3.0&request=GetCapabilities
```

Then test it on its own, for example as a WFS request limited to one feature:

```
https://opendata.maps.vic.gov.au/geoserver/wfs?service=WFS&version=1.0.0&request=GetFeature&typeName=<layer>&maxFeatures=1&outputFormat=application/json
```

Move a layer into "Confirmed working" only after it renders in the app.
