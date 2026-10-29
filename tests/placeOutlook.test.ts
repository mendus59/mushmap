import { describe, expect, it } from 'vitest';
import type { Grid, Model } from '../src/heatmapModel';
import {
  cellsInBounds, daysBetween, likelihoodLabel, localIsoDate, parseLocalDate, placeLikelihood, rankMushrooms,
  weatherCovers,
} from '../src/placeOutlook';

const grid: Grid = { res: 7, states: ['Test'], cells: ['a', 'b', 'c', 'd'], elev: [100, 1000, 100, null] };

function model(): Model {
  const seasonElev = Array.from({ length: 53 }, () => Array(89).fill(0));
  seasonElev[17][2] = 100; // week 18, ~100 m
  seasonElev[17][20] = 50; // week 18, ~1000 m
  return { id: 'm', count: 3, elevBinM: 50, historyFloor: 0.25, seasonElev, historyIdx: [0], historyVal: [100] };
}

describe('placeLikelihood', () => {
  it('weights the best cell over the average, like trails', () => {
    const { likelihood, best } = placeLikelihood(grid, model(), [0, 2], 18);
    expect(best?.index).toBe(0);
    expect(likelihood).toBeCloseTo(0.6 * 1 + 0.4 * (1.25 / 2));
  });

  it('counts out-of-season and unknown cells as zero in the average', () => {
    expect(placeLikelihood(grid, model(), [2, 3], 18).likelihood).toBeCloseTo(0.6 * 0.25 + 0.4 * 0.125);
  });

  it('is zero out of season or with no cells', () => {
    expect(placeLikelihood(grid, model(), [0, 1, 2], 30)).toEqual({ likelihood: 0, best: null });
    expect(placeLikelihood(grid, model(), [], 18)).toEqual({ likelihood: 0, best: null });
  });

  it('counts the user\'s own finds', () => {
    const own = new Map([[2, 1]]);
    const { likelihood, best } = placeLikelihood(grid, model(), [2], 18, null, own);
    expect(likelihood).toBeCloseTo(1);
    expect(best?.own).toBe(true);
  });
});

describe('rankMushrooms', () => {
  it('sorts by likelihood and hides the very unlikely', () => {
    const m = (id: string, likelihood: number) => ({ id, label: id, likelihood, best: null });
    const { shown, hidden } = rankMushrooms([m('a', 0.2), m('b', 0.05), m('c', 0.7), m('d', 0)]);
    expect(shown.map((x) => x.id)).toEqual(['c', 'a']);
    expect(hidden.map((x) => x.id)).toEqual(['b', 'd']);
  });

  it('labels likelihoods', () => {
    expect(likelihoodLabel(0.8)).toBe('Very likely');
    expect(likelihoodLabel(0.4)).toBe('Likely');
    expect(likelihoodLabel(0.25)).toBe('Possible');
    expect(likelihoodLabel(0.12)).toBe('Unlikely');
    expect(likelihoodLabel(0.02)).toBe('Very unlikely');
  });
});

describe('places and dates', () => {
  it('finds cells whose centres are in an area', () => {
    const centres: [number, number][] = [[46, -121], [47.5, -121], [46.2, -120.5]];
    expect(cellsInBounds(centres, { west: -122, south: 45, east: -120, north: 47 })).toEqual([0, 2]);
  });

  it('uses the local calendar date', () => {
    expect(localIsoDate(new Date(2026, 9, 29, 23, 30))).toBe('2026-10-29');
    expect(localIsoDate(new Date(2026, 0, 5, 0, 5))).toBe('2026-01-05');
    const d = parseLocalDate('2026-03-01')!;
    expect([d.getFullYear(), d.getMonth(), d.getDate()]).toEqual([2026, 2, 1]);
    expect(parseLocalDate('')).toBeNull();
  });

  it('only uses weather close to today', () => {
    const today = new Date(2026, 9, 29, 8);
    expect(daysBetween(today, new Date(2026, 10, 1, 20))).toBe(3);
    expect(weatherCovers(today, new Date(2026, 9, 29))).toBe(true);
    expect(weatherCovers(today, new Date(2026, 10, 15))).toBe(true);
    expect(weatherCovers(today, new Date(2026, 11, 25))).toBe(false);
    expect(weatherCovers(today, new Date(2025, 9, 29))).toBe(false);
  });
});
