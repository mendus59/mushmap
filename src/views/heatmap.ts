import { h } from '../dom';
import { SAFETY_NOTE } from '../legal';
import type { Catalog } from '../species';

// Placeholder until the weekly data jobs publish score files (plan phases 4 to 6).
export function heatmapView(catalog: Catalog): HTMLElement {
  return h('section', { class: 'card' },
    h('h1', {}, 'Foraging heat map'),
    h('p', {}, 'Coming soon for Washington and Oregon. Each week the map will score how likely conditions are for a species, ' +
      'from host trees, season, elevation, recent weather and past sightings.'),
    h('p', {}, `Species groups being tracked: ${catalog.groups.map((g) => g.name).join(', ')}.`),
    h('p', { class: 'note' }, SAFETY_NOTE),
  );
}
