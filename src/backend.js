// Backend adapter: one small interface, two implementations.
//
//   Backend = {
//     kind: 'firebase' | 'local',
//     onAuth(cb: (user|null) => void): unsubscribe   // user = { uid, email, displayName, photoURL, emailVerified }
//     signInWithGoogle(localPerson?): Promise<void>   // popup, falling back to redirect; rejects with `.code` like Firebase Auth
//                                                     // (local backend: fake sign-in as person 'a' | 'b' | anything else = stranger)
//     redirectResult(): Promise<void>                 // call once at startup; rejects if a redirect sign-in failed
//     signOut(): Promise<void>
//     getIdToken(): Promise<string|null>              // fresh Firebase ID token (null for the local backend / signed out)
//     subscribe(path, cb(value|null), opts?): unsubscribe   // opts: { limitToLast?: number, onError?: fn }
//     get(path): Promise<value|null>
//     set(path, value) / update(path, obj) / remove(path): Promise<void>
//     newKey(path): string                     // sortable push key, no write
//     push(path, value): Promise<string>       // = set(path/newKey, value), returns key
//     claimOnce(path, value): Promise<boolean> // write `value` only if the node is empty (transaction)
//     onConnection(cb(online)): unsubscribe
//   }
//
// Paths are absolute database paths ('trailhead-tracker-v1/log'). Values are plain JSON.
// `createBackend()` picks LocalBackend for `?local=1` (dev / tests) and when Firebase fails to init;
// otherwise the Firebase modular SDK, which is loaded lazily so local mode never downloads it.
import { firebaseConfig, PEOPLE, DB_ROOT } from './firebaseConfig.js';

/* ------------------------------------------------------------------ */
/* Local backend: in-memory tree mirrored to localStorage              */
/* ------------------------------------------------------------------ */

const LOCAL_DB_KEY = 'trailhead-local-db';
const LOCAL_AUTH_KEY = 'trailhead-local-auth';

const parts = path => String(path).split('/').filter(Boolean);
const clone = v => (v === undefined ? null : JSON.parse(JSON.stringify(v)));

// Firebase semantics: null/undefined properties and empty objects are not stored.
function normalize(v) {
  if (v === undefined || v === null) return null;
  if (typeof v !== 'object') return v;
  const out = Array.isArray(v) ? [] : {};
  for (const [k, x] of Object.entries(v)) {
    const n = normalize(x);
    if (n !== null) out[k] = n;
  }
  const empty = Array.isArray(out) ? out.length === 0 : Object.keys(out).length === 0;
  return empty ? null : out;
}

let keyCounter = 0;
// Sortable like Firebase push ids: time first, then a counter + randomness.
export function makeKey() {
  const t = Date.now().toString(36).padStart(9, '0');
  const c = (keyCounter++ % 1296).toString(36).padStart(2, '0');
  const r = Math.random().toString(36).slice(2, 6).padEnd(4, '0');
  return `-${t}${c}${r}`;
}

