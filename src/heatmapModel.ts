/** Mirrors pipeline/model.py: how the browser turns a model into a score per cell for one week. */

import { cellToParent, gridDisk } from 'h3-js';

export interface Grid {
  res: number;
  states: string[];
  cells: string[];
  elev: (number | null)[];
}

export interface Model {
  id: string;
  count: number;
  elevBinM: number;
  historyFloor: number;
  /** [week 1..53 at index 0..52][elevation bin] → 0..100 */
  seasonElev: number[][];
  historyIdx: number[];
  historyVal: number[];
  /** Host-tree gate; absent when the species is not tied to trees. */
  hostFloor?: number;
  hostIdx?: number[];
  hostVal?: number[];
  weather?: WeatherModel;
}

/** How much more often finds follow given recent weather than usual (pipeline/weather.py). */
export interface WeatherModel {
  /** Lift is held between min and max before it multiplies the score. */
  min: number;
  max: number;
  /** Precipitation bins are log(1 + mm) / pStep; temperature bins are whole °C from tMin. */
  pStep: number;
  tMin: number;
  count: number;
  /** [precipitation bin][temperature bin] → lift in percent (100 = usual). */
  table: number[][];
}

/** Recent weather per grid cell, aligned with Grid.cells. */
export interface CurrentWeather {
  asOf: string;
  pDays: number;
  tDays: number;
  p14: (number | null)[];
  t7: (number | null)[];
  /** Set when the values are forecast for a later day (forecastWeather) rather than measured. */
  forecastFor?: string;
}

/** Observed and forecast weather for the coming weeks at coarse points (pipeline/forecast.py). */
export interface Forecast {
  asOf: string;
  source: string;
  /** H3 resolution of the points; each grid cell takes its parent point's values. */
  res: number;
  pDays: number;
  tDays: number;
  points: string[];
  elev: (number | null)[];
  weeks: ForecastWeek[];
}

export interface ForecastWeek {
  week: number;
  /** The day the conditions are measured up to (the Thursday of the week). */
  date: string;
  pKnown: number;
  tKnown: number;
  p14: (number | null)[];
  t7: (number | null)[];
}

const LAPSE_C_PER_M = 0.0065;

/** Recent weather speaks to fruiting over the next couple of weeks, so it applies to those weeks only. */
export const WEATHER_WEEKS_AHEAD = 2;

export interface ModelEntry {
  id: string;
  kind: 'group' | 'species';
  groupId: string;
  label: string;
  count: number;
}

export interface ModelIndex {
  generatedAt: string;
  region: string[];
  models: ModelEntry[];
}

export interface CellScore {
  index: number;
  score: number;
  season: number;
  history: number;
  /** True when one of the user's own finds is in or next to the cell. */
  own: boolean;
  /** 0..1 host-tree score, or null when the model has no host gate. */
  host: number | null;
  /** Weather multiplier (1 = usual), or null when weather does not apply. */
  weather: number | null;
}

export const MIN_SCORE = 0.08;

export function isoWeek(d: Date): number {
  const t = new Date(Date.UTC(d.getFullYear(), d.getMonth(), d.getDate()));
  const day = t.getUTCDay() || 7;
  t.setUTCDate(t.getUTCDate() + 4 - day);
  const yearStart = Date.UTC(t.getUTCFullYear(), 0, 1);
  return Math.ceil(((t.getTime() - yearStart) / 86_400_000 + 1) / 7);
}

/** Monday of ISO week `week` in `year`. */
export function weekStart(year: number, week: number): Date {
  const jan4 = new Date(Date.UTC(year, 0, 4));
  const monday = new Date(jan4);
  monday.setUTCDate(jan4.getUTCDate() - ((jan4.getUTCDay() || 7) - 1) + (week - 1) * 7);
  return monday;
}

/** Whether recent weather (measured up to asOf) applies to this week of the year. */
export function weatherApplies(current: CurrentWeather | null | undefined, week: number): boolean {
  if (!current) return false;
  const from = isoWeek(new Date(`${current.asOf}T12:00:00`));
  return (week - from + 53) % 53 <= WEATHER_WEEKS_AHEAD;
}

export function weatherLift(w: WeatherModel, p14: number | null | undefined, t7: number | null | undefined): number | null {
  if (p14 === null || p14 === undefined || t7 === null || t7 === undefined) return null;
  const pBins = w.table.length;
  const tBins = w.table[0]?.length ?? 0;
  const pb = Math.max(0, Math.min(pBins - 1, Math.round(Math.log1p(Math.max(p14, 0)) / w.pStep)));
  const tb = Math.max(0, Math.min(tBins - 1, Math.round(t7) - w.tMin));
  const lift = (w.table[pb]?.[tb] ?? 100) / 100;
  return Math.max(w.min, Math.min(w.max, lift));
}

