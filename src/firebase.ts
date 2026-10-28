import { initializeApp, type FirebaseApp } from 'firebase/app';
import { getAuth, type Auth } from 'firebase/auth';
import { initializeFirestore, persistentLocalCache, type Firestore } from 'firebase/firestore';
import { firebaseConfig } from './firebase-config';

export interface FirebaseServices {
  app: FirebaseApp;
  auth: Auth;
  db: Firestore;
}

let services: FirebaseServices | null = null;

export function isConfigured(): boolean {
  return firebaseConfig !== null;
}

export function getFirebase(): FirebaseServices {
  if (!firebaseConfig) throw new Error('Firebase is not configured yet. See src/firebase-config.ts.');
  if (!services) {
    const app = initializeApp(firebaseConfig);
    services = {
      app,
      auth: getAuth(app),
      // Local cache lets the finds list open offline, e.g. at a trailhead with no signal.
      db: initializeFirestore(app, { localCache: persistentLocalCache() }),
    };
  }
  return services;
}
