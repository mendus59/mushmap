export interface Bounds {
  west: number;
  south: number;
  east: number;
  north: number;
}

export interface FindFilter {
  /** Inclusive, as YYYY-MM-DD in the user's local time. */
  from: string | null;
  to: string | null;
  /** Expanded species ids (a group expands to every species in it). */
  speciesIds: Set<string> | null;
  /** Free-text match on custom names and notes. */
  text: string;
  bounds: Bounds | null;
  near: { lat: number; lon: number; radiusKm: number } | null;
}

export interface FilterableFind {
  takenAt: Date | null;
  lat: number | null;
  lon: number | null;
  speciesId: string | null;
  customName: string | null;
  notes: string;
  habitat: string;
  nearbyPlants: string;
  nearbyTrees: string[];
}

export const emptyFilter = (): FindFilter => ({
  from: null, to: null, speciesIds: null, text: '', bounds: null, near: null,
});

export function localDateKey(d: Date): string {
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

export function distanceKm(aLat: number, aLon: number, bLat: number, bLon: number): number {
  const rad = Math.PI / 180;
  const dLat = (bLat - aLat) * rad;
  const dLon = (bLon - aLon) * rad;
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(aLat * rad) * Math.cos(bLat * rad) * Math.sin(dLon / 2) ** 2;
  return 2 * 6371 * Math.asin(Math.sqrt(h));
}

function inBounds(lat: number, lon: number, b: Bounds): boolean {
  if (lat < b.south || lat > b.north) return false;
  // Bounds that cross the antimeridian have west > east.
  return b.west <= b.east ? lon >= b.west && lon <= b.east : lon >= b.west || lon <= b.east;
}

export function matchesFilter(find: FilterableFind, f: FindFilter): boolean {
  if (f.from || f.to) {
    if (!find.takenAt) return false;
    const day = localDateKey(find.takenAt);
    if (f.from && day < f.from) return false;
    if (f.to && day > f.to) return false;
  }
  if (f.speciesIds && !(find.speciesId && f.speciesIds.has(find.speciesId))) return false;
  if (f.bounds || f.near) {
    if (find.lat === null || find.lon === null) return false;
    if (f.bounds && !inBounds(find.lat, find.lon, f.bounds)) return false;
    if (f.near && distanceKm(find.lat, find.lon, f.near.lat, f.near.lon) > f.near.radiusKm) return false;
  }
  const text = f.text.trim().toLowerCase();
  if (text) {
    const haystack = [find.customName ?? '', find.notes, find.habitat, find.nearbyPlants, ...find.nearbyTrees]
      .join(' ')
      .toLowerCase();
    if (!haystack.includes(text)) return false;
  }
  return true;
}
