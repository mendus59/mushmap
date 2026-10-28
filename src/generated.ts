/** Loading the data the weekly pipeline generates, shared by the heat map and the trail finder. */
import { h } from './dom';
import { weekStart, type ModelIndex } from './heatmapModel';
import type { Catalog } from './species';

const DATA = `${import.meta.env.BASE_URL}data/generated`;

export async function getJson<T>(path: string): Promise<T | null> {
  const r = await fetch(`${DATA}/${path}`);
  if (r.status === 404) return null;
  if (!r.ok) throw new Error(`Could not load ${path} (${r.status})`);
  return r.json() as Promise<T>;
}

export function weekLabel(week: number): string {
  const year = new Date().getFullYear();
  const start = weekStart(year, week);
  const end = new Date(start);
  end.setUTCDate(start.getUTCDate() + 6);
  const fmt = (d: Date) => d.toLocaleDateString(undefined, { month: 'short', day: 'numeric', timeZone: 'UTC' });
  return `Week ${week}: ${fmt(start)} to ${fmt(end)}`;
}

export function shortDate(iso: string): string {
  return new Date(`${iso}T12:00:00`).toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
}

/** Fill a species select with every model, grouped as in the catalog. */
export function fillModelSelect(select: HTMLSelectElement, catalog: Catalog, index: ModelIndex): void {
  for (const group of catalog.groups) {
    const entries = index.models.filter((m) => m.groupId === group.id);
    if (!entries.length) continue;
    select.append(h('optgroup', { label: group.name },
      ...entries.map((m) => h('option', { value: m.id },
        `${m.kind === 'group' ? `All ${group.name.toLowerCase()}` : m.label} (${m.count.toLocaleString()} sightings)`))));
  }
}
