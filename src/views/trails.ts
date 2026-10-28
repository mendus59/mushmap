import { cellToLatLng, latLngToCell } from 'h3-js';
import type { GeoJSONSource, LngLat, Map as MapLibreMap } from 'maplibre-gl';
import { h, clear } from '../dom';
import { listFinds } from '../finds';
import { fillModelSelect, getJson, weekLabel } from '../generated';
import {
  forecastPointIndex, isoWeek, ownFindHistory, scoreCells, weatherForWeek,
  type CurrentWeather, type Forecast, type Grid, type Model, type ModelIndex,
} from '../heatmapModel';
import { SAFETY_NOTE, legalNoteEl } from '../legal';
import { createMap, maplibregl } from '../map';
import { expandSpeciesId, type Catalog } from '../species';
import {
  accessLabel, areaPublicLand, decodePolyline, describeAccess, rankTrails,
  type Bounds, type RankedTrail, type TrailData,
} from '../trailsModel';

const ACCESS_COLORS = ['interpolate', ['linear'], ['get', 's'],
  8, '#9e2a2a', 35, '#e08a2c', 60, '#d9c13a', 80, '#6aa84f', 100, '#1f7a3a'] as const;
const RESULT_COUNT = 20;
/** Trails are only drawn from this zoom in, where there are few enough to read. */
const TRAILS_MIN_ZOOM = 8;

function pct(x: number): string {
  return `${Math.round(x * 100)}%`;
}

function rectangle(a: LngLat, b: LngLat): Bounds {
  return {
    west: Math.min(a.lng, b.lng), east: Math.max(a.lng, b.lng),
    south: Math.min(a.lat, b.lat), north: Math.max(a.lat, b.lat),
  };
}

function boundsPolygon(b: Bounds) {
  return {
    type: 'Feature' as const,
    properties: {},
    geometry: {
      type: 'Polygon' as const,
      coordinates: [[[b.west, b.south], [b.east, b.south], [b.east, b.north], [b.west, b.north], [b.west, b.south]]],
    },
  };
}

