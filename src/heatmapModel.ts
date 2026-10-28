/** Mirrors pipeline/model.py: how the browser turns a model into a score per cell for one week. */

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
}

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

export function scoreCells(grid: Grid, model: Model, week: number, minScore = MIN_SCORE): CellScore[] {
  const row = model.seasonElev[week - 1] ?? [];
  const bins = row.length;
  const history = new Map<number, number>();
  model.historyIdx.forEach((idx, i) => history.set(idx, model.historyVal[i] / 100));
  const floor = model.historyFloor;
  const out: CellScore[] = [];
  for (let i = 0; i < grid.cells.length; i++) {
    const elev = grid.elev[i];
    if (elev === null || elev === undefined) continue;
    const bin = Math.max(0, Math.min(bins - 1, Math.round(elev / model.elevBinM)));
    const season = (row[bin] ?? 0) / 100;
    if (season === 0) continue;
    const h = history.get(i) ?? 0;
    const score = season * (floor + (1 - floor) * h);
    if (score >= minScore) out.push({ index: i, score, season, history: h });
  }
  return out;
}