export function createLocalBackend({ storage = safeStorage(), persist = true } = {}) {
  let tree = {};
  if (persist && storage) {
    try { tree = JSON.parse(storage.getItem(LOCAL_DB_KEY)) || {}; } catch (e) { tree = {}; }
  }
  const authListeners = new Set();
  const subs = new Set(); // { path, cb, opts }
  let user = null;
  try { user = JSON.parse(storage && storage.getItem(LOCAL_AUTH_KEY)) || null; } catch (e) { user = null; }

  const read = path => {
    let node = tree;
    for (const k of parts(path)) {
      if (node == null || typeof node !== 'object') return null;
      node = node[k];
    }
    return node === undefined ? null : node;
  };

  function write(path, value) {
    const ks = parts(path);
    const v = normalize(value);
    if (ks.length === 0) { tree = v || {}; return; }
    let node = tree;
    for (let i = 0; i < ks.length - 1; i++) {
      if (node[ks[i]] == null || typeof node[ks[i]] !== 'object') node[ks[i]] = {};
      node = node[ks[i]];
    }
    const last = ks[ks.length - 1];
    if (v === null) delete node[last]; else node[last] = v;
    // prune parents left empty (Firebase does not keep empty objects)
    for (let i = ks.length - 1; i > 0; i--) {
      const parent = ks.slice(0, i).reduce((n, k) => n[k], tree);
      if (parent && typeof parent === 'object' && Object.keys(parent).length === 0) {
        const gp = ks.slice(0, i - 1).reduce((n, k) => n[k], tree);
        delete gp[ks[i - 1]];
      } else break;
    }
  }

  function view(path, opts) {
    let v = clone(read(path));
    if (opts && opts.limitToLast && v && typeof v === 'object') {
      const keys = Object.keys(v).sort().slice(-opts.limitToLast);
      v = Object.fromEntries(keys.map(k => [k, v[k]]));
    }
    return v;
  }

  function changed(path) {
    if (persist && storage) {
      try { storage.setItem(LOCAL_DB_KEY, JSON.stringify(tree)); } catch (e) { /* quota: ignore */ }
    }
    const w = parts(path).join('/');
    for (const s of [...subs]) {
      const p = parts(s.path).join('/');
      // affected when one path is a prefix of the other
      if (w === p || w.startsWith(p + '/') || p.startsWith(w + '/') || w === '' || p === '') s.cb(view(s.path, s.opts));
    }
  }

  const be = {
    kind: 'local',
    onAuth(cb) {
      authListeners.add(cb);
      Promise.resolve().then(() => { if (authListeners.has(cb)) cb(user); });
      return () => authListeners.delete(cb);
    },
    // Dev only fake Google sign-in. 'a' / 'b' sign in as that person; any other value is an account
    // that is not on the allowlist (to test the denied screen).
    async signInWithGoogle(localPerson = 'a') {
      const person = PEOPLE[localPerson];
      user = {
        uid: `local-${localPerson}`,
        email: (person && person.email) || `${localPerson}@local.test`,
        displayName: person ? `${person.name} (local)` : 'Someone Else',
        photoURL: null, emailVerified: true,
        localPerson: person ? localPerson : null // lets the store pick a/b even when no emails are configured
      };
      try { storage && storage.setItem(LOCAL_AUTH_KEY, JSON.stringify(user)); } catch (e) { /* ignore */ }
      authListeners.forEach(cb => cb(user));
    },
    async redirectResult() {},
    async getIdToken() { return null; },
    async signOut() {
      user = null;
      try { storage && storage.removeItem(LOCAL_AUTH_KEY); } catch (e) { /* ignore */ }
      authListeners.forEach(cb => cb(null));
    },
    subscribe(path, cb, opts) {
      const s = { path, cb, opts };
      subs.add(s);
      Promise.resolve().then(() => { if (subs.has(s)) cb(view(path, opts)); });
      return () => subs.delete(s);
    },
    async get(path) { return clone(read(path)); },
    async set(path, value) { write(path, value); changed(path); },
    async update(path, obj) {
      for (const [k, v] of Object.entries(obj || {})) write(`${path}/${k}`, v);
      changed(path);
    },
    async remove(path) { write(path, null); changed(path); },
    newKey: () => makeKey(),
    async push(path, value) { const k = makeKey(); write(`${path}/${k}`, value); changed(path); return k; },
    async claimOnce(path, value) {
      if (read(path) != null) return false;
      write(path, value); changed(path);
      return true;
    },
    onConnection(cb) { Promise.resolve().then(() => cb(true)); return () => {}; },
    // internal helper for the debug hooks / tests
    _read: read
  };
  return be;
}

function safeStorage() {
  try { return globalThis.localStorage || null; } catch (e) { return null; }
}

/* ------------------------------------------------------------------ */
/* Firebase backend (modular SDK, loaded on demand)                    */
/* ------------------------------------------------------------------ */

