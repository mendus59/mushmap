import {
  Bytes, Timestamp, collection, doc, getDocs, orderBy, query, serverTimestamp, writeBatch,
  type DocumentData,
} from 'firebase/firestore';
import { getFirebase } from './firebase';

export type ClusterSize = 'solitary' | 'small' | 'large';
export type LocationSource = 'exif' | 'manual' | 'device' | 'none';

export const MAX_PHOTOS_PER_FIND = 8;

export interface FindInput {
  takenAt: Date | null;
  lat: number | null;
  lon: number | null;
  elevationM: number | null;
  locationSource: LocationSource;
  /** A species or group id from the catalog, or null when customName is used. */
  speciesId: string | null;
  customName: string | null;
  clusterSize: ClusterSize | null;
  nearbyTrees: string[];
  nearbyPlants: string;
  substrate: string;
  habitat: string;
  notes: string;
}

export interface Find extends FindInput {
  id: string;
  thumb: Uint8Array | null;
  photoCount: number;
}

function findsCollection(uid: string) {
  return collection(getFirebase().db, 'users', uid, 'finds');
}

export function fromDoc(id: string, d: DocumentData): Find {
  return {
    id,
    takenAt: d.takenAt instanceof Timestamp ? d.takenAt.toDate() : null,
    lat: d.lat ?? null,
    lon: d.lon ?? null,
    elevationM: d.elevationM ?? null,
    locationSource: d.locationSource ?? 'none',
    speciesId: d.speciesId ?? null,
    customName: d.customName ?? null,
    clusterSize: d.clusterSize ?? null,
    nearbyTrees: d.nearbyTrees ?? [],
    nearbyPlants: d.nearbyPlants ?? '',
    substrate: d.substrate ?? '',
    habitat: d.habitat ?? '',
    notes: d.notes ?? '',
    thumb: d.thumb instanceof Bytes ? d.thumb.toUint8Array() : null,
    photoCount: d.photoCount ?? 0,
  };
}

/** All of a user's finds, newest first. Filtering happens in the browser (see filters.ts). */
export async function listFinds(uid: string): Promise<Find[]> {
  const snap = await getDocs(query(findsCollection(uid), orderBy('takenAt', 'desc')));
  return snap.docs.map((d) => fromDoc(d.id, d.data()));
}

export async function listPhotos(uid: string, findId: string): Promise<Uint8Array[]> {
  const snap = await getDocs(query(collection(findsCollection(uid), findId, 'photos'), orderBy('index')));
  return snap.docs.map((d) => (d.data().data as Bytes).toUint8Array());
}

export async function saveFind(
  uid: string,
  input: FindInput,
  photos: Uint8Array[],
  thumb: Uint8Array | null,
): Promise<string> {
  if (photos.length > MAX_PHOTOS_PER_FIND) throw new Error(`At most ${MAX_PHOTOS_PER_FIND} photos per find`);
  const ref = doc(findsCollection(uid));
  const batch = writeBatch(getFirebase().db);
  batch.set(ref, {
    ...input,
    takenAt: input.takenAt ? Timestamp.fromDate(input.takenAt) : null,
    thumb: thumb ? Bytes.fromUint8Array(thumb) : null,
    photoCount: photos.length,
    createdAt: serverTimestamp(),
  });
  photos.forEach((bytes, index) => {
    batch.set(doc(ref, 'photos', String(index)), { index, data: Bytes.fromUint8Array(bytes) });
  });
  await batch.commit();
  return ref.id;
}

export async function deleteFind(uid: string, find: Find): Promise<void> {
  const ref = doc(findsCollection(uid), find.id);
  const batch = writeBatch(getFirebase().db);
  for (let i = 0; i < find.photoCount; i++) batch.delete(doc(ref, 'photos', String(i)));
  batch.delete(ref);
  await batch.commit();
}

/** Elevation in metres from Open-Meteo (free, no key). Null if offline or the lookup fails. */
export async function lookupElevation(lat: number, lon: number): Promise<number | null> {
  try {
    const r = await fetch(`https://api.open-meteo.com/v1/elevation?latitude=${lat}&longitude=${lon}`);
    if (!r.ok) return null;
    const body = (await r.json()) as { elevation?: number[] };
    const m = body.elevation?.[0];
    return typeof m === 'number' && Number.isFinite(m) ? Math.round(m) : null;
  } catch {
    return null;
  }
}
