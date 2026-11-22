import { PbfReader } from 'pbf';
import { VectorTile } from '@mapbox/vector-tile';

/**
 * @file TomTom traffic-flow vector-tile client: fetch + MVT decode.
 *
 * Fetches flow tiles from the local `/api/tomtom/flow/{z}/{x}/{y}.pbf` proxy
 * (the TomTom key never reaches the browser) and decodes the Mapbox Vector
 * Tile layer "Traffic flow" into plain lon/lat polylines with congestion
 * attributes. Consumed by the traffic layer's live mode
 * for matching congestion onto OpenStreetMap roads.
 *
 * Segment shape: `{coords: [[lon,lat],…], trafficLevel: 0..1, roadType: string,
 * closure: boolean}` — `trafficLevel` is TomTom's current/free-flow speed
 * ratio (1 = free flow). Features with a missing/non-finite `traffic_level`
 * are skipped unless `road_closure` is true (closures decode with level 0).
 *
 * Two schemas reach the browser. The Maps endpoint names the speed
 * `traffic_level` and the road class `road_type`; the Orbis endpoint names
 * the speed `relative_speed` and the road class `road_category`, with a
 * separate `road_subcategory`. The proxy says which one a tile carries
 * (`x-tomtom-schema`), so one decoder reads both and the layer downstream
 * sees one vocabulary.
 *
 * Deps: `pbf@5` (PbfReader) + `@mapbox/vector-tile@3` — both tiny and
 * tree-shakeable; decoding happens client-side so the proxy stays a dumb
 * binary cache.
 *
 * @module layers/traffic/flowDecode
 */

const FLOW_LAYER_NAME = 'Traffic flow';
/** The schema the Maps endpoint produces. */
const MAPS_SCHEMA = 'maps';
/** The schema the Orbis endpoint produces. */
const ORBIS_SCHEMA = 'orbis';

/**
 * Orbis road_category → the road_type names the layer classifies roads by.
 * A `_link` road is a ramp of the road it names, so it wears that name.
 */
const ORBIS_ROAD_TYPES = Object.freeze({
  motorway: 'Motorway',
  motorway_link: 'Motorway',
  trunk: 'International road',
  trunk_link: 'International road',
  primary: 'Major road',
  primary_link: 'Major road',
  secondary: 'Secondary road',
  secondary_link: 'Secondary road',
  tertiary: 'Connecting road',
  tertiary_link: 'Connecting road',
  street: 'Local road',
});

/** Orbis street subcategories that name a narrower road than the category. */
const ORBIS_STREET_TYPES = Object.freeze({
  living_street: 'Minor local road',
});

/** Orbis categories the layer never draws vehicles on. */
const ORBIS_DROPPED_CATEGORIES = new Set(['service', 'track']);

/**
 * The road class an Orbis category belongs to, without the ramp suffix:
 * `motorway_link` is a motorway.
 */
function orbisBaseCategory(category) {
  return category.endsWith('_link')
    ? category.slice(0, -'_link'.length)
    : category;
}

/**
 * Read one feature's traffic attributes.
 *
 * @param {Record<string, unknown>} props - The tile feature's properties.
 * @param {string} schema - Which endpoint produced the tile.
 * @returns {{trafficLevel:number, roadType:string, roadCategory:string|null, roadSubcategory:string|null, closure:boolean, coverage:string|null, leftHandTraffic:boolean}|null}
 *   The feature's attributes, or null when the feature is not one the layer
 *   draws (no usable speed, or a road the layer never puts vehicles on).
 */
export function readFlowProperties(props, schema = MAPS_SCHEMA) {
  const closure = props.road_closure === true || props.road_closure === 'true';
  const leftHandTraffic =
    props.left_hand_traffic === true || props.left_hand_traffic === 'true';

  if (schema === ORBIS_SCHEMA) {
    const category =
      typeof props.road_category === 'string' ? props.road_category : '';
    if (ORBIS_DROPPED_CATEGORIES.has(category)) return null;
    const roadType =
      ORBIS_STREET_TYPES[props.road_subcategory] ||
      ORBIS_ROAD_TYPES[category] ||
      '';
    const rawLevel = props.relative_speed;
    const hasLevel = typeof rawLevel === 'number' && Number.isFinite(rawLevel);
    if (!hasLevel && !closure) return null;
    return {
      trafficLevel: hasLevel ? Math.min(1, Math.max(0, rawLevel)) : 0,
      roadType,
      roadCategory: category ? orbisBaseCategory(category) : null,
      roadSubcategory:
        typeof props.road_subcategory === 'string'
          ? props.road_subcategory
          : null,
      closure,
      // Orbis draws one line per travel direction on a two-way road, so a
      // line covers one side.
      coverage: 'one_side',
      leftHandTraffic,
    };
  }

  const rawLevel = props.traffic_level;
  const hasLevel = typeof rawLevel === 'number' && Number.isFinite(rawLevel);
  // Skip features we can't color — unless closed (closures render dot-free
  // regardless of level, so they stay useful without one).
  if (!hasLevel && !closure) return null;
  return {
    trafficLevel: hasLevel ? Math.min(1, Math.max(0, rawLevel)) : 0,
    roadType: typeof props.road_type === 'string' ? props.road_type : '',
    roadCategory:
      typeof props.road_category === 'string' ? props.road_category : null,
    roadSubcategory:
      typeof props.road_subcategory === 'string'
        ? props.road_subcategory
        : null,
    closure,
    coverage:
      typeof props.traffic_road_coverage === 'string'
        ? props.traffic_road_coverage
        : null,
    leftHandTraffic,
  };
}

/** Decode flow geometry; strict mode distinguishes damaged tiles from valid empty coverage. */
export function decodeFlowTile(
  data,
  z,
  x,
  y,
  { strict = false, schema = MAPS_SCHEMA } = {},
) {
  let layer;
  try {
    const bytes = data instanceof ArrayBuffer ? new Uint8Array(data) : data;
    const tile = new VectorTile(new PbfReader(bytes));
    layer = tile.layers[FLOW_LAYER_NAME];
  } catch {
    if (strict) throw new Error('Malformed TomTom flow tile');
    return [];
  }
  if (!layer) return [];

  const segments = [];
  for (let i = 0; i < layer.length; i++) {
    let feature;
    let geometry;
    try {
      feature = layer.feature(i);
      geometry = feature.toGeoJSON(x, y, z).geometry;
    } catch {
      continue; // one malformed feature must not drop the tile
    }
    const props = feature.properties || {};
    const read = readFlowProperties(props, schema);
    if (!read) continue;

    const lines =
      geometry.type === 'LineString'
        ? [geometry.coordinates]
        : geometry.type === 'MultiLineString'
          ? geometry.coordinates
          : [];
    for (const coords of lines) {
      if (!Array.isArray(coords) || coords.length < 2) continue;
      segments.push({
        coords,
        trafficLevel: read.trafficLevel,
        roadType: read.roadType,
        roadCategory: read.roadCategory,
        roadSubcategory: read.roadSubcategory,
        closure: read.closure,
        coverage: read.coverage,
        leftHandTraffic: read.leftHandTraffic,
      });
    }
  }
  return segments;
}
