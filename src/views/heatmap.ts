import { cellToBoundary, cellToLatLng, latLngToCell } from 'h3-js';
import type { GeoJSONSource, Map as MapLibreMap } from 'maplibre-gl';
import { h, clear } from '../dom';
import { listFinds } from '../finds';
import {
  forecastPointIndex, isoWeek, ownFindHistory, regionTotal, scoreCells, topSpots, weatherForWeek, weekStart,
  type CellScore, type CurrentWeather, type Forecast, type Grid, type Model, type ModelIndex,
} from '../heatmapModel';
import { SAFETY_NOTE, legalNoteEl } from '../legal';
import { createMap, maplibregl } from '../map';
import { expandSpeciesId, type Catalog } from '../species';

const DATA = `${import.meta.env.BASE_URL}data/generated`;

async function getJson<T>(path: string): Promise<T | null> {
  const r = await fetch(`${DATA}/${path}`);
  if (r.status === 404) return null;
  if (!r.ok) throw new Error(`Could not load ${path} (${r.status})`);
  return r.json() as Promise<T>;
}

function weekLabel(week: number): string {
  const year = new Date().getFullYear();
  const start = weekStart(year, week);
  const end = new Date(start);
  end.setUTCDate(start.getUTCDate() + 6);
  const fmt = (d: Date) => d.toLocaleDateString(undefined, { month: 'short', day: 'numeric', timeZone: 'UTC' });
  return `Week ${week}: ${fmt(start)} to ${fmt(end)}`;
}

function shortDate(iso: string): string {
  return new Date(`${iso}T12:00:00`).toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
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

export function heatmapView(catalog: Catalog, uid: string): HTMLElement {
  const status = h('p', { class: 'muted' }, 'Loading heat map data…');
  const outlookEl = h('div', { class: 'outlook' });
  const spotsEl = h('ol', { class: 'spots' });
  const select = h('select', { 'aria-label': 'Species or group' });
  const week = h('input', { type: 'range', min: 1, max: 53, value: isoWeek(new Date()), 'aria-label': 'Week of year' });
  const weekText = h('strong', {});
  const legalSlot = h('div');
  const mapEl = h('div', { class: 'map large' });
  const map: MapLibreMap = createMap(mapEl);

  let grid: Grid | null = null;
  let model: Model | null = null;
  let current: CurrentWeather | null = null;
  let forecast: { data: Forecast; pointIndex: Int32Array } | null = null;
  let weather: CurrentWeather | null = null;
  let cellIndex = new Map<string, number>();
  let findCells: { speciesId: string; cell: string }[] = [];
  let own: Map<number, number> | null = null;
  let scores: CellScore[] = [];
  const models = new Map<string, Promise<Model | null>>();
  const boundaries = new Map<number, [number, number][]>();

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
  };

  const loadModel = async (id: string) => {
    if (!models.has(id)) models.set(id, getJson<Model>(`model/${id}.json`));
    const m = await models.get(id)!;
    if (select.value !== id) return; // the user picked something else meanwhile
    model = m;
    const ids = expandSpeciesId(catalog, id);
    own = grid ? ownFindHistory(grid, cellIndex, findCells.filter((f) => ids.has(f.speciesId)).map((f) => f.cell)) : null;
    clear(legalSlot);
    const group = catalog.groups.find((g) => g.id === id || g.species.some((s) => s.id === id));
    if (group?.legalNote) legalSlot.append(legalNoteEl());
    drawOutlook();
    draw();
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
    map.addSource('cells', { type: 'geojson', data: { type: 'FeatureCollection', features: [] } });
    map.addLayer({
      id: 'cells',
      type: 'fill',
      source: 'cells',
      paint: {
        'fill-color': ['interpolate', ['linear'], ['get', 'score'],
          0.08, '#ffe9a8', 0.3, '#f6a03d', 0.6, '#d9542c', 1, '#8c1d18'],
        'fill-opacity': 0.65,
      },
    });
    map.on('click', 'cells', (e) => {
      const i = e.features?.[0]?.properties?.i;
      const s = typeof i === 'number' ? scores[i] : undefined;
      if (s) popupFor(s, e.lngLat);
    });
    map.on('mouseenter', 'cells', () => { map.getCanvas().style.cursor = 'pointer'; });
    map.on('mouseleave', 'cells', () => { map.getCanvas().style.cursor = ''; });
    draw();
  });

  (async () => {
    try {
      const [index, g, w, f, finds] = await Promise.all([
        getJson<ModelIndex>('model/index.json'), getJson<Grid>('cells.json'),
        getJson<CurrentWeather>('weather/current.json').catch(() => null),
        getJson<Forecast>('weather/forecast.json').catch(() => null),
        listFinds(uid).catch(() => []),
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
      for (const group of catalog.groups) {
        const entries = index.models.filter((m) => m.groupId === group.id);
        if (!entries.length) continue;
        select.append(h('optgroup', { label: group.name },
          ...entries.map((m) => h('option', { value: m.id },
            `${m.kind === 'group' ? `All ${group.name.toLowerCase()}` : m.label} (${m.count.toLocaleString()} sightings)`))));
      }
      status.textContent = `Data updated ${new Date(index.generatedAt).toLocaleDateString()}.`;
      await loadModel(select.value);
    } catch (e) {
      status.textContent = `Could not load the heat map: ${e instanceof Error ? e.message : e}`;
    }
  })();

  select.addEventListener('change', () => loadModel(select.value));
  week.addEventListener('input', draw);
  requestAnimationFrame(() => map.resize());

  return h('section', {},
    h('div', { class: 'card' },
      h('h1', {}, 'Foraging heat map'),
      h('label', { class: 'field' }, h('span', {}, 'Species or group'), select),
      h('div', { class: 'field' }, h('span', {}, 'Outlook for the region'), outlookEl),
      h('label', { class: 'field' }, h('span', {}, 'Week'), weekText, week),
      status,
      legalSlot),
    mapEl,
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
      h('p', { class: 'note' }, SAFETY_NOTE)),
  );
}
