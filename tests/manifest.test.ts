import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const manifest = JSON.parse(readFileSync('public/manifest.webmanifest', 'utf8'));

describe('web app manifest', () => {
  // Chrome on Android builds the installed app (a WebAPK) from PNG icons; an SVG icon can make install fail.
  it('lists only PNG icons, with 192 and 512 sizes for both purposes', () => {
    for (const icon of manifest.icons) {
      expect(icon.type).toBe('image/png');
      expect(readFileSync(`public/${icon.src}`).subarray(1, 4).toString()).toBe('PNG');
    }
    for (const purpose of ['any', 'maskable']) {
      const sizes = manifest.icons.filter((i: { purpose: string }) => i.purpose === purpose).map((i: { sizes: string }) => i.sizes);
      expect(sizes).toEqual(expect.arrayContaining(['192x192', '512x512']));
    }
  });

  it('stays inside the GitHub Pages folder', () => {
    expect(manifest.start_url).toBe('./');
    expect(manifest.scope).toBe('./');
  });
});
