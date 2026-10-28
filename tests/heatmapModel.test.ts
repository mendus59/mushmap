import { describe, expect, it } from 'vitest';
import { isoWeek, scoreCells, weekStart, type Grid, type Model } from '../src/heatmapModel';

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

  it('drops cells below the threshold and out-of-season weeks', () => {
    expect(scoreCells(grid, model(), 18, 0.2).map((s) => s.index)).toEqual([0, 2]);
    expect(scoreCells(grid, model(), 30)).toEqual([]);
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
