import { cellToBoundary, cellToLatLng, latLngToCell } from 'h3-js';
import type { GeoJSONSource, LngLat, Map as MapLibreMap } from 'maplibre-gl';
import { h, clear } from '../dom';
import { listFinds } from '../finds';
import {
  forecastPointIndex, isoWeek, ownFindHistory, regionTotal, scoreCells, topSpots, weatherForWeek, weekStart,
  type CellScore, type CurrentWeather, type Forecast, type Grid, type Model, type ModelIndex,
} from '../heatmapModel';
import { SAFETY_NOTE, groupNotes } from '../legal';
import { fillModelSelect, getJson, shortDate, weekLabel } from '../generated';
import { BASE_MAPS, addBaseMaps, createMap, maplibregl, setBaseMap, type BaseMap } from '../map';
import { describeSpeciesId, expandSpeciesId, type Catalog } from '../species';
import {
  accessLabel, areaPublicLand, decodePolyline, describeAccess, detectPlatform, navigationLinks, nearestEnd,
  rankTrails, type Bounds, type RankedTrail, type Trail, type TrailData,
} from '../trailsModel';
import { cellCentres, likelyHerePanel } from './likelyHere';

const ACCESS_COLORS = ['interpolate', ['linear'], ['get', 's'],
  8, '#9e2a2a', 35, '#e08a2c', 60, '#d9c13a', 80, '#6aa84f', 100, '#1f7a3a'] as const;
const RESULT_COUNT = 20;
/** Trails are only drawn from this zoom in, where there are few enough to read. */
const TRAILS_MIN_ZOOM = 7;
/** Trail layers that take clicks: wide, invisible lines so a thin trail is easy to tap. */
const TRAIL_HIT_LAYERS = ['trails-hit', 'results-hit'];

function pct(x: number): string {
  return `${Math.round(x * 100)}%`;
}

function rectangle(a: LngLat, b: LngLat): Bounds {
  return {
    west: Math.min(a.lng, b.lng), east: Math.max(a.lng, b.lng),
    south: Math.min(a.lat, b.lat), north: Math.max(a.lat, b.lat),
  };
}

