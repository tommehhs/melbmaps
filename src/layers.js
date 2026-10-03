// MelbMaps v0.4 — layer config and planning reference data.
// Extracted verbatim from the original index.html; exposed on window.MelbMapsLayers for src/map.js.
  (function() {
    'use strict';

    // ====================================================================
    // CONFIG
    // ====================================================================
    // Three target LGAs. Add/remove here to change scope — no other code changes needed.
    const LGAS = [
      { key: 'brimbank',      name: 'Brimbank',      wfsFilter: "lga_name = 'BRIMBANK CITY'",       label: 'Brimbank City Council' },
      { key: 'moonee_valley', name: 'Moonee Valley', wfsFilter: "lga_name = 'MOONEE VALLEY CITY'", label: 'Moonee Valley City Council' },
      { key: 'maribyrnong',   name: 'Maribyrnong',   wfsFilter: "lga_name = 'MARIBYRNONG CITY'",   label: 'Maribyrnong City Council' }
    ];
    // Initial fallback view — replaced by fitBounds(combinedLgaBounds) after WFS load.
    const INITIAL_CENTER = [-37.780, 144.870];
    const INITIAL_ZOOM = 11;
    // Loose container bounds for map init; tightened to combined LGA bounds after load.
    const INIT_BOUNDS = L.latLngBounds([-38.00, 144.65], [-37.55, 145.10]);

    const WMS_BASE = 'https://opendata.maps.vic.gov.au/geoserver/wms';
    const WFS_BASE = 'https://opendata.maps.vic.gov.au/geoserver/wfs';
    const LAYER_ZONE = 'plan_zone';
    const LAYER_OVERLAY = 'plan_overlay';
    const LAYER_PARCELS = 'open-data-platform:property_view';
    const LAYER_LOCALITY = 'open-data-platform:locality_polygon';
    const LAYER_LGA = 'open-data-platform:lga_polygon';
    const LAYER_ROADS = 'open-data-platform:tr_road';
    const LAYER_WATER = 'open-data-platform:hy_watercourse';
    const LAYER_RAIL = 'open-data-platform:tr_rail';

    // ====================================================================
    // DATA: Planning zone descriptions (Vic planning scheme)
    // ====================================================================
    const ZONE_DESCRIPTIONS = {
      'GRZ':  'General Residential Zone: residential areas that allow housing with moderate change. Common uses include dwellings and some compatible community or local uses, subject to planning controls.',
      'NRZ':  'Neighbourhood Residential Zone: residential areas where neighbourhood character and lower-scale housing change are more strongly protected.',
      'RGZ':  'Residential Growth Zone: residential areas intended to support more housing growth and higher-density development near services, transport and activity centres.',
      'MUZ':  'Mixed Use Zone: allows a mix of residential, commercial, office and other compatible uses in areas intended for flexible urban activity.',
      'TZ':   'Township Zone: supports residential, commercial and community uses in smaller township-style areas.',
      'LDRZ': 'Low Density Residential Zone: residential land with larger lots, usually with limits on subdivision and density.',
      'RLZ':  'Rural Living Zone: rural-residential land, usually larger lots with a semi-rural character.',
      'C1Z':  'Commercial 1 Zone: supports retail, office, business, entertainment, community and residential uses, often around activity centres and shopping strips.',
      'C2Z':  'Commercial 2 Zone: supports offices, restricted retail, bulky goods, manufacturing and other commercial uses that need larger sites or separation from sensitive uses.',
      'ACZ':  'Activity Centre Zone: supports concentrated mixed-use development in designated activity centres, often guided by a local structure plan.',
      'IN1Z': 'Industrial 1 Zone: supports manufacturing, industry, warehousing and related uses, while managing impacts on nearby sensitive areas.',
      'IN2Z': 'Industrial 2 Zone: supports heavier industrial uses that may need more separation from residential or sensitive uses.',
      'IN3Z': 'Industrial 3 Zone: supports industry and office-style industrial activity with stronger amenity protections near residential areas.',
      'SUZ':  'Special Use Zone: land set aside for a specific special purpose that does not fit standard zones. Check the schedule for the exact use and controls.',
      'PUZ':  'Public Use Zone: land used for public purposes such as education, transport, utilities, health or government services. The schedule identifies the specific public use.',
      'PCRZ': 'Public Conservation and Resource Zone: public land managed for conservation, natural resource protection or related public purposes.',
      'PPRZ': 'Public Park and Recreation Zone: public land used for parks, open space, sport and recreation.',
      'RDZ1': 'Road Zone Category 1: major roads and road infrastructure managed for transport movement and road functions.',
      'RDZ2': 'Road Zone Category 2: roads and road infrastructure with a lower category than RDZ1.',
      'TRZ':  'Transport Zone: land used for transport systems and infrastructure, such as roads, railways and transport corridors.',
      'UGZ':  'Urban Growth Zone: growth-area land subject to precinct structure planning. Check the applied zone and schedule.',
      'CDZ':  'Comprehensive Development Zone: land planned under a comprehensive development plan. Check the schedule and incorporated plan for detailed controls.',
      'PDZ':  'Priority Development Zone: land identified for priority development, usually with specific local controls and development plans.'
    };

    const OVERLAY_DESCRIPTIONS = {
      'SBO':  'Special Building Overlay: land that may be affected by stormwater flooding, drainage constraints or overland flow. Building works may need extra flood/drainage assessment.',
      'LSIO': 'Land Subject to Inundation Overlay: land that may be affected by flooding from waterways, drainage systems or floodplains. Development may need flood advice or floor level controls.',
      'FO':   'Floodway Overlay: land with a significant flood conveyance function. Development is usually more restricted because it may affect flood flow or be exposed to flood hazard.',
      'BMO':  'Bushfire Management Overlay: land with bushfire risk. Development may require bushfire protection measures, defendable space and CFA/fire authority consideration.',
      'HO':   'Heritage Overlay: protects places with heritage significance. Changes to buildings, demolition, painting, fences or trees may need planning approval.',
      'DDO':  'Design and Development Overlay: sets built form/design controls such as height, setbacks, landscaping, building envelope or design requirements.',
      'DPO':  'Development Plan Overlay: requires a development plan before certain permits can be granted. Often used for larger precincts or staged development areas.',
      'IPO':  'Incorporated Plan Overlay: requires development to be consistent with an incorporated plan listed in the planning scheme.',
      'ESO':  'Environmental Significance Overlay: protects environmental values such as waterways, vegetation, habitat or landscape. Works may need environmental assessment.',
      'VPO':  'Vegetation Protection Overlay: protects significant vegetation. Tree removal, lopping or works near vegetation may need approval.',
      'SLO':  'Significant Landscape Overlay: protects important landscape character, views or environmental landscape qualities.',
      'PAO':  'Public Acquisition Overlay: land reserved for possible future acquisition by a public authority, such as for roads, drainage or infrastructure.',
      'EAO':  'Environmental Audit Overlay: land that may be contaminated or require environmental audit before sensitive uses such as housing or childcare.',
      'DCPO': 'Development Contributions Plan Overlay: land where development may need to pay infrastructure contributions.',
      'RO':   'Restructure Overlay: controls subdivision or development in areas where land needs to be restructured.',
      'PO':   'Parking Overlay: sets parking rates or parking-related controls that can vary from standard planning scheme requirements.',
      'MAEO': 'Melbourne Airport Environs Overlay: manages noise-sensitive uses around Melbourne Airport. Housing or sensitive uses may have extra restrictions.',
      'AEO':  'Airport Environs Overlay: manages land use and development around airports, including aircraft noise and safety considerations.',
      'SCO':  'Specific Controls Overlay: land where specific incorporated controls apply. Check the schedule and incorporated document.'
    };

    function normaliseCode(code) {
      if (!code) return '';
      return String(code).toUpperCase().trim().replace(/[^A-Z0-9]/g, '');
    }

    function baseZoneCode(code) {
      const z = normaliseCode(code);
      if (ZONE_DESCRIPTIONS[z]) return z;
      const keep = ['C1Z','C2Z','IN1Z','IN2Z','IN3Z','RDZ1','RDZ2'];
      for (const family of keep) if (z.startsWith(family) && ZONE_DESCRIPTIONS[family]) return family;
      const trimNum = z.replace(/\d+$/, '');
      if (ZONE_DESCRIPTIONS[trimNum]) return trimNum;
      const trimSched = z.replace(/S\d+$/, '');
      if (ZONE_DESCRIPTIONS[trimSched]) return trimSched;
      return z;
    }

    function baseOverlayCode(code) {
      const raw = normaliseCode(code);
      if (OVERLAY_DESCRIPTIONS[raw]) return raw;
      const trimNum = raw.replace(/\d+$/, '');
      if (OVERLAY_DESCRIPTIONS[trimNum]) return trimNum;
      const trimSched = raw.replace(/S\d+$/, '');
      if (OVERLAY_DESCRIPTIONS[trimSched]) return trimSched;
      return raw;
    }

    function getZoneDescription(code) {
      return ZONE_DESCRIPTIONS[baseZoneCode(code)] || 'No built-in summary for this zone. Use VicPlan and the planning scheme schedule for legal controls.';
    }
    function getOverlayDescription(code) {
      return OVERLAY_DESCRIPTIONS[baseOverlayCode(code)] || 'No built-in summary for this overlay. Use VicPlan and the planning scheme schedule for legal controls.';
    }

    window.MelbMapsLayers = {
      LGAS, INITIAL_CENTER, INITIAL_ZOOM, INIT_BOUNDS,
      WMS_BASE, WFS_BASE,
      LAYER_ZONE, LAYER_OVERLAY, LAYER_PARCELS, LAYER_LOCALITY, LAYER_LGA,
      LAYER_ROADS, LAYER_WATER, LAYER_RAIL,
      ZONE_DESCRIPTIONS, OVERLAY_DESCRIPTIONS,
      normaliseCode, baseZoneCode, baseOverlayCode, getZoneDescription, getOverlayDescription
    };
  })();
