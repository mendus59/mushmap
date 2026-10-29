import { readFileSync } from 'node:fs';
import { defineConfig, type Plugin } from 'vitest/config';

// Builds sw.js from pwa/sw.js with this build's version and the files to keep for offline use.
function serviceWorker(): Plugin {
  return {
    name: 'mushmap-service-worker',
    apply: 'build',
    generateBundle(_options, bundle) {
      const built = Object.keys(bundle).filter((f) => /\.(js|css)$/.test(f));
      const precache = ['./', 'manifest.webmanifest', 'icons/icon-192.png', 'icons/icon.svg', ...built];
      const source = readFileSync('pwa/sw.js', 'utf8')
        .replace('__VERSION__', JSON.stringify(Date.now().toString(36)))
        .replace('__PRECACHE__', JSON.stringify(precache));
      this.emitFile({ type: 'asset', fileName: 'sw.js', source });
    },
  };
}

// Served from https://mendus59.github.io/mushmap/
export default defineConfig({
  base: '/mushmap/',
  plugins: [serviceWorker()],
  test: {
    environment: 'node',
  },
});
