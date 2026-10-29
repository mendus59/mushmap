import { cellToLatLng, latLngToCell } from 'h3-js';
import { h, clear } from '../dom';
import {
  isoWeek, weatherForWeek, type CurrentWeather, type Forecast, type Grid, type Model, type ModelEntry,
} from '../heatmapModel';
import { SAFETY_NOTE } from '../legal';
import {
  cellsInBounds, likelihoodLabel, likelihoodReasons, localIsoDate, parseLocalDate, placeLikelihood, rankMushrooms,
  weatherCovers, type RankedMushroom,
} from '../placeOutlook';
import type { Catalog } from '../species';
import type { Bounds } from '../trailsModel';

export type Place =
  | { kind: 'view'; label: string }
  | { kind: 'area'; label: string; bounds: Bounds }
  | { kind: 'trail'; label: string; cells: number[] };

/** The map page's loaded data that the panel scores with. */
export interface PlaceData {
  grid: Grid;
  cellIndex: Map<string, number>;
  centres: [number, number][];
  current: CurrentWeather | null;
  forecast: { data: Forecast; pointIndex: Int32Array } | null;
  /** Every mushroom to rank: one model per catalog group. */
  models: ModelEntry[];
  loadModel: (id: string) => Promise<Model | null>;
  /** History from the user's own finds for a model. */
  ownFor: (id: string) => Map<number, number> | null;
}

export interface LikelyHerePanel {
  el: HTMLElement;
  setData: (data: PlaceData) => void;
  setPlace: (place: Place) => void;
  /** Score the current place now, and keep it up to date as the place or date changes. */
  run: () => void;
}

function pct(x: number): string {
  return `${Math.round(x * 100)}%`;
}

/**
 * Pick an area or a trail and a date, and see the tracked mushrooms ranked by how likely they are
 * there, leaving off the very unlikely ones.
 */
export function likelyHerePanel(
  catalog: Catalog,
  opts: { mapViewBounds: () => Bounds; onShow: (id: string) => void },
): LikelyHerePanel {
  const today = localIsoDate(new Date());
  const date = h('input', { type: 'date', value: today, 'aria-label': 'Date' });
  const todayBtn = h('button', { type: 'button', class: 'text-link' }, 'Today');
  const placeText = h('strong', {}, 'The map view');
  const useView = h('button', { type: 'button' }, 'Use the map view');
  const check = h('button', { type: 'button', class: 'primary', disabled: true }, 'Show likely mushrooms');
  const note = h('p', { class: 'muted' },
    'Pick a place: tap a trail, draw an area, or use the map view. Then pick a date.');
  const list = h('ol', { class: 'likely-list' });
  const hiddenNote = h('p', { class: 'muted' });

  let data: PlaceData | null = null;
  let place: Place | null = null;
  let active = false;
  let runId = 0;

  const placeCells = (p: Place, d: PlaceData): number[] => {
    if (p.kind === 'trail') return p.cells;
    // The map view is read when scoring, so it follows the map as it moves.
    const b = p.kind === 'view' ? opts.mapViewBounds() : p.bounds;
    const cells = cellsInBounds(d.centres, b);
    if (cells.length) return cells;
    // An area smaller than one cell: use the cell it sits in.
    const lat = (b.north + b.south) / 2;
    const lng = (b.east + b.west) / 2;
    const i = d.cellIndex.get(latLngToCell(lat, lng, d.grid.res));
    return i === undefined ? [] : [i];
  };

  const render = async () => {
    if (!data || !place) return;
    const id = ++runId;
    const d = data;
    const p = place;
    const day = parseLocalDate(date.value) ?? parseLocalDate(today)!;
    const week = isoWeek(day);
    const cells = placeCells(p, d);
    const when = day.toLocaleDateString(undefined, { weekday: 'short', month: 'short', day: 'numeric', year: 'numeric' });
    if (!cells.length) {
      clear(list);
      hiddenNote.textContent = '';
      note.textContent = 'That place is outside the area MushMap covers (Washington and Oregon).';
      return;
    }
    note.textContent = 'Loading the mushroom models…';
    const weather = weatherCovers(new Date(), day) ? weatherForWeek(d.grid, week, d.current, d.forecast) : null;
    const items: RankedMushroom[] = [];
    for (const entry of d.models) {
      const model = await d.loadModel(entry.id).catch(() => null);
      if (id !== runId) return; // the place or date changed meanwhile
      if (!model) continue;
      const { likelihood, best } = placeLikelihood(d.grid, model, cells, week, weather, d.ownFor(entry.id));
      items.push({ id: entry.id, label: entry.label, likelihood, best });
    }
    const { shown, hidden } = rankMushrooms(items);
    clear(list);
    for (const m of shown) {
      const group = catalog.groups.find((g) => g.id === m.id);
      const why = likelihoodReasons(m.best);
      list.append(h('li', {},
        h('div', { class: 'likely' },
          h('span', { class: 'row between' },
            h('strong', {}, m.label),
            h('span', { class: 'likely-score' }, `${pct(m.likelihood)} · ${likelihoodLabel(m.likelihood)}`)),
          h('span', { class: 'likely-bar' }, h('span', { style: `width:${Math.max(3, Math.round(m.likelihood * 100))}%` })),
          why ? h('small', { class: 'muted' }, why) : null,
          group?.legalNote ? h('small', { class: 'muted' }, 'Illegal to possess in Washington and Oregon; tracked for study only.') : null,
          h('button', { type: 'button', class: 'text-link', onclick: () => opts.onShow(m.id) }, 'Show on the map'))));
    }
    const weatherWords = weather
      ? weather.forecastFor ? ' Includes the weather forecast.' : ' Includes recent weather.'
      : ' Season, place and host trees only: weather is only known for the next few weeks.';
    note.textContent = shown.length
      ? `${p.label}, ${when}.${weatherWords}`
      : `${p.label}, ${when}: none of the tracked mushrooms are more than very unlikely here.${weatherWords}`;
    hiddenNote.textContent = hidden.length
      ? `Not shown as very unlikely: ${hidden.map((m) => m.label).join(', ')}.`
      : '';
  };

  const update = () => {
    placeText.textContent = place?.label ?? 'No place picked';
    check.disabled = !data || !place;
    if (active) void render();
  };

  date.addEventListener('change', update);
  todayBtn.addEventListener('click', () => { date.value = localIsoDate(new Date()); update(); });
  useView.addEventListener('click', () => {
    place = { kind: 'view', label: 'The map view' };
    active = true;
    update();
  });
  const run = () => {
    active = true;
    update();
  };
  check.addEventListener('click', run);

  const el = h('div', { class: 'card' },
    h('h2', {}, 'What\'s likely here'),
    h('div', { class: 'field' }, h('span', {}, 'Place'), h('div', { class: 'row likely-place' }, placeText, useView)),
    h('label', { class: 'field' }, h('span', {}, 'Date'), h('div', { class: 'row likely-date' }, date, todayBtn)),
    h('div', { class: 'row' }, check),
    note,
    list,
    hiddenNote,
    h('p', { class: 'note' }, SAFETY_NOTE));

  return {
    el,
    setData: (d) => {
      data = d;
      if (!place) place = { kind: 'view', label: 'The map view' };
      update();
    },
    setPlace: (p) => {
      place = p;
      update();
    },
    run,
  };
}

/** The centre of every grid cell as [lat, lng]. */
export function cellCentres(grid: Grid): [number, number][] {
  return grid.cells.map((c) => cellToLatLng(c) as [number, number]);
}
