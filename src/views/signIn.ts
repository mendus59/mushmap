import {
  GoogleAuthProvider, createUserWithEmailAndPassword, signInWithEmailAndPassword, signInWithPopup,
} from 'firebase/auth';
import { h } from '../dom';
import { getFirebase } from '../firebase';

export function signInView(): HTMLElement {
  const { auth } = getFirebase();
  const error = h('p', { class: 'error', role: 'alert' });
  const email = h('input', { type: 'email', required: true, autocomplete: 'email', placeholder: 'Email' });
  const password = h('input', { type: 'password', required: true, minlength: 6, autocomplete: 'current-password', placeholder: 'Password' });

  const run = async (action: () => Promise<unknown>) => {
    error.textContent = '';
    try {
      await action();
    } catch (e) {
      error.textContent = e instanceof Error ? e.message.replace(/^Firebase: /, '') : String(e);
    }
  };

  return h('section', { class: 'card narrow' },
    h('h1', {}, 'Sign in to MushMap'),
    h('p', {}, 'Your finds and photos are private to your account.'),
    h('button', { class: 'primary wide', onclick: () => run(() => signInWithPopup(auth, new GoogleAuthProvider())) }, 'Continue with Google'),
    h('p', { class: 'divider' }, 'or use email'),
    h('form', {
      onsubmit: (e: Event) => {
        e.preventDefault();
        run(() => signInWithEmailAndPassword(auth, email.value, password.value));
      },
    },
    email, password,
    h('div', { class: 'row' },
      h('button', { type: 'submit' }, 'Sign in'),
      h('button', {
        type: 'button',
        onclick: () => run(() => createUserWithEmailAndPassword(auth, email.value, password.value)),
      }, 'Create account'))),
    error,
  );
}
