import { h, clear } from '../dom';
import { mergeMeta, readPhotoMeta } from '../exif';
import { MAX_PHOTOS_PER_FIND, lookupElevation, saveFind, type ClusterSize, type FindInput } from '../finds';
import { blobToBytes, compressPhoto, type CompressedPhoto } from '../image';
import { groupNotes } from '../legal';
import { createMap, maplibregl } from '../map';
import { describeSpeciesId, type Catalog } from '../species';
import { speciesPicker } from '../speciesPicker';

function toLocalInputValue(d: Date): string {
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

export interface AddFindOptions {
  onSaved: () => void;
  onCancel?: () => void;
}

const SOURCE_LABELS: Record<FindInput['locationSource'], string> = {
  exif: 'from photo',
  manual: 'set by hand',
  device: 'your current location',
  none: '',
};

export function addFindView(uid: string, catalog: Catalog, { onSaved, onCancel }: AddFindOptions): HTMLElement {
  let photos: CompressedPhoto[] = [];
  let position: { lat: number; lon: number } | null = null;
  let locationSource: FindInput['locationSource'] = 'none';

  const status = h('p', { class: 'status', role: 'status' });
  const previews = h('div', { class: 'previews' });
  const fileInput = h('input', { type: 'file', accept: 'image/*', multiple: true });
  // Phone galleries often strip GPS from photos handed to a browser. The plain
  // file browser (no image filter) skips the gallery and can keep it.
  const filesInput = h('input', { type: 'file', multiple: true, hidden: true });
  const browseFiles = h('button', { type: 'button', class: 'link', onclick: () => filesInput.click() },
    'Location missing? Pick the photo from Files instead');
  const useMyLocation = h('button', { type: 'button' }, 'Use my current location');
  const takenAt = h('input', { type: 'datetime-local', required: true });
  const locationText = h('p', { class: 'muted' }, 'No location yet. Add a photo with GPS, or tap the map to drop a pin.');
  const mapEl = h('div', { class: 'map small' });
  const legalSlot = h('div');

  const picker = speciesPicker(catalog, {
    placeholder: 'Search species, e.g. morel, chanterelle, Boletus edulis',
    onChange: (o) => {
      clear(legalSlot);
      if (o) legalSlot.append(...groupNotes(describeSpeciesId(catalog, o.id)?.group));
    },
  });
  const useCustom = h('input', { type: 'checkbox' });
  const customName = h('input', { type: 'text', placeholder: 'Your name for it', hidden: true });
  useCustom.addEventListener('change', () => {
    customName.hidden = !useCustom.checked;
    picker.el.hidden = useCustom.checked;
  });

  const cluster = (value: ClusterSize, label: string) =>
    h('label', { class: 'chip' }, h('input', { type: 'radio', name: 'cluster', value }), label);
  const treeBoxes = catalog.trees.map((t) => h('label', { class: 'chip' }, h('input', { type: 'checkbox', value: t }), t));
  const otherTrees = h('input', { type: 'text', placeholder: 'Other trees, comma separated' });
  const plants = h('input', { type: 'text', placeholder: 'e.g. salal, Oregon grape, moss' });
  const substrate = h('input', { type: 'text', placeholder: 'e.g. soil, buried wood, wood chips' });
  const habitat = h('input', { type: 'text', placeholder: 'e.g. second-growth Douglas-fir, north slope' });
  const notes = h('textarea', { rows: 4, placeholder: 'Anything else worth remembering' });
  const saveButton = h('button', { type: 'submit', class: 'primary' }, 'Save find');

  // Map with a draggable pin; tapping the map moves it.
  const map = createMap(mapEl);
  const marker = new maplibregl.Marker({ draggable: true, color: '#b5542c' });
  const setPosition = (lat: number, lon: number, source: FindInput['locationSource'], fly = false) => {
    position = { lat, lon };
    locationSource = source;
    marker.setLngLat([lon, lat]).addTo(map);
    locationText.textContent = `${lat.toFixed(5)}, ${lon.toFixed(5)} (${SOURCE_LABELS[source]})`;
    if (fly) map.flyTo({ center: [lon, lat], zoom: 12 });
  };
  map.on('click', (e) => setPosition(e.lngLat.lat, e.lngLat.lng, 'manual'));
  marker.on('dragend', () => {
    const p = marker.getLngLat();
    setPosition(p.lat, p.lng, 'manual');
  });

  useMyLocation.addEventListener('click', () => {
    if (!navigator.geolocation) { locationText.textContent = 'This browser cannot share its location. Tap the map instead.'; return; }
    useMyLocation.disabled = true;
    locationText.textContent = 'Finding you…';
    navigator.geolocation.getCurrentPosition(
      (p) => { useMyLocation.disabled = false; setPosition(p.coords.latitude, p.coords.longitude, 'device', true); },
      () => {
        useMyLocation.disabled = false;
        locationText.textContent = 'Could not get your location. Tap the map to drop a pin.';
      },
      { enableHighAccuracy: true, timeout: 15_000 },
    );
  });

  const handleFiles = async (input: HTMLInputElement) => {
    const files = [...(input.files ?? [])].slice(0, MAX_PHOTOS_PER_FIND);
    if (!files.length) return;
    status.textContent = 'Reading photos…';
    saveButton.disabled = true;
    try {
      // Read time and GPS from the original files; the shrunk copies carry no EXIF.
      const meta = mergeMeta(await Promise.all(files.map(readPhotoMeta)));
      if (meta.takenAt) takenAt.value = toLocalInputValue(meta.takenAt);
      if (meta.lat !== null && meta.lon !== null) setPosition(meta.lat, meta.lon, 'exif', true);
      const found = [meta.takenAt && 'time', meta.lat !== null && 'location'].filter(Boolean).join(' and ');
      let message = found
        ? `Filled in the ${found} from the photo. Check before saving.`
        : 'This photo has no time or location data. Fill them in below.';
      if (meta.lat === null) {
        message += ' Your phone may have removed the location when sharing the photo.'
          + ' Pick it from Files, use your current location, or tap the map.';
      }

      const results = await Promise.allSettled(files.map(compressPhoto));
      photos = results.flatMap((r) => (r.status === 'fulfilled' ? [r.value] : []));
      clear(previews);
      for (const p of photos) previews.append(h('img', { src: URL.createObjectURL(p.thumb), alt: 'Photo preview' }));
      const failed = results.length - photos.length;
      if (failed) message += ` ${failed} photo${failed > 1 ? 's' : ''} could not be opened by this browser (HEIC?) and will not be saved.`;
      if (input.files && input.files.length > MAX_PHOTOS_PER_FIND) {
        message += ` Only the first ${MAX_PHOTOS_PER_FIND} photos are kept.`;
      }
      status.textContent = message;
      browseFiles.hidden = meta.lat !== null;
    } catch (e) {
      status.textContent = `Could not read that photo: ${e instanceof Error ? e.message : e}`;
    } finally {
      saveButton.disabled = false;
    }
  };
  fileInput.addEventListener('change', () => handleFiles(fileInput));
  filesInput.addEventListener('change', () => handleFiles(filesInput));

  const form = h('form', {
    class: 'card',
    onsubmit: async (e: Event) => {
      e.preventDefault();
      const species = picker.value();
      if (!useCustom.checked && !species) { status.textContent = 'Pick a species, or tick "Not in the list".'; return; }
      if (useCustom.checked && !customName.value.trim()) { status.textContent = 'Enter a name for this find.'; return; }
      saveButton.disabled = true;
      status.textContent = 'Saving…';
      try {
        const trees = [
          ...treeBoxes.map((l) => l.querySelector('input')!).filter((i) => i.checked).map((i) => i.value),
          ...otherTrees.value.split(',').map((s) => s.trim()).filter(Boolean),
        ];
        const input: FindInput = {
          takenAt: takenAt.value ? new Date(takenAt.value) : null,
          lat: position?.lat ?? null,
          lon: position?.lon ?? null,
          elevationM: position ? await lookupElevation(position.lat, position.lon) : null,
          locationSource,
          speciesId: useCustom.checked ? null : species!.id,
          customName: useCustom.checked ? customName.value.trim() : null,
          clusterSize: (form.querySelector<HTMLInputElement>('input[name=cluster]:checked')?.value as ClusterSize) ?? null,
          nearbyTrees: trees,
          nearbyPlants: plants.value.trim(),
          substrate: substrate.value.trim(),
          habitat: habitat.value.trim(),
          notes: notes.value.trim(),
        };
        const full = await Promise.all(photos.map((p) => blobToBytes(p.full)));
        const thumb = photos[0] ? await blobToBytes(photos[0].thumb) : null;
        await saveFind(uid, input, full, thumb);
        onSaved();
      } catch (err) {
        status.textContent = `Could not save: ${err instanceof Error ? err.message : err}`;
        saveButton.disabled = false;
      }
    },
  },
  h('h2', {}, 'Log a find'),
  h('label', { class: 'field' }, h('span', {}, 'Photos'), fileInput),
  h('div', { class: 'row' }, browseFiles, filesInput),
  previews,
  status,
  h('label', { class: 'field' }, h('span', {}, 'When'), takenAt),
  h('div', { class: 'field' }, h('span', {}, 'Where'), locationText, h('div', { class: 'row' }, useMyLocation), mapEl),
  h('div', { class: 'field' }, h('span', {}, 'Species'), picker.el,
    h('label', { class: 'inline' }, useCustom, ' Not in the list'), customName, legalSlot),
  h('fieldset', {}, h('legend', {}, 'Growth'),
    cluster('solitary', 'Solitary'), cluster('small', 'Small cluster'), cluster('large', 'Large cluster')),
  h('fieldset', {}, h('legend', {}, 'Trees nearby'), h('div', { class: 'chips' }, ...treeBoxes), otherTrees),
  h('label', { class: 'field' }, h('span', {}, 'Other plants nearby'), plants),
  h('label', { class: 'field' }, h('span', {}, 'Growing on'), substrate),
  h('label', { class: 'field' }, h('span', {}, 'Habitat'), habitat),
  h('label', { class: 'field' }, h('span', {}, 'Notes'), notes),
  h('div', { class: 'row' }, saveButton,
    onCancel ? h('button', { type: 'button', onclick: onCancel }, 'Cancel') : null),
  );

  // MapLibre needs a resize once the container is attached and laid out.
  requestAnimationFrame(() => map.resize());
  return form;
}
