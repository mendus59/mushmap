export const PHOTO_MAX_PX = 1600;
export const PHOTO_TARGET_BYTES = 180_000;
export const THUMB_MAX_PX = 320;
export const THUMB_TARGET_BYTES = 20_000;

export function fitWithin(width: number, height: number, maxPx: number): { width: number; height: number } {
  const scale = Math.min(1, maxPx / Math.max(width, height));
  return { width: Math.round(width * scale), height: Math.round(height * scale) };
}

function encode(canvas: HTMLCanvasElement, quality: number): Promise<Blob> {
  return new Promise((resolve, reject) => {
    canvas.toBlob((b) => (b ? resolve(b) : reject(new Error('Could not encode image'))), 'image/webp', quality);
  });
}

async function shrink(bitmap: ImageBitmap, maxPx: number, targetBytes: number): Promise<Blob> {
  const { width, height } = fitWithin(bitmap.width, bitmap.height, maxPx);
  const canvas = document.createElement('canvas');
  canvas.width = width;
  canvas.height = height;
  canvas.getContext('2d')!.drawImage(bitmap, 0, 0, width, height);
  // Step quality down until the photo fits its budget; Firestore documents cap at 1 MiB.
  let blob = await encode(canvas, 0.82);
  for (const q of [0.7, 0.6, 0.5, 0.4]) {
    if (blob.size <= targetBytes) break;
    blob = await encode(canvas, q);
  }
  return blob;
}

export interface CompressedPhoto {
  full: Blob;
  thumb: Blob;
}

export async function compressPhoto(file: Blob): Promise<CompressedPhoto> {
  // 'from-image' applies the EXIF rotation so portrait phone shots stay upright.
  const bitmap = await createImageBitmap(file, { imageOrientation: 'from-image' });
  try {
    return {
      full: await shrink(bitmap, PHOTO_MAX_PX, PHOTO_TARGET_BYTES),
      thumb: await shrink(bitmap, THUMB_MAX_PX, THUMB_TARGET_BYTES),
    };
  } finally {
    bitmap.close();
  }
}

export async function blobToBytes(blob: Blob): Promise<Uint8Array> {
  return new Uint8Array(await blob.arrayBuffer());
}

export function bytesToUrl(bytes: Uint8Array): string {
  return URL.createObjectURL(new Blob([bytes as BlobPart], { type: 'image/webp' }));
}
