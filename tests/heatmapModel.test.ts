import { describe, expect, it } from 'vitest';
import {
  isoWeek, scoreCells, weatherApplies, weatherLift, weekStart,
  type CurrentWeather, type Grid, type Model, type WeatherModel,
} from '../src/heatmapModel';

const grid: Grid = { res: 7, states: ['Test'], cells: ['a', 'b', 'c', 'd'], elev: [100, 1000, 100, null] };

function model(): Model {
  const seasonElev = Array.from({ length: 53 }, () => Array(89).fill(0));
  seasonElev[17][2] = 100; // week 18, ~100 m
  seasonElev[17][20] = 50; // week 18, ~1000 m
  return { id: 'm', count: 3, elevBinM: 50, historyFloor: 0.25, seasonElev, historyIdx: [0], historyVal: [100] };
}

describe('scoreCells', () => {
  it('combines season-elevation with past sightings', () => {
    const scores = scoreCells(grid, model(), 18, 0);
    const byIndex = new Map(scores.map((s) => [s.index, s]));
    expect(byIndex.get(0)?.score).toBeCloseTo(1);      // right season and elevation, known spot
    expect(byIndex.get(2)?.score).toBeCloseTo(0.25);   // right season and elevation, no history
    expect(byIndex.get(1)?.score).toBeCloseTo(0.125);  // half as likely at 1000 m, no history
    expect(byIndex.has(3)).toBe(false);                // no elevation known
  });

  it('gates by host trees when the model has them', () => {
    const m = { ...model(), hostFloor: 0.2, hostIdx: [2], hostVal: [50] };
    const byIndex = new Map(scoreCells(grid, m, 18, 0).map((s) => [s.index, s]));
    expect(byIndex.get(0)?.score).toBeCloseTo(0.2);    // known spot, no host trees
    expect(byIndex.get(2)?.score).toBeCloseTo(0.15);   // 0.25 history floor × (0.2 + 0.8 × 0.5)
    expect(byIndex.get(2)?.host).toBe(0.5);
    expect(scoreCells(grid, model(), 18, 0)[0].host).toBeNull();
  });

  it('drops cells below the threshold and out-of-season weeks', () => {
    expect(scoreCells(grid, model(), 18, 0.2).map((s) => s.index)).toEqual([0, 2]);
    expect(scoreCells(grid, model(), 30)).toEqual([]);
  });
});

describe('weather', () => {
  const table = Array.from({ length: 25 }, () => Array(46).fill(100));
  table[16][20] = 200; // ~54 mm, 10 °C: twice as common before finds
  table[0][30] = 40; // dry and 20 °C
  const wm: WeatherModel = { min: 0.25, max: 1.5, pStep: 0.25, tMin: -10, count: 100, table };

  it('looks up the lift for recent conditions and clamps it', () => {
    expect(weatherLift(wm, 54, 10.2)).toBe(1.5);
    expect(weatherLift(wm, 0, 20)).toBeCloseTo(0.4);
    expect(weatherLift(wm, 5, 0)).toBe(1);
    expect(weatherLift(wm, null, 10)).toBeNull();
  });

  it('applies to the measured week and the next two, across the new year', () => {
    const current: CurrentWeather = { asOf: '2026-10-25', pDays: 14, tDays: 7, p14: [], t7: [] };
    expect([42, 43, 44, 45, 46].map((w) => weatherApplies(current, w))).toEqual([false, true, true, true, false]);
    expect(weatherApplies({ ...current, asOf: '2026-12-28' }, 1)).toBe(true);
    expect(weatherApplies(null, 44)).toBe(false);
  });

  it('multiplies scores and caps them at 1', () => {
    const m = { ...model(), weather: wm };
    const current: CurrentWeather = { asOf: '2026-04-30', pDays: 14, tDays: 7, p14: [54, null, 0, 5], t7: [10, 5, 20, 0] };
    const byIndex = new Map(scoreCells(grid, m, 18, 0, current).map((s) => [s.index, s]));
    expect(byIndex.get(0)?.score).toBe(1);             // 1 × 1.5, capped
    expect(byIndex.get(0)?.weather).toBe(1.5);
    expect(byIndex.get(1)?.weather).toBeNull();         // no data: unchanged
    expect(byIndex.get(1)?.score).toBeCloseTo(0.125);
    expect(byIndex.get(2)?.score).toBeCloseTo(0.1);    // 0.25 × 0.4
    expect(scoreCells(grid, m, 18, 0)[0].weather).toBeNull();
  });
});

describe('weeks', () => {
  it('matches ISO week numbers', () => {
    expect(isoWeek(new Date(2026, 9, 28))).toBe(44);
    expect(isoWeek(new Date(2026, 0, 1))).toBe(1);
    expect(isoWeek(new Date(2027, 0, 1))).toBe(53);
  });

  it('finds the Monday a week starts on', () => {
    expect(weekStart(2026, 44).toISOString().slice(0, 10)).toBe('2026-10-26');
    expect(weekStart(2026, 1).toISOString().slice(0, 10)).toBe('2025-12-29');
  });
});
