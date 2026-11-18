// Single place for everything project-specific. To move to a NEW Firebase project, either
// edit the defaults below or (better) create `.env.local` with the VITE_* variables:
//   VITE_FIREBASE_API_KEY, VITE_FIREBASE_AUTH_DOMAIN, VITE_FIREBASE_DATABASE_URL,
//   VITE_FIREBASE_PROJECT_ID, VITE_FIREBASE_STORAGE_BUCKET,
//   VITE_FIREBASE_MESSAGING_SENDER_ID, VITE_FIREBASE_APP_ID,
//   VITE_PERSON_A_EMAIL, VITE_PERSON_B_EMAIL (the two Google accounts allowed in), VITE_DB_ROOT, VITE_MESSAGES_ROOT,
//   VITE_PUSH_URL (Cloudflare Worker base URL), VITE_VAPID_PUBLIC_KEY (Web Push; both optional: empty = no system push)
// Defaults are the NEW project's values (trailhead-hellner-tracker; its database starts empty, so the legacy migration just sets its flag) (the web API key is public by design; access is
// protected by Auth + Realtime Database rules).
const env = (typeof import.meta !== 'undefined' && import.meta.env) || {};

export const firebaseConfig = {
  apiKey: env.VITE_FIREBASE_API_KEY || '',
  authDomain: env.VITE_FIREBASE_AUTH_DOMAIN || 'trailhead-hellner-tracker.firebaseapp.com',
  databaseURL: env.VITE_FIREBASE_DATABASE_URL || 'https://trailhead-hellner-tracker-default-rtdb.europe-west1.firebasedatabase.app',
  projectId: env.VITE_FIREBASE_PROJECT_ID || 'trailhead-hellner-tracker',
  storageBucket: env.VITE_FIREBASE_STORAGE_BUCKET || 'trailhead-hellner-tracker.firebasestorage.app',
  messagingSenderId: env.VITE_FIREBASE_MESSAGING_SENDER_ID || '650074959953',
  appId: env.VITE_FIREBASE_APP_ID || '1:650074959953:web:f75fa985073d0faeeac870'
};

// The two people. Signing in with Google maps the account's email (compared lowercase) to a/b;
// any other account is denied. The names are only defaults: they can be edited in Settings.
// Also put the same two emails into database.rules.json (placeholders __EMAIL_A__ / __EMAIL_B__).
export const PEOPLE = {
  a: { name: 'Beatrix', email: env.VITE_PERSON_A_EMAIL || '' },
  b: { name: 'Julian', email: env.VITE_PERSON_B_EMAIL || '' }
};

// Realtime Database roots (unchanged from the original app).
export const DB_ROOT = env.VITE_DB_ROOT || 'trailhead-tracker-v1';
export const MESSAGES_ROOT = env.VITE_MESSAGES_ROOT || 'trailhead-tracker-v1-messages';

// Web Push (worker/README.md). Empty values disable push; in-app toasts keep working.
export const PUSH_URL = (env.VITE_PUSH_URL || '').trim();
export const VAPID_PUBLIC_KEY = (env.VITE_VAPID_PUBLIC_KEY || '').trim();
