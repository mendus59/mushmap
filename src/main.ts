import { onAuthStateChanged, signOut, type User } from 'firebase/auth';
import { h, clear } from './dom';
import { getFirebase, isConfigured } from './firebase';
import { loadCatalog } from './species';
import { signInView } from './views/signIn';
import './style.css';

const app = document.getElementById('app')!;
const nav = document.getElementById('nav')!;
let user: User | null = null;

type Route = 'finds' | 'add' | 'heatmap' | 'trails';
const currentRoute = (): Route => {
  const r = location.hash.replace(/^#\/?/, '');
  return r === 'add' || r === 'heatmap' || r === 'trails' ? r : 'finds';
};

function renderNav() {
  clear(nav);
  if (!user) return;
  const link = (route: Route, label: string, also: Route[] = [route]) =>
    h('a', { href: `#/${route}`, class: also.includes(currentRoute()) ? 'active' : '' }, label);
  nav.append(
    link('finds', 'My finds'),
    link('add', 'Log a find'),
    link('heatmap', 'Map', ['heatmap', 'trails']),
    h('button', { class: 'link', onclick: () => signOut(getFirebase().auth) }, 'Sign out'),
  );
}

async function render() {
  renderNav();
  clear(app);
  if (!isConfigured()) {
    app.append(h('section', { class: 'card narrow' },
      h('h1', {}, 'Almost there'),
      h('p', {}, 'MushMap needs its Firebase web config. Paste it into src/firebase-config.ts and redeploy.')));
    return;
  }
  if (!user) {
    app.append(signInView());
    return;
  }
  const catalog = await loadCatalog();
  const uid = user.uid;
  // Views load on demand so the map library is not in the first download.
  // The trail finder and heat map share one page; #/trails is kept for old links.
  switch (currentRoute()) {
    case 'add': {
      const { addFindView } = await import('./views/addFind');
      app.append(addFindView(uid, catalog, () => { location.hash = '#/finds'; }));
      break;
    }
    case 'heatmap':
    case 'trails': {
      const { forageMapView } = await import('./views/forageMap');
      app.append(forageMapView(catalog, uid));
      break;
    }
    default: {
      const { findsView } = await import('./views/finds');
      app.append(findsView(uid, catalog));
    }
  }
}

window.addEventListener('hashchange', render);
if (isConfigured()) {
  onAuthStateChanged(getFirebase().auth, (u) => { user = u; render(); });
} else {
  render();
}
