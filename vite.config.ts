import { defineConfig } from 'vitest/config';

// Served from https://mendus59.github.io/mushmap/
export default defineConfig({
  base: '/mushmap/',
  test: {
    environment: 'node',
  },
});
