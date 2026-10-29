import { h } from './dom';

// Lets MushMap be installed to a home screen and open offline (see pwa/sw.js).

interface InstallPromptEvent extends Event {
  prompt(): Promise<void>;
  userChoice: Promise<{ outcome: 'accepted' | 'dismissed' }>;
}

if (import.meta.env.PROD && 'serviceWorker' in navigator) {
  window.addEventListener('load', () => {
    navigator.serviceWorker.register(`${import.meta.env.BASE_URL}sw.js`).catch((err) => {
      console.warn('Service worker not registered', err);
    });
  });
}

// Chrome, Edge and Android offer an install prompt; show a button for it in the top bar.
// Safari has no prompt, so iPhone users add it with Share > Add to Home Screen.
let installButton: HTMLButtonElement | null = null;
window.addEventListener('beforeinstallprompt', (e) => {
  e.preventDefault();
  const prompt = e as InstallPromptEvent;
  installButton?.remove();
  installButton = h('button', {
    class: 'link install',
    onclick: async () => {
      await prompt.prompt();
      await prompt.userChoice;
      installButton?.remove();
      installButton = null;
    },
  }, 'Install app');
  document.querySelector('.topbar')?.append(installButton);
});
window.addEventListener('appinstalled', () => {
  installButton?.remove();
  installButton = null;
});
