import { cellToBoundary } from 'h3-js';
import type { GeoJSONSource, Map as MapLibreMap } from 'maplibre-gl';
import { h, clear } from '../dom';
import {
  isoWeek, scoreCells, weatherApplies, weekStart,
  type CellScore, type CurrentWeather, type Grid, type Model, type ModelIndex,
} from '../heatmapModel';
import { SAFETY_NOTE, legalNoteEl } from '../legal';
import { createMap, maplibregl } from '../map';
import type { Catalog } from '../species';

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

function weatherWords(lift: number): string {
  if (lift >= 1.2) return `better than usual for finds, ×${lift.toFixed(1)}`;
  if (lift <= 0.8) return `worse than usual for finds, ×${lift.toFixed(1)}`;
  return 'about usual for finds';
}

export function heatmapView(catalog: Catalog): HTMLElement {
  const status = h('p', { class: 'muted' }, 'Loading heat map data…');
  const select = h('select', { 'aria-label': 'Species or group' });
  const week = h('input', { type: 'range', min: 1, max: 53, value: isoWeek(new Date()), 'aria-label': 'Week of year' });
  const weekText = h('strong', {});
  const legalSlot = h('div');
  const mapEl = h('div', { class: 'map large' });
  const map: MapLibreMap = createMap(mapEl);

  let grid: Grid | null = null;
  let model: Model | null = null;
  let current: CurrentWeather | null = null;
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

  const draw = () => {
    weekText.textContent = weekLabel(Number(week.value));
    if (!grid || !model) return;
    const withWeather = weatherApplies(current, Number(week.value)) && !!model.weather;
    scores = scoreCells(grid, model, Number(week.value), undefined, withWeather ? current : null);
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
    const weatherNote = withWeather
      ? ` Includes weather up to ${shortDate(current!.asOf)}.`
      : current ? ' Weather only counts for the next few weeks.' : '';
    status.textContent = (scores.length
      ? `${scores.length.toLocaleString()} cells with some chance this week, from ${model.count.toLocaleString()} iNaturalist sightings.`
      : 'Out of season this week: no recorded sightings at this time of year.') + weatherNote;
  };

  const loadModel = async (id: string) => {
    if (!models.has(id)) models.set(id, getJson<Model>(`model/${id}.json`));
    const m = await models.get(id)!;
    if (select.value !== id) return; // the user picked something else meanwhile
    model = m;
    clear(legalSlot);
    const group = catalog.groups.find((g) => g.id === id || g.species.some((s) => s.id === id));
    if (group?.legalNote) legalSlot.append(legalNoteEl());
    draw();
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
      if (!s || !grid) return;
      new maplibregl.Popup()
        .setLngLat(e.lngLat)
        .setHTML(
          `<strong>${Math.round(s.score * 100)}% relative likelihood</strong><br>` +
          `Season and elevation fit: ${Math.round(s.season * 100)}%<br>` +
          `Past sightings nearby: ${Math.round(s.history * 100)}%<br>` +
          (s.host === null ? '' : `Host trees: ${Math.round(s.host * 100)}%<br>`) +
          (s.weather === null || !current ? '' :
            `Recent weather: ${current.p14[s.index]} mm rain in ${current.pDays} days, ` +
            `${current.t7[s.index]} °C average over ${current.tDays} (${weatherWords(s.weather)})<br>`) +
          `Elevation: ${grid.elev[s.index]} m`,
        )
        .addTo(map);
    });
    map.on('mouseenter', 'cells', () => { map.getCanvas().style.cursor = 'pointer'; });
    map.on('mouseleave', 'cells', () => { map.getCanvas().style.cursor = ''; });
    draw();
  });

  (async () => {
    try {
      const [index, g, w] = await Promise.all([
        getJson<ModelIndex>('model/index.json'), getJson<Grid>('cells.json'),
        getJson<CurrentWeather>('weather/current.json').catch(() => null),
      ]);
      current = w;
      if (!index || !g || !index.models.length) {
        status.textContent = 'The heat map data has not been generated yet. It appears after the first weekly data run.';
        return;
      }
      grid = g;
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
      h('label', { class: 'field' }, h('span', {}, 'Week'), weekText, week),
      status,
      legalSlot),
    mapEl,
    h('div', { class: 'card legend' },
      h('div', { class: 'ramp' }),
      h('div', { class: 'row between' }, h('small', {}, 'Lower'), h('small', {}, 'Higher relative likelihood')),
      h('p', { class: 'muted' },
        'Each cell is scored from the weeks and elevations where research-grade iNaturalist sightings ' +
        'in Washington and Oregon were made, how close past sightings are, and how much of the ' +
        'mushroom\'s host trees grow there (USDA Forest Service tree maps). For this week and the next two, ' +
        'it also compares the last 14 days of rain and 7 days of temperature (NOAA weather stations) with ' +
        'the weather before past finds at the same time of year. ' +
        'Many areas are private land or closed to harvest; check before you forage.'),
      h('p', { class: 'note' }, SAFETY_NOTE)),
  );
}
