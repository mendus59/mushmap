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
  /** Dangerous or confusing lookalikes, shown wherever the group is picked. */
  lookalikes?: string;
  /** Host-tree gate for the heat map (FIA species codes from the USFS tree maps). */
  hostFloor?: number;
  hostTrees?: { fia: number; name: string; weight: number }[];
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
  /** The parts of a species label, so the picker can set the scientific name in italics. */
  common?: string;
  sci?: string;
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

/** A group is shown as "X and allies" only when its common name covers more than one species. */
export function hasAllies(g: SpeciesGroup): boolean {
  return g.species.length > 1;
}

/** "King bolete (Boletus edulis)", or just the scientific name when there is no common one. */
export function speciesLabel(s: Species): string {
  const common = s.commonNames[0];
  return common ? `${common} (${s.scientificName})` : s.scientificName;
}

/** "Porcini and allies", or the lone species' label for a group of one. */
export function groupLabel(g: SpeciesGroup): string {
  return hasAllies(g) ? `${g.name} and allies` : speciesLabel(g.species[0]);
}

function speciesDetail(s: Species): string {
  return [s.commonNames.slice(1).join(', '), ...s.synonyms.map((n) => `syn. ${n}`)].filter(Boolean).join(' · ');
}

/** A group of one is offered as that species, under the group's id so maps and filters still cover it. */
function groupOption(g: SpeciesGroup): SpeciesOption {
  if (!hasAllies(g)) {
    const s = g.species[0];
    return { kind: 'group', id: g.id, label: speciesLabel(s), common: s.commonNames[0], sci: s.scientificName, detail: speciesDetail(s), groupId: g.id };
  }
  return { kind: 'group', id: g.id, label: groupLabel(g), detail: `All ${g.species.length} species`, groupId: g.id };
}

function speciesOption(g: SpeciesGroup, s: Species): SpeciesOption {
  return { kind: 'species', id: s.id, label: speciesLabel(s), common: s.commonNames[0], sci: s.scientificName, detail: speciesDetail(s), groupId: g.id };
}

/** The group row, followed by its species when it has allies. */
function groupOptions(g: SpeciesGroup): SpeciesOption[] {
  return hasAllies(g) ? [groupOption(g), ...g.species.map((s) => speciesOption(g, s))] : [groupOption(g)];
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
      out.push(...groupOptions(g));
      continue;
    }
    const groupNames = [g.name, ...g.aliases];
    const hits = g.species.filter((s) => matches(query, [s.scientificName, ...s.commonNames, ...s.synonyms]));
    // A group name wins unless the query only mentions it alongside a specific species,
    // e.g. "Morchella esculenta" should give that species, not every morel.
    if (partOf(query, groupNames) || (!hits.length && mentionedIn(query, groupNames)) || (hits.length && !hasAllies(g))) {
      out.push(...groupOptions(g));
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
    if (g.id === id) return { label: groupLabel(g), group: g };
    const s = g.species.find((x) => x.id === id);
    if (s) return { label: speciesLabel(s), group: g };
  }
  return null;
}