async function createFirebaseBackend() {
  const [{ initializeApp }, A, D] = await Promise.all([
    import('firebase/app'), import('firebase/auth'), import('firebase/database')
  ]);
  const app = initializeApp(firebaseConfig);
  const auth = A.getAuth(app);
  const db = D.getDatabase(app);
  const R = p => D.ref(db, p);

  return {
    kind: 'firebase',
    onAuth: cb => A.onAuthStateChanged(auth, u => cb(u && {
      uid: u.uid, email: u.email, displayName: u.displayName, photoURL: u.photoURL, emailVerified: u.emailVerified
    })),
    // Popup first; where popups are blocked or unsupported (iOS standalone PWAs, in-app browsers) use a full-page redirect.
    async signInWithGoogle() {
      const provider = new A.GoogleAuthProvider();
      provider.setCustomParameters({ prompt: 'select_account' });
      try {
        await A.signInWithPopup(auth, provider);
      } catch (e) {
        const fallback = ['auth/popup-blocked', 'auth/operation-not-supported-in-this-environment', 'auth/web-storage-unsupported'];
        if (!fallback.includes(e && e.code)) throw e;
        await A.signInWithRedirect(auth, provider); // the page navigates away; onAuth fires after the return
      }
    },
    redirectResult: () => A.getRedirectResult(auth).then(() => {}),
    signOut: () => A.signOut(auth),
    getIdToken: async () => (auth.currentUser ? auth.currentUser.getIdToken() : null),
    subscribe(path, cb, opts = {}) {
      const q = opts.limitToLast ? D.query(R(path), D.limitToLast(opts.limitToLast)) : R(path);
      return D.onValue(q, snap => cb(snap.val()), err => (opts.onError || console.error)(err));
    },
    get: path => D.get(R(path)).then(s => s.val()),
    set: (path, value) => D.set(R(path), value),
    update: (path, obj) => D.update(R(path), obj),
    remove: path => D.remove(R(path)),
    newKey: path => D.push(R(path)).key,
    push: (path, value) => { const r = D.push(R(path)); return D.set(r, value).then(() => r.key); },
    claimOnce: (path, value) =>
      D.runTransaction(R(path), cur => (cur == null ? value : undefined)).then(r => r.committed),
    onConnection: cb => D.onValue(R('.info/connected'), s => cb(!!s.val()))
  };
}

/* ------------------------------------------------------------------ */

// -> { backend, error?: string }. `error` is set when Firebase was wanted but could not start.
export async function createBackend({ search = globalThis.location ? globalThis.location.search : '' } = {}) {
  const wantLocal = new URLSearchParams(search).get('local') === '1';
  if (wantLocal) return { backend: createLocalBackend() };
  try {
    return { backend: await createFirebaseBackend() };
  } catch (e) {
    console.error('Firebase init failed, falling back to local-only mode:', e);
    return {
      backend: createLocalBackend(),
      error: "Couldn't reach the login system — check your connection and reload. (Working offline on this device only.)"
    };
  }
}

/* ------------------------------------------------------------------ */
/* Debug hook: fake activity from the other person (?local=1 only)     */
/* ------------------------------------------------------------------ */

// Writes a log entry + event as if the other person had just logged something,
// so notifications can be tested with one browser. Exposed by store.js as
// window.__trailheadDebug.fakeEventFromOther() when running locally.
export async function fakeEventFromOther(backend, me, names = { a: 'Beatrix', b: 'Julian' }) {
  const actor = me === 'b' ? 'a' : 'b';
  const key = backend.newKey(`${DB_ROOT}/log`);
  const today = new Date();
  const date = `${today.getFullYear()}-${String(today.getMonth() + 1).padStart(2, '0')}-${String(today.getDate()).padStart(2, '0')}`;
  const km = Math.round((4 + Math.random() * 8) * 10) / 10;
  const ts = Date.now();
  await backend.set(`${DB_ROOT}/log/${key}`, {
    id: key, person: actor, sport: 'run', runType: 'easy', title: 'Test run', date, km,
    durationMin: Math.round(km * 5.5), hasPhoto: false, ts
  });
  const ek = backend.newKey(`${DB_ROOT}/events`);
  await backend.set(`${DB_ROOT}/events/${ek}`, {
    id: ek, actor, kind: 'activity', text: `${names[actor]} logged a ${km} km run`, refId: key, ts: Date.now()
  });
  return ek;
}
