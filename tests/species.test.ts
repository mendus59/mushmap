import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { describeSpeciesId, expandSpeciesId, searchSpecies, type Catalog } from '../src/species';

const catalog: Catalog = JSON.parse(readFileSync(new URL('../public/data/species.json', import.meta.url), 'utf8'));

describe('species catalog', () => {
  it('has unique ids', () => {
    const ids = catalog.groups.flatMap((g) => [g.id, ...g.species.map((s) => s.id)]);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it('tracks the seven starting groups', () => {
    expect(catalog.groups.map((g) => g.id)).toEqual(
      ['morels', 'porcini', 'chanterelles', 'lobster', 'cauliflower', 'psilocybe', 'blewits'],
    );
  });
});

describe('searchSpecies', () => {
  it('returns the whole morel group for "Morels"', () => {
    const results = searchSpecies(catalog, 'Morels');
    expect(results[0]).toMatchObject({ kind: 'group', id: 'morels' });
    const names = results.map((r) => r.label);
    expect(names).toEqual(expect.arrayContaining(['Morchella americana', 'Morchella sextelata', 'Morchella angusticeps']));
  });

  it('matches the singular common name', () => {
    expect(searchSpecies(catalog, 'morel')[0].id).toBe('morels');
  });

  it('finds a species by synonym', () => {
    expect(searchSpecies(catalog, 'Morchella esculenta').map((r) => r.id)).toEqual(['morchella-americana']);
    expect(searchSpecies(catalog, 'lepista nuda').map((r) => r.id)).toEqual(['collybia-nuda']);
  });

  it('finds a species by common name, ignoring case and accents', () => {
    expect(searchSpecies(catalog, 'PACIFIC GOLDEN').map((r) => r.id)).toEqual(['cantharellus-formosus']);
    expect(searchSpecies(catalog, 'blewitt')[0].id).toBe('blewits');
  });

  it('matches whole words inside a longer query', () => {
    expect(searchSpecies(catalog, 'porcini under spruce')[0].id).toBe('porcini');
  });

  it('returns nothing for an unknown name', () => {
    expect(searchSpecies(catalog, 'shaggy mane')).toEqual([]);
  });
});

describe('expandSpeciesId', () => {
  it('expands a group to every member', () => {
    const ids = expandSpeciesId(catalog, 'cauliflower');
    expect(ids.has('cauliflower')).toBe(true);
    expect(ids.has('sparassis-radicata')).toBe(true);
    expect(ids.size).toBe(5);
  });

  it('keeps a single species as itself', () => {
    expect([...expandSpeciesId(catalog, 'boletus-edulis')]).toEqual(['boletus-edulis']);
  });
});

describe('describeSpeciesId', () => {
  it('labels a species with its common name', () => {
    expect(describeSpeciesId(catalog, 'hypomyces-lactifluorum')?.label).toBe('Hypomyces lactifluorum (Lobster mushroom)');
  });

  it('flags psilocybe for the legal note', () => {
    expect(describeSpeciesId(catalog, 'psilocybe-cyanescens')?.group.legalNote).toBe(true);
    expect(describeSpeciesId(catalog, 'boletus-edulis')?.group.legalNote).toBeUndefined();
  });
});
