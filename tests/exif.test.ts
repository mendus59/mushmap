import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { mergeMeta, metaFromExif, readPhotoMeta } from '../src/exif';
import { fitWithin } from '../src/image';

describe('metaFromExif', () => {
  it('reads time and GPS', () => {
    const taken = new Date(2026, 9, 12, 10, 30);
    expect(metaFromExif({ DateTimeOriginal: taken, latitude: 45.5, longitude: -122.6 }))
      .toEqual({ takenAt: taken, lat: 45.5, lon: -122.6 });
  });

  it('applies the camera UTC offset when present', () => {
    // 10:30 wall clock at UTC-07:00 is 17:30 UTC.
    const meta = metaFromExif({ DateTimeOriginal: new Date(2026, 9, 12, 10, 30), OffsetTimeOriginal: '-07:00' });
    expect(meta.takenAt?.toISOString()).toBe('2026-10-12T17:30:00.000Z');
  });

  it('treats 0,0 and out-of-range coordinates as missing', () => {
    expect(metaFromExif({ latitude: 0, longitude: 0 }).lat).toBeNull();
    expect(metaFromExif({ latitude: 95, longitude: 10 }).lat).toBeNull();
  });

  it('handles photos with no EXIF', () => {
    expect(metaFromExif(undefined)).toEqual({ takenAt: null, lat: null, lon: null });
  });

  it('falls back to CreateDate', () => {
    const d = new Date(2026, 4, 1, 8, 0);
    expect(metaFromExif({ CreateDate: d }).takenAt).toEqual(d);
  });
});

describe('readPhotoMeta', () => {
  it('reads GPS and time from a JPEG file', async () => {
    const bytes = readFileSync(new URL('./fixtures/gps.jpg', import.meta.url));
    const meta = await readPhotoMeta(new Blob([bytes], { type: 'image/jpeg' }));
    expect(meta.lat).toBeCloseTo(45.5, 5);
    expect(meta.lon).toBeCloseTo(-122.6, 5);
    expect(meta.takenAt).not.toBeNull();
  });

  it('returns nothing for a file that is not an image', async () => {
    expect(await readPhotoMeta(new Blob(['hello']))).toEqual({ takenAt: null, lat: null, lon: null });
  });
});

describe('mergeMeta', () => {
  it('takes time and place from the first photo that has each', () => {
    const t = new Date(2026, 9, 12);
    expect(mergeMeta([
      { takenAt: null, lat: null, lon: null },
      { takenAt: t, lat: null, lon: null },
      { takenAt: null, lat: 46, lon: -121 },
    ])).toEqual({ takenAt: t, lat: 46, lon: -121 });
  });
});

describe('fitWithin', () => {
  it('scales the long edge down and keeps the aspect ratio', () => {
    expect(fitWithin(4032, 3024, 1600)).toEqual({ width: 1600, height: 1200 });
    expect(fitWithin(3024, 4032, 1600)).toEqual({ width: 1200, height: 1600 });
  });

  it('never scales up', () => {
    expect(fitWithin(800, 600, 1600)).toEqual({ width: 800, height: 600 });
  });
});
