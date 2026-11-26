import { onAuthStateChanged, signOut, type User } from 'firebase/auth';
import { h, clear } from './dom';
import { getFirebase, isConfigured } from './firebase';
import { loadCatalog } from './species';
import { signInView } from './views/signIn';
import './style.css';
import './pwa';

const app = document.getElementById('app')!;
const nav = document.getElementById('nav')!;
let user: User | null = null;

type Route = 'finds' | 'add' | 'heatmap' | 'trails';
// Signed-out visitors land on the map, which needs no account.
const currentRoute = (): Route => {
  const r = location.hash.replace(/^#\/?/, '');
  if (r === 'add' || r === 'heatmap' || r === 'trails' || r === 'finds') return r;
  return user ? 'finds' : 'heatmap';
};

function renderNav() {
  clear(nav);
  if (!isConfigured()) return;
  const link = (route: Route, label: string, also: Route[] = [route]) =>
    h('a', { href: `#/${route}`, class: also.includes(currentRoute()) ? 'active' : '' }, label);
  nav.append(
    link('finds', 'My finds', ['finds', 'add']),
    link('heatmap', 'Map', ['heatmap', 'trails']),
    user
      ? h('button', { class: 'link', onclick: () => signOut(getFirebase().auth) }, 'Sign out')
      : h('a', { href: '#/finds', class: 'signin' }, 'Sign in'),
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
  const route = currentRoute();
  if (!user && route !== 'heatmap' && route !== 'trails') {
    app.append(signInView());
    return;
  }
  const catalog = await loadCatalog();
  const uid = user ? user.uid : null;
  // Views load on demand so the map library is not in the first download.
  // The trail finder and heat map share one page; #/trails is kept for old links.
  switch (route) {
    case 'heatmap':
    case 'trails': {
      const { forageMapView } = await import('./views/forageMap');
      app.append(forageMapView(catalog, uid));
      break;
    }
    default: {
      // #/add is kept for old links: it opens the journal with the log form showing.
      const { findsView } = await import('./views/finds');
      app.append(findsView(uid!, catalog, { startLogging: route === 'add' }));
    }
  }
}

window.addEventListener('hashchange', render);
if (isConfigured()) {
  onAuthStateChanged(getFirebase().auth, (u) => { user = u; render(); });
} else {
  render();
}
