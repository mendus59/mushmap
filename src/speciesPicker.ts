import { h, clear } from './dom';
import { searchSpecies, type Catalog, type SpeciesOption } from './species';

export interface SpeciesPicker {
  el: HTMLElement;
  value(): SpeciesOption | null;
  set(option: SpeciesOption | null): void;
}

/** Searchable drop-down over the catalog. Typing "morel" lists the Morels group and every Morchella. */
export function speciesPicker(catalog: Catalog, opts: { placeholder: string; onChange?: (o: SpeciesOption | null) => void }): SpeciesPicker {
  let selected: SpeciesOption | null = null;
  const input = h('input', { type: 'search', placeholder: opts.placeholder, autocomplete: 'off', 'aria-autocomplete': 'list' });
  const list = h('ul', { class: 'picker-list', role: 'listbox', hidden: true });

  const render = () => {
    clear(list);
    for (const o of searchSpecies(catalog, input.value).slice(0, 60)) {
      list.append(
        h('li', {
          role: 'option',
          class: o.kind === 'group' ? 'group' : 'species',
          onmousedown: (e: Event) => { e.preventDefault(); choose(o); },
        },
        h('span', { class: o.kind === 'species' ? 'sci' : '' }, o.label),
        h('small', {}, o.detail)),
      );
    }
    if (!list.children.length) list.append(h('li', { class: 'empty' }, 'No tracked species match'));
    list.hidden = false;
  };

  const choose = (o: SpeciesOption | null) => {
    selected = o;
    input.value = o ? o.label : '';
    list.hidden = true;
    opts.onChange?.(o);
  };

  input.addEventListener('focus', render);
  input.addEventListener('input', () => {
    if (selected) { selected = null; opts.onChange?.(null); }
    render();
  });
  input.addEventListener('blur', () => { list.hidden = true; });

  return {
    el: h('div', { class: 'picker' }, input, list),
    value: () => selected,
    set: choose,
  };
}
