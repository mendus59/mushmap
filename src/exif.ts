import exifr from 'exifr';

export interface PhotoMeta {
  takenAt: Date | null;
  lat: number | null;
  lon: number | null;
}

interface ExifTags {
  DateTimeOriginal?: Date | string;
  CreateDate?: Date | string;
  OffsetTimeOriginal?: string;
  latitude?: number;
  longitude?: number;
}

function parseOffsetMinutes(offset: string): number | null {
  const m = /^([+-])(\d{2}):?(\d{2})$/.exec(offset.trim());
  if (!m) return null;
  const minutes = Number(m[2]) * 60 + Number(m[3]);
  return m[1] === '-' ? -minutes : minutes;
}

/**
 * exifr reads DateTimeOriginal as wall-clock time in the browser's zone.
 * When the camera also recorded its UTC offset, rebuild the exact instant.
 */
function resolveTakenAt(tags: ExifTags): Date | null {
  const raw = tags.DateTimeOriginal ?? tags.CreateDate;
  if (!raw) return null;
  const local = raw instanceof Date ? raw : new Date(raw);
  if (Number.isNaN(local.getTime())) return null;
  const offset = tags.OffsetTimeOriginal ? parseOffsetMinutes(tags.OffsetTimeOriginal) : null;
  if (offset === null) return local;
  const wallClockAsUtc = Date.UTC(
    local.getFullYear(), local.getMonth(), local.getDate(),
    local.getHours(), local.getMinutes(), local.getSeconds(),
  );
  return new Date(wallClockAsUtc - offset * 60_000);
}

function validCoord(value: unknown, limit: number): value is number {
  return typeof value === 'number' && Number.isFinite(value) && Math.abs(value) <= limit;
}

export function metaFromExif(tags: ExifTags | undefined | null): PhotoMeta {
  if (!tags) return { takenAt: null, lat: null, lon: null };
  const hasGps = validCoord(tags.latitude, 90) && validCoord(tags.longitude, 180)
    // 0,0 is what some apps write when location was stripped.
    && !(tags.latitude === 0 && tags.longitude === 0);
  return {
    takenAt: resolveTakenAt(tags),
    lat: hasGps ? tags.latitude! : null,
    lon: hasGps ? tags.longitude! : null,
  };
}

export async function readPhotoMeta(file: Blob): Promise<PhotoMeta> {
  try {
    const tags = await exifr.parse(file, {
      pick: ['DateTimeOriginal', 'CreateDate', 'OffsetTimeOriginal', 'GPSLatitude', 'GPSLongitude', 'GPSLatitudeRef', 'GPSLongitudeRef'],
      gps: true,
    });
    return metaFromExif(tags);
  } catch {
    return { takenAt: null, lat: null, lon: null };
  }
}

/** First photo with a timestamp gives the time; first with GPS gives the place. */
export function mergeMeta(metas: PhotoMeta[]): PhotoMeta {
  return {
    takenAt: metas.find((m) => m.takenAt)?.takenAt ?? null,
    lat: metas.find((m) => m.lat !== null)?.lat ?? null,
    lon: metas.find((m) => m.lat !== null)?.lon ?? null,
  };
}