export function trailsView(catalog: Catalog, uid: string): HTMLElement {
  const status = h('p', { class: 'muted' }, 'Loading trails…');
  const select = h('select', { 'aria-label': 'Species or group' });
  const week = h('input', { type: 'range', min: 1, max: 53, value: isoWeek(new Date()), 'aria-label': 'Week of year' });
  const weekText = h('strong', {}, weekLabel(Number(week.value)));
  const legalSlot = h('div');
  const searchView = h('button', { class: 'primary', disabled: true }, 'Search this map view');
  const drawArea = h('button', { disabled: true }, 'Draw an area');
  const resultsNote = h('p', { class: 'muted' }, 'Pick a mushroom and a week, then search the map view or draw an area.');
  const results = h('ol', { class: 'trail-results' });
  const mapEl = h('div', { class: 'map large' });
  const map: MapLibreMap = createMap(mapEl);

  let grid: Grid | null = null;
  let data: TrailData | null = null;
  let current: CurrentWeather | null = null;
  let forecast: { data: Forecast; pointIndex: Int32Array } | null = null;
  let cellIndex = new Map<string, number>();
  let centres: [number, number][] = [];
  let findCells: { speciesId: string; cell: string }[] = [];
  let area: Bounds | null = null;
  let ranked: RankedTrail[] = [];
  const models = new Map<string, Promise<Model | null>>();

  const ready = () => !!grid && !!data && !!select.value;
  const setReady = () => {
    searchView.disabled = !ready();
    drawArea.disabled = !ready();
  };

  const trailPopup = (i: number, at: LngLat | [number, number], r?: RankedTrail) => {
    const t = data!.trails[i];
    const html = document.createElement('div');
    html.append(h('strong', {}, t.n), h('br'), `Accessibility: ${t.s}/100 (${accessLabel(t.s)})`, h('br'));
    if (r) html.append(`Chance of the mushroom along it: ${pct(r.likelihood)}`, h('br'), `Overall: ${pct(r.overall)}`, h('br'));
    html.append(h('small', {}, describeAccess(t)));
    new maplibregl.Popup({ maxWidth: '320px' }).setLngLat(at).setDOMContent(html).addTo(map);
  };

  const showTrail = (r: RankedTrail) => {
    const [w, s, e, n] = r.trail.b;
    map.fitBounds([[w, s], [e, n]], { padding: 60, maxZoom: 14 });
    const [lat, lng] = cellToLatLng(grid!.cells[r.bestCell]);
    trailPopup(r.index, [lng, lat], r);
  };

  const cellScores = async (): Promise<Float32Array | null> => {
    const id = select.value;
    if (!models.has(id)) models.set(id, getJson<Model>(`model/${id}.json`));
    const model = await models.get(id);
    if (!model || !grid) return null;
    const ids = expandSpeciesId(catalog, id);
    const own = ownFindHistory(grid, cellIndex, findCells.filter((f) => ids.has(f.speciesId)).map((f) => f.cell));
    const w = Number(week.value);
    const weather = model.weather ? weatherForWeek(grid, w, current, forecast) : null;
    const out = new Float32Array(grid.cells.length);
    for (const s of scoreCells(grid, model, w, 0.01, weather, own)) out[s.index] = s.score;
    return out;
  };

  const search = async (b: Bounds) => {
    if (!ready()) return;
    area = b;
    (map.getSource('area') as GeoJSONSource | undefined)?.setData(boundsPolygon(b));
    resultsNote.textContent = 'Searching…';
    const scores = await cellScores();
    if (!scores || area !== b) return;
    ranked = rankTrails(data!.trails, scores, b, RESULT_COUNT);
    (map.getSource('results') as GeoJSONSource | undefined)?.setData({
      type: 'FeatureCollection',
      features: ranked.flatMap((r, rank) => r.trail.l.map((line) => ({
        type: 'Feature' as const,
        properties: { i: r.index, s: r.trail.s, rank: rank + 1 },
        geometry: { type: 'LineString' as const, coordinates: decodePolyline(line) },
      }))),
    });
    clear(results);
    const label = select.selectedOptions[0]?.textContent?.replace(/ \(.*\)$/, '') ?? 'this mushroom';
    if (!ranked.length) {
      const land = areaPublicLand(data!.cellLand, centres, b);
      resultsNote.textContent = `No trails here with any chance of ${label.toLowerCase()} in ${weekLabel(Number(week.value)).toLowerCase()}.` +
        (land !== null && land < 20 ? ' Most of this area is private or closed land, so access is very low.' : '');
      return;
    }
    resultsNote.textContent = `Top ${ranked.length} trails for ${label.toLowerCase()}, ${weekLabel(Number(week.value)).toLowerCase()}. ` +
      'Overall combines the chance along the trail with its accessibility.';
    ranked.forEach((r) => {
      const t = r.trail;
      results.append(h('li', {},
        h('button', { class: 'trail', onclick: () => showTrail(r) },
          h('span', { class: 'row between' },
            h('strong', {}, t.n),
            h('span', { class: 'overall' }, pct(r.overall))),
          h('span', { class: 'trail-scores' },
            h('span', {}, `Chance ${pct(r.likelihood)}`),
            h('span', { class: 'access-chip', style: `--chip:${accessColor(t.s)}` }, `Access ${t.s} · ${accessLabel(t.s)}`)),
          h('small', { class: 'muted' }, describeAccess(t)))));
    });
  };

  const startDrawing = () => {
    drawArea.textContent = 'Drag on the map…';
    map.dragPan.disable();
    map.getCanvas().style.cursor = 'crosshair';
    const canvas = map.getCanvasContainer();
    let start: LngLat | null = null;
    const at = (e: PointerEvent) => {
      const rect = canvas.getBoundingClientRect();
      return map.unproject([e.clientX - rect.left, e.clientY - rect.top]);
    };
    const down = (e: PointerEvent) => {
      start = at(e);
      canvas.setPointerCapture(e.pointerId);
    };
    const move = (e: PointerEvent) => {
      if (!start) return;
      (map.getSource('area') as GeoJSONSource | undefined)?.setData(boundsPolygon(rectangle(start, at(e))));
    };
    const up = (e: PointerEvent) => {
      if (!start) return;
      const b = rectangle(start, at(e));
      canvas.removeEventListener('pointerdown', down);
      canvas.removeEventListener('pointermove', move);
      canvas.removeEventListener('pointerup', up);
      map.dragPan.enable();
      map.getCanvas().style.cursor = '';
      drawArea.textContent = 'Draw an area';
      if (b.east - b.west > 0.005 && b.north - b.south > 0.005) search(b);
    };
    canvas.addEventListener('pointerdown', down);
    canvas.addEventListener('pointermove', move);
    canvas.addEventListener('pointerup', up);
  };

  const addTrailLayers = () => {
    if (!data || !map.isStyleLoaded() || map.getSource('trails')) return;
    map.addSource('trails', {
      type: 'geojson',
      data: {
        type: 'FeatureCollection',
        features: data.trails.flatMap((t, i) => t.l.map((line) => ({
          type: 'Feature' as const,
          properties: { i, s: t.s },
          geometry: { type: 'LineString' as const, coordinates: decodePolyline(line) },
        }))),
      },
    });
    map.addSource('results', { type: 'geojson', data: { type: 'FeatureCollection', features: [] } });
    map.addSource('area', { type: 'geojson', data: { type: 'FeatureCollection', features: [] } });
    map.addLayer({
      id: 'area', type: 'line', source: 'area',
      paint: { 'line-color': '#3d4a2f', 'line-width': 2, 'line-dasharray': [2, 2] },
    });
    map.addLayer({
      id: 'trails', type: 'line', source: 'trails', minzoom: TRAILS_MIN_ZOOM,
      paint: {
        'line-color': ACCESS_COLORS as unknown as string,
        'line-width': ['interpolate', ['linear'], ['zoom'], 8, 1.5, 13, 3],
        'line-opacity': 0.85,
      },
    });
    map.addLayer({
      id: 'results-casing', type: 'line', source: 'results',
      paint: { 'line-color': '#ffffff', 'line-width': ['interpolate', ['linear'], ['zoom'], 6, 5, 13, 9] },
    });
    map.addLayer({
      id: 'results', type: 'line', source: 'results',
      paint: {
        'line-color': ACCESS_COLORS as unknown as string,
        'line-width': ['interpolate', ['linear'], ['zoom'], 6, 3, 13, 6],
      },
    });
    for (const layer of ['trails', 'results']) {
      map.on('click', layer, (e) => {
        const i = e.features?.[0]?.properties?.i;
        if (typeof i !== 'number') return;
        trailPopup(i, e.lngLat, ranked.find((r) => r.index === i));
      });
      map.on('mouseenter', layer, () => { map.getCanvas().style.cursor = 'pointer'; });
      map.on('mouseleave', layer, () => { map.getCanvas().style.cursor = ''; });
    }
  };

  map.on('load', addTrailLayers);

  const rerun = () => { if (area) search(area); };
  const onSpecies = () => {
    clear(legalSlot);
    const group = catalog.groups.find((g) => g.id === select.value || g.species.some((s) => s.id === select.value));
    if (group?.legalNote) legalSlot.append(legalNoteEl());
    setReady();
    rerun();
  };

  (async () => {
    try {
      const [index, g, t, w, f, finds] = await Promise.all([
        getJson<ModelIndex>('model/index.json'), getJson<Grid>('cells.json'), getJson<TrailData>('trails/trails.json'),
        getJson<CurrentWeather>('weather/current.json').catch(() => null),
        getJson<Forecast>('weather/forecast.json').catch(() => null),
        listFinds(uid).catch(() => []),
      ]);
      if (!index || !g || !index.models.length) {
        status.textContent = 'The heat map data has not been generated yet. It appears after the first weekly data run.';
        return;
      }
      if (!t) {
        status.textContent = 'The trail data has not been generated yet. It appears after the next weekly data run.';
        return;
      }
      grid = g;
      data = t;
      current = w;
      if (f?.weeks.length) forecast = { data: f, pointIndex: forecastPointIndex(g, f) };
      cellIndex = new Map(g.cells.map((c, i) => [c, i]));
      centres = g.cells.map((c) => cellToLatLng(c) as [number, number]);
      findCells = finds
        .filter((x) => x.speciesId && x.lat !== null && x.lon !== null)
        .map((x) => ({ speciesId: x.speciesId!, cell: latLngToCell(x.lat!, x.lon!, g.res) }));
      fillModelSelect(select, catalog, index);
      status.textContent = `${t.trails.length.toLocaleString()} trails from OpenStreetMap, updated ` +
        `${new Date(t.generatedAt).toLocaleDateString()}. Zoom in to see them, coloured by accessibility.`;
      addTrailLayers();
      onSpecies();
    } catch (e) {
      status.textContent = `Could not load the trails: ${e instanceof Error ? e.message : e}`;
    }
  })();

  select.addEventListener('change', onSpecies);
  week.addEventListener('input', () => { weekText.textContent = weekLabel(Number(week.value)); });
  week.addEventListener('change', rerun);
  searchView.addEventListener('click', () => {
    const b = map.getBounds();
    search({ west: b.getWest(), south: b.getSouth(), east: b.getEast(), north: b.getNorth() });
  });
  drawArea.addEventListener('click', startDrawing);
  requestAnimationFrame(() => map.resize());

  return h('section', {},
    h('div', { class: 'card' },
      h('h1', {}, 'Trail finder'),
      h('label', { class: 'field' }, h('span', {}, 'Looking for'), select),
      h('label', { class: 'field' }, h('span', {}, 'Week'), weekText, week),
      h('div', { class: 'row' }, searchView, drawArea),
      status,
      legalSlot),
    mapEl,
    h('div', { class: 'card' },
      h('h2', {}, 'Best trails'),
      resultsNote,
      results),
    h('div', { class: 'card legend' },
      h('div', { class: 'ramp access' }),
      h('div', { class: 'row between' }, h('small', {}, 'Hard to access'), h('small', {}, 'Easy to access')),
      h('p', { class: 'muted' },
        'Accessibility runs from about 8 for trails on private or closed land, through about 50 for steep or ' +
        'difficult trails on public land, to 100 for easy, gentle trails on open public land that start at a ' +
        'road or trailhead. Land and public access come from the USGS Protected Areas Database (PAD-US); land it ' +
        'does not cover counts as private. Climbing comes from elevation along each trail and difficulty from ' +
        'OpenStreetMap. The chance along a trail uses the heat map for the chosen week, weighted towards the ' +
        'best spot it passes. Overall is the geometric mean of the two, so a trail needs both to rank high.'),
      h('p', { class: 'muted' },
        'Rules differ by land manager: many national forests need a free permit for personal harvest, and ' +
        'national and state parks often ban picking. Check before you go.'),
      h('p', { class: 'note' }, SAFETY_NOTE)),
  );
}

function accessColor(s: number): string {
  if (s >= 80) return '#1f7a3a';
  if (s >= 60) return '#6aa84f';
  if (s >= 35) return '#d9a23a';
  return '#9e2a2a';
}
