export interface Species {
  id: string;
  scientificName: string;
  commonNames: string[];
  synonyms: string[];
}

export interface SpeciesGroup {
  id: string;
  name: string;
  aliases: string[];
  /** iNaturalist taxon names the data pipeline queries for this group. */
  inatTaxa: string[];
  legalNote?: boolean;
  species: Species[];
}

export interface Catalog {
  version: number;
  groups: SpeciesGroup[];
  trees: string[];
}

/** One row in the species picker: either a whole group or a single species. */
export interface SpeciesOption {
  kind: 'group' | 'species';
  id: string;
  label: string;
  detail: string;
  groupId: string;
}

let cached: Promise<Catalog> | null = null;

export function loadCatalog(): Promise<Catalog> {
  cached ??= fetch(`${import.meta.env.BASE_URL}data/species.json`).then((r) => {
    if (!r.ok) throw new Error(`Could not load species catalog (${r.status})`);
    return r.json() as Promise<Catalog>;
  });
  return cached;
}

export function normalize(text: string): string {
  return text
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();
}

function groupOption(g: SpeciesGroup): SpeciesOption {
  return { kind: 'group', id: g.id, label: g.name, detail: `All ${g.species.length} species`, groupId: g.id };
}

function speciesOption(g: SpeciesGroup, s: Species): SpeciesOption {
  return {
    kind: 'species',
    id: s.id,
    label: s.scientificName,
    detail: [s.commonNames.join(', '), ...s.synonyms.map((n) => `syn. ${n}`)].filter(Boolean).join(' · '),
    groupId: g.id,
  };
}

/** "morel" finds "Morels". */
function partOf(query: string, names: string[]): boolean {
  return names.some((n) => normalize(n).includes(query));
}

/** "porcini under spruce" finds "Porcini" (whole words only). */
function mentionedIn(query: string, names: string[]): boolean {
  return names.some((n) => ` ${query} `.includes(` ${normalize(n)} `));
}

function matches(query: string, names: string[]): boolean {
  return partOf(query, names) || mentionedIn(query, names);
}

/**
 * Search by group name, common name, scientific name or synonym.
 * A query that matches a group returns the group followed by every species in it,
 * so "morels" lists Morchella americana, M. sextelata and the rest.
 */
export function searchSpecies(catalog: Catalog, rawQuery: string): SpeciesOption[] {
  const query = normalize(rawQuery);
  const out: SpeciesOption[] = [];
  for (const g of catalog.groups) {
    if (!query) {
      out.push(groupOption(g), ...g.species.map((s) => speciesOption(g, s)));
      continue;
    }
    const groupNames = [g.name, ...g.aliases];
    const hits = g.species.filter((s) => matches(query, [s.scientificName, ...s.commonNames, ...s.synonyms]));
    // A group name wins unless the query only mentions it alongside a specific species,
    // e.g. "Morchella esculenta" should give that species, not every morel.
    if (partOf(query, groupNames) || (!hits.length && mentionedIn(query, groupNames))) {
      out.push(groupOption(g), ...g.species.map((s) => speciesOption(g, s)));
    } else {
      out.push(...hits.map((s) => speciesOption(g, s)));
    }
  }
  return out;
}

/** Every species id covered by a group or species id, for filtering finds. */
export function expandSpeciesId(catalog: Catalog, id: string): Set<string> {
  const group = catalog.groups.find((g) => g.id === id);
  if (group) return new Set([group.id, ...group.species.map((s) => s.id)]);
  return new Set([id]);
}

export function describeSpeciesId(catalog: Catalog, id: string): { label: string; group: SpeciesGroup } | null {
  for (const g of catalog.groups) {
    if (g.id === id) return { label: g.name, group: g };
    const s = g.species.find((x) => x.id === id);
    if (s) {
      const common = s.commonNames[0];
      return { label: common ? `${s.scientificName} (${common})` : s.scientificName, group: g };
    }
  }
  return null;
}
