import { h } from './dom';

// Scoped to Washington and Oregon, the app's first region. Review against current law before launch.
export const PSILOCYBE_NOTE =
  'Psilocybin mushrooms are illegal to possess in Washington and Oregon outside narrow exceptions. ' +
  'Oregon allows psilocybin only through state-licensed service centers, and personal possession ' +
  'has been a misdemeanor again since September 2024. In Washington psilocybin remains a controlled ' +
  'substance statewide, though some cities have made enforcement a low priority. MushMap logs ' +
  'sightings for study and does not advise harvesting. This is not legal advice.';

export const SAFETY_NOTE =
  'Never eat a wild mushroom on the strength of this app. Confirm every identification with an expert; ' +
  'several deadly species look like the ones tracked here.';

export function legalNoteEl(): HTMLElement {
  return h('p', { class: 'note legal' }, PSILOCYBE_NOTE);
}
