import { describe, expect, it } from 'vitest';
import { distanceKm, emptyFilter, matchesFilter, type FilterableFind } from '../src/filters';

const find = (over: Partial<FilterableFind> = {}): FilterableFind => ({
  takenAt: new Date(2026, 9, 12, 10, 30),
  lat: 45.52, lon: -122.68, // Portland
  speciesId: 'cantharellus-formosus',
  customName: null,
  notes: 'Under second-growth Douglas-fir',
  habitat: '', nearbyPlants: 'salal', nearbyTrees: ['Douglas-fir'],
  ...over,
});

describe('matchesFilter', () => {
  it('passes everything with an empty filter, even finds with no date or place', () => {
    expect(matchesFilter(find({ takenAt: null, lat: null, lon: null }), emptyFilter())).toBe(true);
  });

  it('filters by inclusive date range', () => {
    const f = { ...emptyFilter(), from: '2026-10-12', to: '2026-10-12' };
    expect(matchesFilter(find(), f)).toBe(true);
    expect(matchesFilter(find({ takenAt: new Date(2026, 9, 13, 0, 1) }), f)).toBe(false);
    expect(matchesFilter(find({ takenAt: null }), f)).toBe(false);
  });

  it('filters by a set of species ids', () => {
    const f = { ...emptyFilter(), speciesIds: new Set(['chanterelles', 'cantharellus-formosus']) };
    expect(matchesFilter(find(), f)).toBe(true);
    expect(matchesFilter(find({ speciesId: 'boletus-edulis' }), f)).toBe(false);
    expect(matchesFilter(find({ speciesId: null, customName: 'Hedgehog' }), f)).toBe(false);
  });

  it('filters by map bounds', () => {
    const f = { ...emptyFilter(), bounds: { west: -123, south: 45, east: -122, north: 46 } };
    expect(matchesFilter(find(), f)).toBe(true);
    expect(matchesFilter(find({ lat: 47.6, lon: -122.33 }), f)).toBe(false);
    expect(matchesFilter(find({ lat: null, lon: null }), f)).toBe(false);
  });

  it('filters by distance from a point', () => {
    const f = { ...emptyFilter(), near: { lat: 45.5, lon: -122.6, radiusKm: 25 } };
    expect(matchesFilter(find(), f)).toBe(true);
    expect(matchesFilter(find({ lat: 47.6, lon: -122.33 }), f)).toBe(false);
  });

  it('matches free text in notes, plants, trees and custom names', () => {
    expect(matchesFilter(find(), { ...emptyFilter(), text: 'salal' })).toBe(true);
    expect(matchesFilter(find(), { ...emptyFilter(), text: 'douglas' })).toBe(true);
    expect(matchesFilter(find({ customName: 'Hedgehog' }), { ...emptyFilter(), text: 'hedge' })).toBe(true);
    expect(matchesFilter(find(), { ...emptyFilter(), text: 'oak' })).toBe(false);
  });
});

describe('distanceKm', () => {
  it('measures Portland to Seattle at about 233 km', () => {
    expect(distanceKm(45.52, -122.68, 47.61, -122.33)).toBeCloseTo(233, -1);
  });
});
