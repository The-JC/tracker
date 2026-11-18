import { createCertSource } from './firebaseToken.js';
import { defaultSeen, defaultTestSeen, handleRequest } from './handler.js';

// Module-level state survives between requests inside one isolate (certificate cache, replay guard).
const getCerts = createCertSource((...a) => fetch(...a), () => Date.now());

export default {
  fetch(request, env) {
    return handleRequest(request, env, {
      fetchFn: (...a) => fetch(...a), now: () => Date.now(), getCerts, seen: defaultSeen, testSeen: defaultTestSeen
    });
  }
};