function trailFeatures(t: Trail, properties: Record<string, number>) {
  return t.l.map((line) => ({
    type: 'Feature' as const,
    properties,
    geometry: { type: 'LineString' as const, coordinates: decodePolyline(line) },
  }));
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

/** How many weeks the outlook strip shows, starting with this week. */
const OUTLOOK_WEEKS = 5;

function weekOffset(week: number, by: number): number {
  return ((week - 1 + by) % 53 + 53) % 53 + 1;
}

function weatherLine(w: CurrentWeather, i: number, lift: number): string {
  const when = w.forecastFor
    ? `Forecast to ${shortDate(w.forecastFor)}: `
    : 'Recent weather: ';
  return `${when}${w.p14[i]} mm rain in ${w.pDays} days, ${w.t7[i]} °C average over ${w.tDays} (${weatherWords(lift)})`;
}

function weatherWords(lift: number): string {
  if (lift >= 1.2) return `better than usual for finds, ×${lift.toFixed(1)}`;
  if (lift <= 0.8) return `worse than usual for finds, ×${lift.toFixed(1)}`;
  return 'about usual for finds';
}

/** The heat map and the trail finder on one map, each layer switchable. */
export function forageMapView(catalog: Catalog, uid: string): HTMLElement {
  const status = h('p', { class: 'muted' }, 'Loading map data…');
  const showHeat = h('input', { type: 'checkbox', checked: true });
  const showTrails = h('input', { type: 'checkbox', checked: true });
  const baseSelect = h('select', { 'aria-label': 'Base map' },
    ...BASE_MAPS.map((b) => h('option', { value: b.id }, b.label)));
  try {
    const saved = localStorage.getItem('mushmap.baseMap');
    if (saved && BASE_MAPS.some((b) => b.id === saved)) baseSelect.value = saved;
  } catch { /* storage blocked: keep the default */ }
  const searchView = h('button', { class: 'primary', disabled: true }, 'Find trails in this view');
  const drawArea = h('button', { disabled: true }, 'Draw an area');
  const resultsNote = h('p', { class: 'muted' }, 'Pick a mushroom and a week, then search the map view or draw an area.');
  const results = h('ol', { class: 'trail-results' });
  const outlookEl = h('div', { class: 'outlook' });
  const spotsEl = h('ol', { class: 'spots' });
  const select = h('select', { 'aria-label': 'Species or group' });
  const week = h('input', { type: 'range', min: 1, max: 53, value: isoWeek(new Date()), 'aria-label': 'Week of year' });
  const weekText = h('strong', {});
  const legalSlot = h('div');
  const mapEl = h('div', { class: 'map large' });
  const map: MapLibreMap = createMap(mapEl);
  // Set once on 'load'. isStyleLoaded() is false whenever any tile is still loading, so it cannot
  // gate adding layers: trail data arriving mid-load would be dropped and never added.
  let styleReady = false;

  let grid: Grid | null = null;
  let model: Model | null = null;
  let current: CurrentWeather | null = null;
  let forecast: { data: Forecast; pointIndex: Int32Array } | null = null;
  let weather: CurrentWeather | null = null;
  let cellIndex = new Map<string, number>();
  let findCells: { speciesId: string; cell: string }[] = [];
  let own: Map<number, number> | null = null;
  let scores: CellScore[] = [];
  let trailData: TrailData | null = null;
  let centres: [number, number][] = [];
  let area: Bounds | null = null;
  let ranked: RankedTrail[] = [];
  let selected: number | null = null;
  let openPopup: maplibregl.Popup | null = null;
  const platform = detectPlatform(navigator.userAgent);
  const models = new Map<string, Promise<Model | null>>();
  const boundaries = new Map<number, [number, number][]>();
  const fetchModel = (id: string) => {
    if (!models.has(id)) {
      // A failed download is forgotten so the next try fetches again.
      models.set(id, getJson<Model>(`model/${id}.json`).catch((e) => { models.delete(id); throw e; }));
    }
    return models.get(id)!;
  };
  const ownFor = (id: string) => {
    if (!grid) return null;
    const ids = expandSpeciesId(catalog, id);
    return ownFindHistory(grid, cellIndex, findCells.filter((f) => ids.has(f.speciesId)).map((f) => f.cell));
  };
  const viewBounds = (): Bounds => {
    const b = map.getBounds();
    return { west: b.getWest(), south: b.getSouth(), east: b.getEast(), north: b.getNorth() };
  };
  const likely = likelyHerePanel(catalog, {
    mapViewBounds: viewBounds,
    onShow: (id) => {
      select.value = id;
      void loadModel(id);
      mapEl.scrollIntoView({ behavior: 'smooth', block: 'center' });
    },
  });

  const boundary = (i: number) => {
    let b = boundaries.get(i);
    if (!b) {
      b = cellToBoundary(grid!.cells[i], true) as [number, number][];
      b.push(b[0]);
      boundaries.set(i, b);
    }
    return b;
  };

  const weatherFor = (w: number) => (grid && model?.weather ? weatherForWeek(grid, w, current, forecast) : null);

  const showSpot = (s: CellScore) => {
    const [lat, lng] = cellToLatLng(grid!.cells[s.index]);
    map.flyTo({ center: [lng, lat], zoom: Math.max(map.getZoom(), 10) });
    popupFor(s, { lng, lat });
  };

  const drawSpots = () => {
    clear(spotsEl);
    if (!grid) return;
    for (const s of topSpots(grid, scores)) {
      const [lat, lng] = cellToLatLng(grid.cells[s.index]);
      const why = [
        s.history >= 0.5 ? (s.own ? 'your finds' : 'past sightings') : null,
        s.host !== null && s.host >= 0.5 ? 'host trees' : null,
        s.weather !== null && s.weather >= 1.2 ? 'good weather' : null,
        s.weather !== null && s.weather <= 0.8 ? 'poor weather' : null,
      ].filter(Boolean).join(', ');
      spotsEl.append(h('li', {},
        h('button', { class: 'spot', onclick: () => showSpot(s) },
          h('strong', {}, `${Math.round(s.score * 100)}%`),
          h('span', {}, `${lat.toFixed(3)}, ${lng.toFixed(3)} · ${grid.elev[s.index]} m`),
          why ? h('small', { class: 'muted' }, why) : null)));
    }
    if (!spotsEl.childElementCount) spotsEl.append(h('li', { class: 'muted' }, 'No likely spots this week.'));
  };

  /** Region-wide totals for this week and the next few, so the user can see when things pick up. */
  const drawOutlook = () => {
    clear(outlookEl);
    if (!grid || !model) return;
    const thisWeek = isoWeek(new Date());
    const weeks = Array.from({ length: OUTLOOK_WEEKS }, (_, n) => weekOffset(thisWeek, n));
    const totals = weeks.map((w) => regionTotal(scoreCells(grid!, model!, w, undefined, weatherFor(w), own)));
    const top = Math.max(...totals, 1e-9);
    outlookEl.append(...weeks.map((w, n) => {
      const forecastWeek = !!forecast?.data.weeks.some((x) => x.week === w) && !!model!.weather;
      return h('button', {
        class: `outlook-week${Number(week.value) === w ? ' active' : ''}`,
        title: forecastWeek ? 'Uses the weather forecast' : 'Season and place only',
        onclick: () => { week.value = String(w); draw(); },
      },
      h('span', { class: 'bar', style: `height:${Math.max(4, Math.round((totals[n] / top) * 48))}px` }),
      h('small', {}, n === 0 ? 'This wk' : shortDate(weekStart(new Date().getFullYear() + (w < thisWeek ? 1 : 0), w).toISOString().slice(0, 10))),
      forecastWeek ? h('small', { class: 'muted' }, 'forecast') : null);
    }));
  };

  const draw = () => {
    weekText.textContent = weekLabel(Number(week.value));
    outlookEl.querySelectorAll('.outlook-week').forEach((b, n) =>
      b.classList.toggle('active', weekOffset(isoWeek(new Date()), n) === Number(week.value)));
    if (!grid || !model) return;
    weather = weatherFor(Number(week.value));
    scores = scoreCells(grid, model, Number(week.value), undefined, weather, own);
    const source = map.getSource('cells') as GeoJSONSource | undefined;
    source?.setData({
      type: 'FeatureCollection',
      features: scores.map((s, i) => ({
        type: 'Feature',
        id: i,
        geometry: { type: 'Polygon', coordinates: [boundary(s.index)] },
        properties: { score: s.score, i },
      })),
    });
    const weatherNote = weather?.forecastFor
      ? ` Includes the ${forecast!.data.source} weather forecast from ${shortDate(weather.asOf)}.`
      : weather ? ` Includes weather up to ${shortDate(weather.asOf)}.`
      : current || forecast ? ' Weather only counts for the next few weeks.' : '';
    const ownNote = own?.size ? ' Your own finds count as sightings.' : '';
    status.textContent = (scores.length
      ? `${scores.length.toLocaleString()} cells with some chance this week, from ${model.count.toLocaleString()} iNaturalist sightings.`
      : 'Out of season this week: no recorded sightings at this time of year.') + weatherNote + ownNote;
    drawSpots();
    if (area) search(area);
  };

  const setSelected = (i: number | null) => {
    selected = i;
    (map.getSource('selected') as GeoJSONSource | undefined)?.setData({
      type: 'FeatureCollection',
      features: i === null ? [] : trailFeatures(trailData!.trails[i], { i }),
    });
    for (const li of results.querySelectorAll<HTMLElement>('li[data-i]')) {
      li.classList.toggle('selected', Number(li.dataset.i) === i);
    }
  };

  /** Highlights a trail and opens its details, with directions to the trail end nearest `at`. */
  const selectTrail = (i: number, at: [number, number], r?: RankedTrail) => {
    const t = trailData!.trails[i];
    openPopup?.remove();
    setSelected(i);
    const html = h('div', { class: 'trail-popup' },
      h('strong', {}, t.n), h('br'), `Accessibility: ${t.s}/100 (${accessLabel(t.s)})`, h('br'));
    if (r) html.append(`Chance of the mushroom along it: ${pct(r.likelihood)}`, h('br'), `Overall: ${pct(r.overall)}`, h('br'));
    html.append(h('small', {}, describeAccess(t)));
    likely.setPlace({ kind: 'trail', label: t.n, cells: t.c });
    html.append(h('div', {}, h('button', {
      type: 'button', class: 'text-link',
      // Picking the trail already set the place; this brings the list into view.
      onclick: () => likely.el.scrollIntoView({ behavior: 'smooth', block: 'start' }),
    }, 'What mushrooms are likely here?')));
    const end = nearestEnd(t, at);
    if (end) {
      const [lng, lat] = end;
      html.append(
        h('div', { class: 'nav-title' }, 'Directions to the nearest trail end'),
        h('div', { class: 'nav-links' }, ...navigationLinks(lat, lng, t.n, platform).map((l) =>
          h('a', { class: 'button', href: l.href, target: l.href.startsWith('http') ? '_blank' : null, rel: 'noopener' }, l.label))),
      );
    }
    const popup = new maplibregl.Popup({ maxWidth: '320px' }).setLngLat(at).setDOMContent(html).addTo(map);
    popup.on('close', () => {
      if (openPopup === popup) {
        openPopup = null;
        if (selected === i) setSelected(null);
      }
    });
    openPopup = popup;
  };

  const showTrail = (r: RankedTrail) => {
    const [w, s, e, n] = r.trail.b;
    map.fitBounds([[w, s], [e, n]], { padding: 60, maxZoom: 14 });
    const [lat, lng] = cellToLatLng(grid!.cells[r.bestCell]);
    selectTrail(r.index, [lng, lat], r);
    mapEl.scrollIntoView({ behavior: 'smooth', block: 'center' });
  };

  const cellScores = (): Float32Array => {
    const out = new Float32Array(grid!.cells.length);
    for (const s of scores) out[s.index] = s.score;
    return out;
  };

  const search = (b: Bounds) => {
    if (!ready()) return;
    area = b;
    (map.getSource('area') as GeoJSONSource | undefined)?.setData(boundsPolygon(b));
    ranked = rankTrails(trailData!.trails, cellScores(), b, RESULT_COUNT);
    (map.getSource('results') as GeoJSONSource | undefined)?.setData({
      type: 'FeatureCollection',
      features: ranked.flatMap((r, rank) => trailFeatures(r.trail, { i: r.index, s: r.trail.s, rank: rank + 1 })),
    });
    clear(results);
    if (selected !== null && !ranked.some((r) => r.index === selected)) openPopup?.remove();
    const label = describeSpeciesId(catalog, select.value)?.label ?? 'this mushroom';
    if (!ranked.length) {
      const land = areaPublicLand(trailData!.cellLand, centres, b);
      resultsNote.textContent = `No trails here with any chance of ${label} in ${weekLabel(Number(week.value)).toLowerCase()}.` +
        (land !== null && land < 20 ? ' Most of this area is private or closed land, so access is very low.' : '');
      return;
    }
    resultsNote.textContent = `Top ${ranked.length} trails for ${label}, ${weekLabel(Number(week.value)).toLowerCase()}. ` +
      'Overall combines the chance along the trail with its accessibility.';
    ranked.forEach((r) => {
      const t = r.trail;
      results.append(h('li', { 'data-i': r.index, class: r.index === selected ? 'selected' : null },
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
      if (b.east - b.west > 0.005 && b.north - b.south > 0.005) {
        likely.setPlace({ kind: 'area', label: 'Your drawn area', bounds: b });
        search(b);
      }
    };
    canvas.addEventListener('pointerdown', down);
    canvas.addEventListener('pointermove', move);
    canvas.addEventListener('pointerup', up);
  };

  const addTrailLayers = () => {
    if (!trailData || !styleReady || map.getSource('trails')) return;
    map.addSource('trails', {
      type: 'geojson',
      data: {
        type: 'FeatureCollection',
        features: trailData.trails.flatMap((t, i) => trailFeatures(t, { i, s: t.s })),
      },
    });
    map.addSource('results', { type: 'geojson', data: { type: 'FeatureCollection', features: [] } });
    map.addSource('selected', { type: 'geojson', data: { type: 'FeatureCollection', features: [] } });
    map.addSource('area', { type: 'geojson', data: { type: 'FeatureCollection', features: [] } });
    map.addLayer({
      id: 'area', type: 'line', source: 'area',
      paint: { 'line-color': '#3d4a2f', 'line-width': 2, 'line-dasharray': [2, 2] },
    });
    // A dark outline keeps trails readable over the heat map and the topo base map.
    map.addLayer({
      id: 'trails-casing', type: 'line', source: 'trails', minzoom: TRAILS_MIN_ZOOM,
      layout: { 'line-cap': 'round', 'line-join': 'round' },
      paint: {
        'line-color': '#1b1d18',
        'line-width': ['interpolate', ['linear'], ['zoom'], 7, 3, 13, 6],
        'line-opacity': 0.8,
      },
    });
    map.addLayer({
      id: 'trails', type: 'line', source: 'trails', minzoom: TRAILS_MIN_ZOOM,
      layout: { 'line-cap': 'round', 'line-join': 'round' },
      paint: {
        'line-color': ACCESS_COLORS as unknown as string,
        'line-width': ['interpolate', ['linear'], ['zoom'], 7, 1.5, 13, 3.5],
      },
    });
    map.addLayer({
      id: 'results-casing', type: 'line', source: 'results',
      layout: { 'line-cap': 'round', 'line-join': 'round' },
      paint: { 'line-color': '#1b1d18', 'line-width': ['interpolate', ['linear'], ['zoom'], 6, 6, 13, 10] },
    });
    map.addLayer({
      id: 'results', type: 'line', source: 'results',
      paint: {
        'line-color': ACCESS_COLORS as unknown as string,
        'line-width': ['interpolate', ['linear'], ['zoom'], 6, 3, 13, 6],
      },
    });
    // The picked trail glows on top of everything, at any zoom.
    map.addLayer({
      id: 'selected-glow', type: 'line', source: 'selected',
      layout: { 'line-cap': 'round', 'line-join': 'round' },
      paint: { 'line-color': '#ffffff', 'line-width': ['interpolate', ['linear'], ['zoom'], 6, 10, 13, 16], 'line-opacity': 0.9 },
    });
    map.addLayer({
      id: 'selected', type: 'line', source: 'selected',
      layout: { 'line-cap': 'round', 'line-join': 'round' },
      paint: { 'line-color': '#1e6bd6', 'line-width': ['interpolate', ['linear'], ['zoom'], 6, 4, 13, 8] },
    });
    map.addLayer({
      id: 'trails-hit', type: 'line', source: 'trails', minzoom: TRAILS_MIN_ZOOM,
      paint: { 'line-color': '#000000', 'line-opacity': 0, 'line-width': 16 },
    });
    map.addLayer({
      id: 'results-hit', type: 'line', source: 'results',
      paint: { 'line-color': '#000000', 'line-opacity': 0, 'line-width': 18 },
    });
    map.on('click', (e) => {
      const layers = TRAIL_HIT_LAYERS.filter((l) => map.getLayer(l) && map.getLayoutProperty(l, 'visibility') !== 'none');
      const hits = map.queryRenderedFeatures(e.point, { layers });
      // A recommended trail wins over an ordinary one under the same tap.
      const hit = hits.find((f) => f.layer.id === 'results-hit') ?? hits[0];
      const i = hit?.properties?.i;
      if (typeof i !== 'number') return;
      selectTrail(i, [e.lngLat.lng, e.lngLat.lat], ranked.find((r) => r.index === i));
    });
    for (const layer of TRAIL_HIT_LAYERS) {
      map.on('mouseenter', layer, () => { map.getCanvas().style.cursor = 'pointer'; });
      map.on('mouseleave', layer, () => { map.getCanvas().style.cursor = ''; });
    }
  };

  const ready = () => !!grid && !!model && !!trailData;
  const setReady = () => {
    searchView.disabled = !ready();
    drawArea.disabled = !ready();
  };

  const setVisibility = () => {
    if (!styleReady) return;
    const vis = (on: boolean) => (on ? 'visible' : 'none');
    if (map.getLayer('cells')) map.setLayoutProperty('cells', 'visibility', vis(showHeat.checked));
    for (const id of ['trails', 'trails-casing', 'trails-hit']) {
      if (map.getLayer(id)) map.setLayoutProperty(id, 'visibility', vis(showTrails.checked));
    }
  };

  const loadModel = async (id: string) => {
    const m = await fetchModel(id);
    if (select.value !== id) return; // the user picked something else meanwhile
    model = m;
    own = ownFor(id);
    clear(legalSlot);
    const group = catalog.groups.find((g) => g.id === id || g.species.some((s) => s.id === id));
    legalSlot.append(...groupNotes(group));
    drawOutlook();
    draw();
    setReady();
  };

  const popupFor = (s: CellScore, at: { lng: number; lat: number }) => {
    if (!grid) return;
    new maplibregl.Popup()
      .setLngLat(at)
      .setHTML(
        `<strong>${Math.round(s.score * 100)}% relative likelihood</strong><br>` +
        `Season and elevation fit: ${Math.round(s.season * 100)}%<br>` +
        `Past sightings nearby: ${Math.round(s.history * 100)}%${s.own ? ' (includes your finds)' : ''}<br>` +
        (s.host === null ? '' : `Host trees: ${Math.round(s.host * 100)}%<br>`) +
        (s.weather === null || !weather ? '' : `${weatherLine(weather, s.index, s.weather)}<br>`) +
        `Elevation: ${grid.elev[s.index]} m`,
      )
      .addTo(map);
  };

  map.on('load', () => {
    styleReady = true;
    addBaseMaps(map);
    setBaseMap(map, baseSelect.value as BaseMap);
    map.addSource('cells', { type: 'geojson', data: { type: 'FeatureCollection', features: [] } });
    map.addLayer({
      id: 'cells',
      type: 'fill',
      source: 'cells',
      paint: {
        'fill-color': ['interpolate', ['linear'], ['get', 'score'],
          0.08, '#ffe9a8', 0.3, '#f6a03d', 0.6, '#d9542c', 1, '#8c1d18'],
        // Fainter as you zoom in, so trails, roads and contours show through.
        'fill-opacity': ['interpolate', ['linear'], ['zoom'], 6, 0.6, 10, 0.4, 13, 0.25],
      },
    });
    map.on('click', 'cells', (e) => {
      // A trail on top of the cell gets the click.
      const onTrail = map.queryRenderedFeatures(e.point, {
        layers: TRAIL_HIT_LAYERS.filter((l) => map.getLayer(l) && map.getLayoutProperty(l, 'visibility') !== 'none'),
      });
      if (onTrail.length) return;
      const i = e.features?.[0]?.properties?.i;
      const s = typeof i === 'number' ? scores[i] : undefined;
      if (s) popupFor(s, e.lngLat);
    });
    map.on('mouseenter', 'cells', () => { map.getCanvas().style.cursor = 'pointer'; });
    map.on('mouseleave', 'cells', () => { map.getCanvas().style.cursor = ''; });
    addTrailLayers();
    setVisibility();
    draw();
  });

  (async () => {
    try {
      const [index, g, w, f, finds, t] = await Promise.all([
        getJson<ModelIndex>('model/index.json'), getJson<Grid>('cells.json'),
        getJson<CurrentWeather>('weather/current.json').catch(() => null),
        getJson<Forecast>('weather/forecast.json').catch(() => null),
        listFinds(uid).catch(() => []),
        getJson<TrailData>('trails/trails.json').catch(() => null),
      ]);
      current = w;
      if (!index || !g || !index.models.length) {
        status.textContent = 'The heat map data has not been generated yet. It appears after the first weekly data run.';
        return;
      }
      grid = g;
      cellIndex = new Map(g.cells.map((c, i) => [c, i]));
      if (f?.weeks.length) forecast = { data: f, pointIndex: forecastPointIndex(g, f) };
      findCells = finds
        .filter((x) => x.speciesId && x.lat !== null && x.lon !== null)
        .map((x) => ({ speciesId: x.speciesId!, cell: latLngToCell(x.lat!, x.lon!, g.res) }));
      centres = cellCentres(g);
      likely.setData({
        grid: g, cellIndex, centres, current, forecast, ownFor,
        models: index.models.filter((m) => m.kind === 'group'),
        loadModel: fetchModel,
      });
      if (t) {
        trailData = t;
        addTrailLayers();
        setVisibility();
      } else {
        showTrails.disabled = true;
        resultsNote.textContent = 'The trail data has not been generated yet. It appears after the next weekly data run.';
      }
      fillModelSelect(select, catalog, index);
      status.textContent = `Data updated ${new Date(index.generatedAt).toLocaleDateString()}.` +
        (t ? ` ${t.trails.length.toLocaleString()} trails appear as you zoom in, coloured by accessibility.` : '');
      await loadModel(select.value);
    } catch (e) {
      status.textContent = `Could not load the heat map: ${e instanceof Error ? e.message : e}`;
    }
  })();

  select.addEventListener('change', () => loadModel(select.value));
  week.addEventListener('input', draw);
  showHeat.addEventListener('change', setVisibility);
  showTrails.addEventListener('change', setVisibility);
  baseSelect.addEventListener('change', () => {
    if (styleReady) setBaseMap(map, baseSelect.value as BaseMap);
    try { localStorage.setItem('mushmap.baseMap', baseSelect.value); } catch { /* not remembered */ }
  });
  searchView.addEventListener('click', () => {
    const b = viewBounds();
    likely.setPlace({ kind: 'area', label: 'The searched map view', bounds: b });
    search(b);
  });
  drawArea.addEventListener('click', startDrawing);
  requestAnimationFrame(() => map.resize());

  return h('section', {},
    h('div', { class: 'card' },
      h('h1', {}, 'Foraging map'),
      h('label', { class: 'field' }, h('span', {}, 'Species or group'), select),
      h('div', { class: 'field' }, h('span', {}, 'Outlook for the region'), outlookEl),
      h('label', { class: 'field' }, h('span', {}, 'Week'), weekText, week),
      h('label', { class: 'field' }, h('span', {}, 'Base map'), baseSelect),
      h('div', { class: 'row layer-toggles' },
        h('label', { class: 'inline' }, showHeat, 'Heat map'),
        h('label', { class: 'inline' }, showTrails, 'Trails')),
      h('div', { class: 'row' }, searchView, drawArea),
      status,
      legalSlot),
    mapEl,
    likely.el,
    h('div', { class: 'card' },
      h('h2', {}, 'Best trails'),
      resultsNote,
      results),
    h('div', { class: 'card' },
      h('h2', {}, 'Most likely spots this week'),
      h('p', { class: 'muted' }, 'The highest-scoring places on the map, a few kilometres apart. Tap one to zoom to it.'),
      spotsEl),
    h('div', { class: 'card legend' },
      h('div', { class: 'ramp' }),
      h('div', { class: 'row between' }, h('small', {}, 'Lower'), h('small', {}, 'Higher relative likelihood')),
      h('p', { class: 'muted' },
        'Each cell is scored from the weeks and elevations where research-grade iNaturalist sightings ' +
        'in Washington and Oregon were made, how close past sightings are, and how much of the ' +
        'mushroom\'s host trees grow there (USDA Forest Service tree maps). For the coming weeks it also ' +
        'compares the 14 days of rain and 7 days of temperature before each week, from NOAA weather ' +
        'stations and the Open-Meteo 16-day forecast, with the weather before past finds at the same time ' +
        'of year. Your own logged finds count as past sightings on your map only. ' +
        'Many areas are private land or closed to harvest; check before you forage.'),
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
