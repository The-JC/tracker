import { createCertSource } from './firebaseToken.js';
import { defaultSeen, defaultTestSeen, handleRequest } from './handler.js';
import { parseServiceAccount, createTokenSource } from './serviceAccount.js';
import { runReminders } from './reminders.js';

// Module-level state survives between requests inside one isolate (certificate cache, replay guard, OAuth token).
const getCerts = createCertSource((...a) => fetch(...a), () => Date.now());

let tokenSource = null, tokenSourceSecret = null;
function getTokenFn(env) {
  const raw = env.FIREBASE_SERVICE_ACCOUNT;
  if (!raw) return null;
  if (tokenSource && tokenSourceSecret === raw) return tokenSource;
  const account = parseServiceAccount(raw);
  if (!account) return null;
  tokenSource = createTokenSource({ account, fetchFn: (...a) => fetch(...a), now: () => Date.now() });
  tokenSourceSecret = raw;
  return tokenSource;
}

export default {
  fetch(request, env) {
    return handleRequest(request, env, {
      fetchFn: (...a) => fetch(...a), now: () => Date.now(), getCerts, seen: defaultSeen, testSeen: defaultTestSeen
    });
  },
  // Cron Trigger (wrangler.toml [triggers]): daily run reminders. runReminders never throws.
  scheduled(event, env, ctx) {
    const job = runReminders(env, { fetchFn: (...a) => fetch(...a), now: () => Date.now(), getToken: getTokenFn(env) });
    if (ctx && typeof ctx.waitUntil === 'function') ctx.waitUntil(job);
    return job;
  }
};
