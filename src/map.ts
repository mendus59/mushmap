import * as maplibregl from 'maplibre-gl';
import 'maplibre-gl/dist/maplibre-gl.css';
import workerUrl from 'maplibre-gl/dist/maplibre-gl-worker.mjs?url';

// MapLibre looks for its worker next to its own module file, which a bundler moves.
maplibregl.setWorkerUrl(workerUrl);

// OpenFreeMap: free OpenStreetMap vector tiles, no API key.
const STYLE_URL = 'https://tiles.openfreemap.org/styles/liberty';

// Washington and Oregon, the first region the app covers.
export const PNW_CENTER: [number, number] = [-121.5, 45.6];

export function createMap(container: HTMLElement, opts: { center?: [number, number]; zoom?: number } = {}) {
  const map = new maplibregl.Map({
    container,
    style: STYLE_URL,
    center: opts.center ?? PNW_CENTER,
    zoom: opts.zoom ?? 5.3,
  });
  map.addControl(new maplibregl.NavigationControl({ showCompass: false }), 'top-right');
  map.addControl(new maplibregl.GeolocateControl({ trackUserLocation: false }), 'top-right');
  return map;
}

export { maplibregl };

/**
 * Detailed base maps for when you zoom in: raster topo tiles drawn over the street map and under
 * everything the app adds. Both are free and need no key.
 *   - USGS The National Map topo: public domain; shows Forest Service and BLM roads, trails and
 *     contours, close to what Gaia GPS's topo layers show.
 *   - OpenTopoMap: OpenStreetMap with contours and hill shading, including tracks and paths.
 */
export type BaseMap = 'auto' | 'streets' | 'usgs' | 'opentopo';

export const BASE_MAPS: { id: BaseMap; label: string }[] = [
  { id: 'auto', label: 'Auto: streets, then USGS topo when zoomed in' },
  { id: 'streets', label: 'Streets (OpenStreetMap)' },
  { id: 'usgs', label: 'USGS topo (forest roads, trails, contours)' },
  { id: 'opentopo', label: 'OpenTopoMap' },
];

/** Zoom where Auto starts fading from streets to topo, and where the topo is fully shown. */
const AUTO_FADE: [number, number] = [10, 11.5];

const RASTERS = {
  usgs: {
    tiles: ['https://basemap.nationalmap.gov/arcgis/rest/services/USGSTopo/MapServer/tile/{z}/{y}/{x}'],
    maxzoom: 16,
    attribution: 'USGS The National Map',
  },
  opentopo: {
    tiles: ['a', 'b', 'c'].map((s) => `https://${s}.tile.opentopomap.org/{z}/{x}/{y}.png`),
    maxzoom: 17,
    attribution: 'Map style © <a href="https://opentopomap.org">OpenTopoMap</a> (CC-BY-SA), data © OpenStreetMap contributors',
  },
} as const;

/** Add the topo layers on top of the street style; call on load, before adding the app's own layers. */
export function addBaseMaps(map: maplibregl.Map): void {
  for (const [id, r] of Object.entries(RASTERS)) {
    if (map.getSource(`base-${id}`)) continue;
    map.addSource(`base-${id}`, { type: 'raster', tiles: [...r.tiles], tileSize: 256, maxzoom: r.maxzoom, attribution: r.attribution });
    map.addLayer({ id: `base-${id}`, type: 'raster', source: `base-${id}`, layout: { visibility: 'none' } });
  }
}

export function setBaseMap(map: maplibregl.Map, base: BaseMap): void {
  if (!map.getLayer('base-usgs')) return;
  const show = (id: string, opacity: maplibregl.ExpressionSpecification | number | null) => {
    map.setLayoutProperty(id, 'visibility', opacity === null ? 'none' : 'visible');
    if (opacity !== null) map.setPaintProperty(id, 'raster-opacity', opacity);
  };
  show('base-usgs', base === 'usgs' ? 1
    : base === 'auto' ? ['interpolate', ['linear'], ['zoom'], AUTO_FADE[0], 0, AUTO_FADE[1], 1] : null);
  show('base-opentopo', base === 'opentopo' ? 1 : null);
}
