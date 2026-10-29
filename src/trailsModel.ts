/** Trails from pipeline/trails.py, and ranking them by how likely a mushroom is along them and how easy they are to reach. */

export interface Trail {
  /** Name, with "(section n of m)" for long trails cut by area. */
  n: string;
  km: number;
  /** Metres climbed going the harder way along the trail. */
  g: number;
  /** OpenStreetMap sac_scale of the hardest part, or null when not tagged. */
  sac: string | null;
  /** Share on public land weighted by access (open 1, restricted 0.6, unknown 0.4), 0..100. */
  pub: number;
  /** Share on open-access public land, 0..100. */
  open: number;
  /** Most common land manager or unit along the trail. */
  mgr: string | null;
  /** Reachable from a road or trailhead. */
  th: boolean;
  /** Ease of walking, 0..100. */
  e: number;
  /** Accessibility, 0..100. */
  s: number;
  /** Grid cell indices the trail passes through. */
  c: number[];
  /** [west, south, east, north] */
  b: [number, number, number, number];
  /** Encoded polylines (precision 5). */
  l: string[];
}

export interface TrailData {
  generatedAt: string;
  trails: Trail[];
  /** Per grid cell, share on public land weighted by access, 0..100. */
  cellLand: number[];
}

export interface Bounds {
  west: number;
  south: number;
  east: number;
  north: number;
}

export interface RankedTrail {
  index: number;
  trail: Trail;
  /** 0..1, from the heat map scores of the cells along the trail. */
  likelihood: number;
  /** 0..1 */
  access: number;
  /** Geometric mean of likelihood and access, 0..1. */
  overall: number;
  /** The cell along the trail with the best score. */
  bestCell: number;
}

/** Google encoded polyline to [lng, lat] pairs. */
export function decodePolyline(text: string, precision = 5): [number, number][] {
  const out: [number, number][] = [];
  const f = 10 ** precision;
  let i = 0;
  let lat = 0;
  let lng = 0;
  const next = () => {
    let result = 0;
    let shift = 0;
    let b: number;
    do {
      b = text.charCodeAt(i++) - 63;
      result |= (b & 0x1f) << shift;
      shift += 5;
    } while (b >= 0x20);
    return result & 1 ? ~(result >> 1) : result >> 1;
  };
  while (i < text.length) {
    lat += next();
    lng += next();
    out.push([lng / f, lat / f]);
  }
  return out;
}

export function overlaps(b: Trail['b'], area: Bounds): boolean {
  return b[0] <= area.east && b[2] >= area.west && b[1] <= area.north && b[3] >= area.south;
}

/**
 * How likely the mushroom is along a trail: mostly its best cell, partly how good it is throughout,
 * so a trail through one excellent patch still ranks well and a long trail is not rewarded for length.
 */
export function trailLikelihood(cells: number[], cellScore: Float32Array): { likelihood: number; bestCell: number } {
  let best = 0;
  let bestCell = cells[0] ?? -1;
  let sum = 0;
  for (const c of cells) {
    const v = cellScore[c] ?? 0;
    sum += v;
    if (v > best) {
      best = v;
      bestCell = c;
    }
  }
  return { likelihood: cells.length ? 0.6 * best + 0.4 * (sum / cells.length) : 0, bestCell };
}

/** Trails in the area with any chance of the mushroom, best overall first. */
export function rankTrails(trails: Trail[], cellScore: Float32Array, area: Bounds, limit = 25): RankedTrail[] {
  const out: RankedTrail[] = [];
  trails.forEach((trail, index) => {
    if (!overlaps(trail.b, area)) return;
    const { likelihood, bestCell } = trailLikelihood(trail.c, cellScore);
    if (likelihood <= 0) return;
    const access = trail.s / 100;
    out.push({ index, trail, likelihood, access, overall: Math.sqrt(likelihood * access), bestCell });
  });
  return out.sort((a, b) => b.overall - a.overall).slice(0, limit);
}

export function accessLabel(score: number): string {
  if (score >= 85) return 'Excellent';
  if (score >= 65) return 'Good';
  if (score >= 40) return 'Moderate';
  if (score >= 20) return 'Low';
  return 'Very low';
}

