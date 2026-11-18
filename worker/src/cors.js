// ALLOWED_ORIGINS: comma separated; each entry is an exact origin or `scheme://*.suffix` (any subdomain, not the apex).
export function originAllowed(origin, list) {
  if (!origin) return false;
  let o;
  try { o = new URL(origin); } catch { return false; }
  if (o.origin !== origin) return false; // reject paths, userinfo, trailing slash, "null"
  for (const raw of String(list || '').split(',')) {
    const p = raw.trim();
    if (!p) continue;
    if (p === origin) return true;
    const i = p.indexOf('://*.');
    if (i > 0) {
      const scheme = p.slice(0, i), suffix = p.slice(i + 5);
      if (o.protocol === scheme + ':' && suffix && o.host.endsWith('.' + suffix)) return true;
    }
  }
  return false;
}

export function corsHeaders(origin) {
  return {
    'Access-Control-Allow-Origin': origin,
    'Access-Control-Allow-Methods': 'POST, GET, OPTIONS',
    'Access-Control-Allow-Headers': 'Authorization, Content-Type',
    'Access-Control-Max-Age': '86400',
    Vary: 'Origin'
  };
}
