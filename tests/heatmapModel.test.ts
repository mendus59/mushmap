import { cellToParent, gridDisk, latLngToCell } from 'h3-js';
import { describe, expect, it } from 'vitest';
import {
  forecastPointIndex, forecastWeather, isoWeek, ownFindHistory, scoreCells, topSpots, weatherApplies,
  weatherForWeek, weatherLift, weekStart,
  type CellScore, type CurrentWeather, type Forecast, type Grid, type Model, type WeatherModel,
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

describe('forecast', () => {
  const a = latLngToCell(47.6, -122.3, 7);
  const b = latLngToCell(45.5, -122.6, 7);
  const real: Grid = { res: 7, states: ['Test'], cells: [a, b], elev: [100, 1100] };
  const forecast: Forecast = {
    asOf: '2026-10-28', source: 'test', res: 4, pDays: 14, tDays: 7,
    points: [cellToParent(b, 4)], elev: [100],
    weeks: [{ week: 45, date: '2026-11-05', pKnown: 14, tKnown: 7, p14: [80], t7: [10] }],
  };
  const pointIndex = forecastPointIndex(real, forecast);

  it('maps cells to their forecast point and moves temperature to the cell elevation', () => {
    expect(Array.from(pointIndex)).toEqual([-1, 0]);
    const w = forecastWeather(real, forecast, pointIndex, 45)!;
    expect(w.p14).toEqual([null, 80]);
    expect(w.t7[1]).toBeCloseTo(3.5); // 1,000 m higher: 6.5 °C colder
    expect(w.forecastFor).toBe('2026-11-05');
    expect(forecastWeather(real, forecast, pointIndex, 46)).toBeNull();
  });

  it('prefers the forecast, then falls back to station weather near its week', () => {
    const current: CurrentWeather = { asOf: '2026-10-25', pDays: 14, tDays: 7, p14: [1, 2], t7: [3, 4] };
    const f = { data: forecast, pointIndex };
    expect(weatherForWeek(real, 45, current, f)?.forecastFor).toBe('2026-11-05');
    expect(weatherForWeek(real, 44, current, f)).toBe(current);
    expect(weatherForWeek(real, 50, current, f)).toBeNull();
  });
});

describe('own finds and top spots', () => {
  const centre = latLngToCell(46, -121, 7);
  const ring = gridDisk(centre, 4);
  const real: Grid = { res: 7, states: ['Test'], cells: ring, elev: ring.map(() => 100) };
  const index = new Map(ring.map((c, i) => [c, i]));

  it('raises history at and around the user\'s finds', () => {
    const own = ownFindHistory(real, index, [centre]);
    expect(own.get(index.get(centre)!)).toBe(1);
    expect(own.size).toBe(7);
    const m = model();
    const scores = scoreCells(real, { ...m, historyIdx: [], historyVal: [] }, 18, 0, null, own);
    const at = scores.find((s) => s.index === index.get(centre))!;
    expect(at.own).toBe(true);
    expect(at.score).toBeCloseTo(1);
  });

  it('picks the best cells that are apart from each other', () => {
    const scores: CellScore[] = ring.map((_, i) => ({
      index: i, score: i === index.get(centre) ? 0.9 : 0.5, season: 1, history: 0, own: false, host: null, weather: null,
    }));
    const spots = topSpots(real, scores, 5, 3);
    expect(spots[0].index).toBe(index.get(centre));
    // Everything within 3 cells of the centre is taken by the first pick, so the rest lie on the outer ring.
    for (const s of spots.slice(1)) expect(gridDisk(centre, 3)).not.toContain(ring[s.index]);
  });
});