const SAC_LABELS: Record<string, string> = {
  hiking: 'easy hiking',
  mountain_hiking: 'mountain hiking',
  demanding_mountain_hiking: 'demanding mountain hiking',
  alpine_hiking: 'alpine hiking',
  demanding_alpine_hiking: 'demanding alpine hiking',
  difficult_alpine_hiking: 'difficult alpine hiking',
};

/** One sentence on why a trail has the accessibility it has. */
export function describeAccess(t: Trail): string {
  const land = t.pub >= 80
    ? `${t.open >= 80 ? 'open' : 'mostly restricted'} public land`
    : t.pub >= 20 ? `partly public land (${t.pub}%)` : 'mostly private or closed land';
  const grade = Math.round(t.g / Math.max(t.km, 0.1));
  const parts = [
    `${land}${t.mgr ? ` (${t.mgr})` : ''}`,
    `${t.km} km with ${t.g.toLocaleString()} m of climbing (${grade} m per km)`,
    t.sac ? SAC_LABELS[t.sac] ?? t.sac.replace(/_/g, ' ') : null,
    t.th ? 'reached from a road or trailhead' : 'no road or trailhead of its own',
  ];
  return parts.filter(Boolean).join('; ');
}

/** Mean public-land share of the grid cells whose centres fall in an area, or null when none do. */
export function areaPublicLand(cellLand: number[], cellCentres: [number, number][], area: Bounds): number | null {
  let sum = 0;
  let n = 0;
  cellCentres.forEach(([lat, lng], i) => {
    if (lat < area.south || lat > area.north || lng < area.west || lng > area.east) return;
    sum += cellLand[i] ?? 0;
    n++;
  });
  return n ? sum / n : null;
}

/** The two ends of each line of a trail, as [lng, lat]. */
export function trailEnds(t: Trail): [number, number][] {
  return t.l.flatMap((line) => {
    const pts = decodePolyline(line);
    return pts.length ? [pts[0], pts[pts.length - 1]] : [];
  });
}

/**
 * The end of a trail nearest a point, as [lng, lat]. The trail data has no trailhead points, so the
 * end nearest where the person tapped (or the trail's best spot) stands in for the trailhead.
 */
export function nearestEnd(t: Trail, to: [number, number]): [number, number] | null {
  const cosLat = Math.cos((to[1] * Math.PI) / 180);
  let best: [number, number] | null = null;
  let bestD = Infinity;
  for (const p of trailEnds(t)) {
    const d = ((p[0] - to[0]) * cosLat) ** 2 + (p[1] - to[1]) ** 2;
    if (d < bestD) {
      bestD = d;
      best = p;
    }
  }
  return best;
}

export type Platform = 'android' | 'apple' | 'other';

export function detectPlatform(userAgent: string): Platform {
  if (/Android/i.test(userAgent)) return 'android';
  if (/iPhone|iPad|iPod|Macintosh/i.test(userAgent)) return 'apple';
  return 'other';
}

export interface NavLink {
  label: string;
  href: string;
}

/**
 * Links that open driving directions to a point in the navigation apps on the device: the geo: link
 * lets Android offer every installed maps app, Apple Maps opens on iPhone and Mac, and Google Maps and
 * Waze open their apps when installed or the website when not.
 */
export function navigationLinks(lat: number, lng: number, name: string, platform: Platform): NavLink[] {
  const ll = `${lat.toFixed(6)},${lng.toFixed(6)}`;
  const google = { label: 'Google Maps', href: `https://www.google.com/maps/dir/?api=1&destination=${ll}&travelmode=driving` };
  const apple = { label: 'Apple Maps', href: `https://maps.apple.com/?daddr=${ll}&dirflg=d&q=${encodeURIComponent(name)}` };
  const waze = { label: 'Waze', href: `https://waze.com/ul?ll=${ll}&navigate=yes` };
  if (platform === 'android') {
    const label = name.replace(/[()]/g, '');
    return [{ label: 'Maps app', href: `geo:0,0?q=${ll}(${encodeURIComponent(label)})` }, google, waze];
  }
  if (platform === 'apple') return [apple, google, waze];
  return [google, apple, waze];
}