/** For each grid cell, the index of its forecast point (-1 when none). */
export function forecastPointIndex(grid: Grid, forecast: Forecast): Int32Array {
  const byCell = new Map(forecast.points.map((p, i) => [p, i]));
  const out = new Int32Array(grid.cells.length).fill(-1);
  grid.cells.forEach((c, i) => { out[i] = byCell.get(cellToParent(c, forecast.res)) ?? -1; });
  return out;
}

/** The forecast for one week as per-cell weather, with temperature moved to each cell's elevation. */
export function forecastWeather(grid: Grid, forecast: Forecast, pointIndex: Int32Array, week: number): CurrentWeather | null {
  const w = forecast.weeks.find((x) => x.week === week);
  if (!w) return null;
  const p14: (number | null)[] = new Array(grid.cells.length).fill(null);
  const t7: (number | null)[] = new Array(grid.cells.length).fill(null);
  for (let i = 0; i < grid.cells.length; i++) {
    const p = pointIndex[i];
    if (p < 0) continue;
    p14[i] = w.p14[p];
    const t = w.t7[p];
    const from = forecast.elev[p];
    const to = grid.elev[i];
    t7[i] = t === null ? null
      : from === null || to === null ? t : Math.round((t + (from - to) * LAPSE_C_PER_M) * 10) / 10;
  }
  return { asOf: forecast.asOf, pDays: forecast.pDays, tDays: forecast.tDays, p14, t7, forecastFor: w.date };
}

/**
 * The weather to score a week with: the forecast when it reaches that week, otherwise the latest
 * station weather for this week and the next two, otherwise none (season and place only).
 */
export function weatherForWeek(
  grid: Grid, week: number, current: CurrentWeather | null,
  forecast: { data: Forecast; pointIndex: Int32Array } | null,
): CurrentWeather | null {
  const f = forecast ? forecastWeather(grid, forecast.data, forecast.pointIndex, week) : null;
  if (f) return f;
  return weatherApplies(current, week) ? current : null;
}

/** History for cells holding the user's own finds (1) and the cells around them (0.6). */
export function ownFindHistory(grid: Grid, cellIndex: Map<string, number>, findCells: string[]): Map<number, number> {
  const out = new Map<number, number>();
  for (const cell of findCells) {
    for (const c of gridDisk(cell, 1)) {
      const i = cellIndex.get(c);
      if (i === undefined) continue;
      const v = c === cell ? 1 : 0.6;
      if ((out.get(i) ?? 0) < v) out.set(i, v);
    }
  }
  return out;
}

/**
 * The best-scoring cells, at least `spacing` cells apart, so the list names distinct places
 * rather than a cluster of neighbours.
 */
export function topSpots(grid: Grid, scores: CellScore[], count = 8, spacing = 3): CellScore[] {
  const taken = new Set<string>();
  const out: CellScore[] = [];
  for (const s of [...scores].sort((a, b) => b.score - a.score)) {
    const cell = grid.cells[s.index];
    if (taken.has(cell)) continue;
    out.push(s);
    for (const c of gridDisk(cell, spacing)) taken.add(c);
    if (out.length >= count) break;
  }
  return out;
}

/** One number for how good a week looks across the whole region: the sum of cell scores. */
export function regionTotal(scores: CellScore[]): number {
  return scores.reduce((sum, s) => sum + s.score, 0);
}

/** Pass `current` from weatherForWeek(). `own` raises history where the user has logged finds. */
export function scoreCells(
  grid: Grid, model: Model, week: number, minScore = MIN_SCORE, current: CurrentWeather | null = null,
  own: Map<number, number> | null = null,
): CellScore[] {
  const row = model.seasonElev[week - 1] ?? [];
  const bins = row.length;
  const history = new Map<number, number>();
  model.historyIdx.forEach((idx, i) => history.set(idx, model.historyVal[i] / 100));
  const floor = model.historyFloor;
  const hasHost = model.hostFloor !== undefined && model.hostIdx !== undefined && model.hostVal !== undefined;
  const hostFloor = model.hostFloor ?? 1;
  const host = new Map<number, number>();
  if (hasHost) model.hostIdx!.forEach((idx, i) => host.set(idx, model.hostVal![i] / 100));
  const out: CellScore[] = [];
  for (let i = 0; i < grid.cells.length; i++) {
    const elev = grid.elev[i];
    if (elev === null || elev === undefined) continue;
    const bin = Math.max(0, Math.min(bins - 1, Math.round(elev / model.elevBinM)));
    const season = (row[bin] ?? 0) / 100;
    if (season === 0) continue;
    const o = own?.get(i) ?? 0;
    const h = Math.max(history.get(i) ?? 0, o);
    const t = hasHost ? host.get(i) ?? 0 : null;
    const w = current && model.weather ? weatherLift(model.weather, current.p14[i], current.t7[i]) : null;
    const score = Math.min(1,
      season * (floor + (1 - floor) * h) * (t === null ? 1 : hostFloor + (1 - hostFloor) * t) * (w ?? 1));
    if (score >= minScore) out.push({ index: i, score, season, history: h, own: o > 0, host: t, weather: w });
  }
  return out;
}
