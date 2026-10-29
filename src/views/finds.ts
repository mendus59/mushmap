import type { GeoJSONSource, Map as MapLibreMap } from 'maplibre-gl';
import { h, clear } from '../dom';
import { emptyFilter, matchesFilter, type FindFilter } from '../filters';
import { deleteFind, listFinds, listPhotos, type Find } from '../finds';
import { bytesToUrl } from '../image';
import { groupNotes } from '../legal';
import { createMap } from '../map';
import { describeSpeciesId, expandSpeciesId, type Catalog } from '../species';
import { speciesPicker } from '../speciesPicker';
import { addFindView } from './addFind';

const CLUSTER_LABELS = { solitary: 'Solitary', small: 'Small cluster', large: 'Large cluster' } as const;

function findName(catalog: Catalog, f: Find): string {
  if (f.speciesId) return describeSpeciesId(catalog, f.speciesId)?.label ?? f.speciesId;
  return f.customName ?? 'Unnamed find';
}

function formatDate(d: Date | null): string {
  return d ? d.toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' }) : 'No date';
}

export function findsView(uid: string, catalog: Catalog, { startLogging = false } = {}): HTMLElement {
  let all: Find[] = [];
  let mode: 'list' | 'map' = 'list';
  const filter: FindFilter = emptyFilter();

  const count = h('p', { class: 'muted' });
  const listEl = h('ul', { class: 'finds' });
  const mapEl = h('div', { class: 'map large', hidden: true });
  const dialog = h('dialog', { class: 'detail' });
  let map: MapLibreMap | null = null;

  const from = h('input', { type: 'date', 'aria-label': 'From date' });
  const to = h('input', { type: 'date', 'aria-label': 'To date' });
  const text = h('input', { type: 'search', placeholder: 'Search names and notes' });
  const inMapArea = h('input', { type: 'checkbox' });
  const nearMe = h('select', { 'aria-label': 'Distance from me' },
    h('option', { value: '' }, 'Any distance'),
    h('option', { value: '5' }, 'Within 5 km of me'),
    h('option', { value: '25' }, 'Within 25 km of me'),
    h('option', { value: '100' }, 'Within 100 km of me'));
  const picker = speciesPicker(catalog, {
    placeholder: 'Any species or group',
    onChange: (o) => { filter.speciesIds = o ? expandSpeciesId(catalog, o.id) : null; render(); },
  });

  const visible = () => all.filter((f) => matchesFilter(f, filter));

  const showDetail = async (f: Find) => {
    const gallery = h('div', { class: 'gallery' }, h('p', { class: 'muted' }, 'Loading photos…'));
    const group = f.speciesId ? describeSpeciesId(catalog, f.speciesId)?.group : undefined;
    const row = (label: string, value: string | null | undefined) =>
      value ? h('div', {}, h('dt', {}, label), h('dd', {}, value)) : null;
    clear(dialog);
    dialog.append(h('div', {},
      h('h2', {}, findName(catalog, f)),
      gallery,
      ...groupNotes(group),
      h('dl', {},
        row('When', formatDate(f.takenAt)),
        row('Where', f.lat !== null ? `${f.lat.toFixed(5)}, ${f.lon!.toFixed(5)}` : null),
        row('Elevation', f.elevationM !== null ? `${f.elevationM} m (${Math.round(f.elevationM * 3.281)} ft)` : null),
        row('Growth', f.clusterSize ? CLUSTER_LABELS[f.clusterSize] : null),
        row('Trees nearby', f.nearbyTrees.join(', ')),
        row('Other plants', f.nearbyPlants),
        row('Growing on', f.substrate),
        row('Habitat', f.habitat),
        row('Notes', f.notes)),
      h('div', { class: 'row' },
        h('button', { onclick: () => dialog.close() }, 'Close'),
        h('button', {
          class: 'danger',
          onclick: async () => {
            if (!confirm('Delete this find and its photos?')) return;
            await deleteFind(uid, f);
            dialog.close();
            await load();
          },
        }, 'Delete'))),
    );
    dialog.showModal();
    try {
      const photos = await listPhotos(uid, f.id);
      clear(gallery);
      for (const p of photos) gallery.append(h('img', { src: bytesToUrl(p), alt: findName(catalog, f) }));
      if (!photos.length) gallery.append(h('p', { class: 'muted' }, 'No photos'));
    } catch (e) {
      gallery.textContent = `Could not load photos: ${e instanceof Error ? e.message : e}`;
    }
  };

  const renderList = (finds: Find[]) => {
    clear(listEl);
    for (const f of finds) {
      listEl.append(h('li', {},
        h('button', { class: 'find', onclick: () => showDetail(f) },
          f.thumb ? h('img', { src: bytesToUrl(f.thumb), alt: '' }) : h('div', { class: 'noimg' }),
          h('div', {},
            h('strong', {}, findName(catalog, f)),
            h('span', { class: 'muted' }, formatDate(f.takenAt)),
            f.clusterSize ? h('span', { class: 'muted' }, CLUSTER_LABELS[f.clusterSize]) : null))));
    }
    if (!finds.length) listEl.append(h('li', { class: 'empty' }, all.length ? 'No finds match these filters.' : 'No finds yet. Log your first one!'));
  };

  const ensureMap = (): MapLibreMap => {
    if (map) return map;
    const m = createMap(mapEl);
    map = m;
    m.on('load', () => {
      m.addSource('finds', { type: 'geojson', data: { type: 'FeatureCollection', features: [] }, cluster: true, clusterRadius: 40 });
      m.addLayer({ id: 'clusters', type: 'circle', source: 'finds', filter: ['has', 'point_count'],
        paint: { 'circle-color': '#b5542c', 'circle-radius': ['step', ['get', 'point_count'], 14, 10, 20, 50, 26], 'circle-opacity': 0.85 } });
      m.addLayer({ id: 'cluster-count', type: 'symbol', source: 'finds', filter: ['has', 'point_count'],
        layout: { 'text-field': ['get', 'point_count_abbreviated'], 'text-size': 12 }, paint: { 'text-color': '#fff' } });
      m.addLayer({ id: 'points', type: 'circle', source: 'finds', filter: ['!', ['has', 'point_count']],
        paint: { 'circle-color': '#b5542c', 'circle-radius': 7, 'circle-stroke-width': 2, 'circle-stroke-color': '#fff' } });
      m.on('click', 'points', (e) => {
        const id = e.features?.[0]?.properties?.id;
        const f = all.find((x) => x.id === id);
        if (f) showDetail(f);
      });
      m.on('click', 'clusters', (e) => {
        m.easeTo({ center: e.lngLat, zoom: m.getZoom() + 2 });
      });
      renderMap(visible());
    });
    m.on('moveend', () => { if (inMapArea.checked) { setBoundsFromMap(); render(); } });
    return m;
  };

  const renderMap = (finds: Find[]) => {
    const source = map?.getSource('finds') as GeoJSONSource | undefined;
    source?.setData({
      type: 'FeatureCollection',
      features: finds.filter((f) => f.lat !== null && f.lon !== null).map((f) => ({
        type: 'Feature',
        geometry: { type: 'Point', coordinates: [f.lon!, f.lat!] },
        properties: { id: f.id },
      })),
    });
  };

  const setBoundsFromMap = () => {
    const b = ensureMap().getBounds();
    filter.bounds = { west: b.getWest(), south: b.getSouth(), east: b.getEast(), north: b.getNorth() };
  };

  function render() {
    const finds = visible();
    count.textContent = `${finds.length} of ${all.length} finds`;
    renderList(finds);
    renderMap(finds);
  }

  async function load() {
    count.textContent = 'Loading…';
    try {
      all = await listFinds(uid);
      render();
    } catch (e) {
      count.textContent = `Could not load finds: ${e instanceof Error ? e.message : e}`;
    }
  }

  const setMode = (next: 'list' | 'map') => {
    mode = next;
    listEl.hidden = mode !== 'list';
    mapEl.hidden = mode !== 'map';
    listTab.classList.toggle('active', mode === 'list');
    mapTab.classList.toggle('active', mode === 'map');
    if (mode === 'map') requestAnimationFrame(() => ensureMap().resize());
  };
  const listTab = h('button', { class: 'tab active', onclick: () => setMode('list') }, 'List');
  const mapTab = h('button', { class: 'tab', onclick: () => setMode('map') }, 'Map');

  from.addEventListener('change', () => { filter.from = from.value || null; render(); });
  to.addEventListener('change', () => { filter.to = to.value || null; render(); });
  text.addEventListener('input', () => { filter.text = text.value; render(); });
  inMapArea.addEventListener('change', () => {
    if (inMapArea.checked) { setMode('map'); setBoundsFromMap(); } else { filter.bounds = null; }
    render();
  });
  nearMe.addEventListener('change', () => {
    const km = Number(nearMe.value);
    if (!km) { filter.near = null; render(); return; }
    navigator.geolocation.getCurrentPosition(
      (p) => { filter.near = { lat: p.coords.latitude, lon: p.coords.longitude, radiusKm: km }; render(); },
      () => { nearMe.value = ''; alert('Could not get your location.'); },
    );
  });

  // Logging a find happens on this page: the form opens above the journal.
  const logSlot = h('div');
  const logButton = h('button', { class: 'primary' }, '+ Log a find');
  const closeLog = () => {
    clear(logSlot);
    logButton.hidden = false;
    if (location.hash === '#/add') history.replaceState(null, '', '#/finds');
  };
  const openLog = () => {
    logButton.hidden = true;
    clear(logSlot);
    logSlot.append(addFindView(uid, catalog, {
      onSaved: () => { closeLog(); load(); },
      onCancel: closeLog,
    }));
    logSlot.scrollIntoView({ behavior: 'smooth', block: 'start' });
  };
  logButton.addEventListener('click', openLog);
  if (startLogging) requestAnimationFrame(openLog);

  load();

  return h('section', {},
    h('div', { class: 'row between' }, h('h1', {}, 'My finds'), logButton),
    logSlot,
    h('div', { class: 'card filters' },
      h('label', { class: 'field' }, h('span', {}, 'Species'), picker.el),
      h('div', { class: 'row' },
        h('label', { class: 'field' }, h('span', {}, 'From'), from),
        h('label', { class: 'field' }, h('span', {}, 'To'), to)),
      h('label', { class: 'field' }, h('span', {}, 'Text'), text),
      h('div', { class: 'row' },
        nearMe,
        h('label', { class: 'inline' }, inMapArea, ' Only finds in the map area'))),
    h('div', { class: 'row between' }, count, h('div', { class: 'tabs' }, listTab, mapTab)),
    listEl,
    mapEl,
    dialog,
  );
}
