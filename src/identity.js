// Who is this Google account? Pure (no DOM / Firebase), unit-tested.
// `people` = { a: { name, email }, b: { name, email } } (see firebaseConfig.js PEOPLE).

export const NOT_ALLOWED_MESSAGE = 'This Google account is not on the allowlist';

// 'a' | 'b' | null. Emails are compared trimmed and lowercase; empty configured emails never match.
export function personForEmail(email, people) {
  const e = String(email || '').trim().toLowerCase();
  if (!e) return null;
  for (const p of ['a', 'b']) {
    const allowed = String((people[p] && people[p].email) || '').trim().toLowerCase();
    if (allowed && allowed === e) return p;
  }
  return null;
}

// -> { ok: true, me: 'a'|'b' } | { ok: false, error }.
// `user.localPerson` (set only by the dev LocalBackend) is honoured only when `allowLocal` is true.
export function resolveUser(user, people, { allowLocal = false } = {}) {
  if (!user) return { ok: false, error: '' };
  if (allowLocal && (user.localPerson === 'a' || user.localPerson === 'b')) return { ok: true, me: user.localPerson };
  if (user.emailVerified === false) return { ok: false, error: NOT_ALLOWED_MESSAGE };
  const me = personForEmail(user.email, people);
  return me ? { ok: true, me } : { ok: false, error: NOT_ALLOWED_MESSAGE };
}
