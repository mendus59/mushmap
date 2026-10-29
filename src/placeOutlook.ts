/** Which tracked mushrooms are likely in one area or along one trail on one date. */

import { cellScorer, type CellScore, type CurrentWeather, type Grid, type Model } from './heatmapModel';
import type { Bounds } from './trailsModel';

/** Below this a mushroom counts as very unlikely and is left off the list. */
export const MIN_LIKELIHOOD = 0.1;

/** Recent weather and the forecast only say something about the days just behind and ahead. */
export const WEATHER_DAYS_BEFORE = 7;
export const WEATHER_DAYS_AFTER = 21;

export interface PlaceLikelihood {
  /** 0..1, mostly the best cell and partly how good the place is throughout, as for trails. */
  likelihood: number;
  /** The best-scoring cell, or null when nothing there is in season. */
  best: CellScore | null;
}

export interface RankedMushroom {
  id: string;
  label: string;
  likelihood: number;
  best: CellScore | null;
}

/** The grid cells whose centres fall in an area. */
export function cellsInBounds(centres: [number, number][], area: Bounds): number[] {
  const out: number[] = [];
  centres.forEach(([lat, lng], i) => {
    if (lat >= area.south && lat <= area.north && lng >= area.west && lng <= area.east) out.push(i);
  });
  return out;
}

/**
 * How likely a mushroom is across some cells for one week. Weighted like trailLikelihood: 60% the best
 * cell and 40% the average, so one excellent patch counts and a big place is not rewarded for size.
 */
export function placeLikelihood(
  grid: Grid, model: Model, cells: number[], week: number,
  weather: CurrentWeather | null = null, own: Map<number, number> | null = null,
): PlaceLikelihood {
  const score = cellScorer(grid, model, week, weather, own);
  let best: CellScore | null = null;
  let sum = 0;
  for (const i of cells) {
    const s = score(i);
    if (!s) continue;
    sum += s.score;
    if (!best || s.score > best.score) best = s;
  }
  if (!best || !cells.length) return { likelihood: 0, best: null };
  return { likelihood: 0.6 * best.score + 0.4 * (sum / cells.length), best };
}

/** Most likely first, with the very unlikely ones split off. */
export function rankMushrooms(
  items: RankedMushroom[], minLikelihood = MIN_LIKELIHOOD,
): { shown: RankedMushroom[]; hidden: RankedMushroom[] } {
  const sorted = [...items].sort((a, b) => b.likelihood - a.likelihood);
  return {
    shown: sorted.filter((m) => m.likelihood >= minLikelihood),
    hidden: sorted.filter((m) => m.likelihood < minLikelihood),
  };
}

export function likelihoodLabel(x: number): string {
  if (x >= 0.6) return 'Very likely';
  if (x >= 0.35) return 'Likely';
  if (x >= 0.2) return 'Possible';
  if (x >= MIN_LIKELIHOOD) return 'Unlikely';
  return 'Very unlikely';
}

/** A short reason for the score, from the best cell. */
export function likelihoodReasons(s: CellScore | null): string {
  if (!s) return '';
  return [
    s.season >= 0.6 ? 'in season' : s.season < 0.25 ? 'edge of its season' : null,
    s.history >= 0.5 ? (s.own ? 'your finds nearby' : 'past sightings nearby') : null,
    s.host !== null && s.host >= 0.5 ? 'host trees' : null,
    s.weather !== null && s.weather >= 1.2 ? 'good weather' : null,
    s.weather !== null && s.weather <= 0.8 ? 'poor weather' : null,
  ].filter(Boolean).join(', ');
}

/** The local calendar date as YYYY-MM-DD, the format of a date input. */
export function localIsoDate(d: Date): string {
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

/** A YYYY-MM-DD date as local midday, or null when it is not a date. */
export function parseLocalDate(value: string): Date | null {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value);
  if (!m) return null;
  const d = new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3]), 12);
  return Number.isNaN(d.getTime()) ? null : d;
}

/** Whole days from `today` to `date` (negative in the past), by local calendar date. */
export function daysBetween(today: Date, date: Date): number {
  const a = Date.UTC(today.getFullYear(), today.getMonth(), today.getDate());
  const b = Date.UTC(date.getFullYear(), date.getMonth(), date.getDate());
  return Math.round((b - a) / 86_400_000);
}

/** Whether the latest weather and forecast can speak to a date. */
export function weatherCovers(today: Date, date: Date): boolean {
  const d = daysBetween(today, date);
  return d >= -WEATHER_DAYS_BEFORE && d <= WEATHER_DAYS_AFTER;
}
