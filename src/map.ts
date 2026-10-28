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
