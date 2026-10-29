import { describe, expect, it } from 'vitest';
import {
  accessLabel, areaPublicLand, decodePolyline, describeAccess, detectPlatform, navigationLinks, nearestEnd,
  rankTrails, trailEnds, trailLikelihood, type Trail,
} from '../src/trailsModel';

function trail(over: Partial<Trail>): Trail {
  return {
    n: 'T', km: 5, g: 100, sac: null, pub: 100, open: 100, mgr: null, th: true, e: 100, s: 100,
    c: [0], b: [-121.1, 45.9, -120.9, 46.1], l: [], ...over,
  };
}

describe('decodePolyline', () => {
  it('decodes Google\'s example to [lng, lat]', () => {
    const pts = decodePolyline('_p~iF~ps|U_ulLnnqC_mqNvxq`@');
    expect(pts).toEqual([[-120.2, 38.5], [-120.95, 40.7], [-126.453, 43.252]]);
  });
});

describe('ranking', () => {
  const scores = new Float32Array([0.9, 0.1, 0.5, 0]);
  const area = { west: -122, south: 45, east: -120, north: 47 };

  it('weights a trail\'s best cell over its average', () => {
    const { likelihood, bestCell } = trailLikelihood([0, 1], scores);
    expect(bestCell).toBe(0);
    expect(likelihood).toBeCloseTo(0.6 * 0.9 + 0.4 * 0.5);
  });

  it('ranks by the geometric mean of likelihood and accessibility, inside the area only', () => {
    const trails = [
      trail({ n: 'likely but hard to reach', c: [0], s: 20 }),
      trail({ n: 'decent and easy', c: [2], s: 100 }),
      trail({ n: 'no chance', c: [3], s: 100 }),
      trail({ n: 'elsewhere', c: [0], s: 100, b: [-118, 44, -117.9, 44.1] }),
    ];
    const ranked = rankTrails(trails, scores, area);
    expect(ranked.map((r) => r.trail.n)).toEqual(['decent and easy', 'likely but hard to reach']);
    expect(ranked[0].overall).toBeCloseTo(Math.sqrt(0.5));
    expect(ranked[1].index).toBe(0);
  });
});

describe('describing access', () => {
  it('labels scores and explains them', () => {
    expect([100, 70, 50, 25, 8].map(accessLabel)).toEqual(['Excellent', 'Good', 'Moderate', 'Low', 'Very low']);
    const text = describeAccess(trail({ mgr: 'Gifford Pinchot National Forest', sac: 'mountain_hiking', g: 600, km: 6, th: false }));
    expect(text).toBe('open public land (Gifford Pinchot National Forest); 6 km with 600 m of climbing (100 m per km); ' +
      'mountain hiking; no road or trailhead of its own');
    expect(describeAccess(trail({ pub: 5, open: 0 }))).toMatch(/^mostly private or closed land/);
  });

  it('averages public land over the cells in an area', () => {
    const centres: [number, number][] = [[46, -121], [46.5, -121], [50, -121]];
    expect(areaPublicLand([100, 0, 100], centres, { west: -122, south: 45, east: -120, north: 47 })).toBe(50);
    expect(areaPublicLand([100], [[50, -121]], { west: -122, south: 45, east: -120, north: 47 })).toBeNull();
  });
});

describe('navigation', () => {
  // Two lines: (45, -121) -> (45.1, -121.1) and (46, -122) -> (46.05, -122).
  const line = (pts: [number, number][]) => {
    const enc = (v: number) => {
      let n = v < 0 ? ~(v << 1) : v << 1;
      let s = '';
      while (n >= 0x20) {
        s += String.fromCharCode((0x20 | (n & 0x1f)) + 63);
        n >>= 5;
      }
      return s + String.fromCharCode(n + 63);
    };
    let lat = 0;
    let lng = 0;
    return pts.map(([la, ln]) => {
      const a = Math.round(la * 1e5);
      const b = Math.round(ln * 1e5);
      const out = enc(a - lat) + enc(b - lng);
      lat = a;
      lng = b;
      return out;
    }).join('');
  };
  const t = trail({ l: [line([[45, -121], [45.1, -121.1]]), line([[46, -122], [46.05, -122]])] });

  it('finds the trail end nearest a point', () => {
    expect(trailEnds(t)).toHaveLength(4);
    expect(nearestEnd(t, [-121.09, 45.09])).toEqual([-121.1, 45.1]);
    expect(nearestEnd(t, [-122, 46.2])).toEqual([-122, 46.05]);
    expect(nearestEnd(trail({ l: [] }), [0, 0])).toBeNull();
  });

  it('detects the platform', () => {
    expect(detectPlatform('Mozilla/5.0 (Linux; Android 14; Pixel 8)')).toBe('android');
    expect(detectPlatform('Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X)')).toBe('apple');
    expect(detectPlatform('Mozilla/5.0 (Windows NT 10.0; Win64; x64)')).toBe('other');
  });

  it('builds links for the platform\'s navigation apps', () => {
    const android = navigationLinks(45.5, -121.25, 'Lost (Lake) Trail', 'android');
    expect(android.map((l) => l.label)).toEqual(['Maps app', 'Google Maps', 'Waze']);
    expect(android[0].href).toBe('geo:0,0?q=45.500000,-121.250000(Lost%20Lake%20Trail)');
    expect(android[1].href).toContain('destination=45.500000,-121.250000');
    const apple = navigationLinks(45.5, -121.25, 'Lost Lake', 'apple');
    expect(apple[0]).toEqual({ label: 'Apple Maps', href: 'https://maps.apple.com/?daddr=45.500000,-121.250000&dirflg=d&q=Lost%20Lake' });
    expect(navigationLinks(45.5, -121.25, 'x', 'other')[0].label).toBe('Google Maps');
  });
});
