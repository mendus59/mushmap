import type { FirebaseOptions } from 'firebase/app';

/**
 * Web app config from Firebase console → Project settings → Your apps.
 * These values are public identifiers, not secrets; access is controlled by
 * firestore.rules and the authorized domains list in Firebase Authentication.
 */
export const firebaseConfig: FirebaseOptions | null = {
  apiKey: 'AIzaSyB0vp7CC5-odpqafERx_-3TKcLDreW0208',
  authDomain: 'mushmap-d80f3.firebaseapp.com',
  projectId: 'mushmap-d80f3',
  storageBucket: 'mushmap-d80f3.firebasestorage.app',
  messagingSenderId: '704374691644',
  appId: '1:704374691644:web:285a58089feea290b23039',
};
