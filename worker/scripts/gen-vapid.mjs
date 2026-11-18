// Generates a VAPID P-256 key pair. Prints to stdout only; nothing is written to disk.
//   node scripts/gen-vapid.mjs
const b64url = buf => Buffer.from(buf).toString('base64url');
const { privateKey } = await crypto.subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, true, ['sign', 'verify']);
const jwk = await crypto.subtle.exportKey('jwk', privateKey);
const point = Buffer.concat([Buffer.from([4]), Buffer.from(jwk.x, 'base64url'), Buffer.from(jwk.y, 'base64url')]);
console.log(`VAPID_PUBLIC_KEY=${b64url(point)}`);
console.log(`VAPID_PRIVATE_KEY=${jwk.d}`);
console.error('\nPublic key -> wrangler.toml [vars] VAPID_PUBLIC_KEY and the client (applicationServerKey).');
console.error('Private key -> `npx wrangler secret put VAPID_PRIVATE_KEY` (paste it). Do not commit or store it in a file.');
