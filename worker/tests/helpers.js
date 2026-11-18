import { generateKeyPairSync, createSign, createECDH, randomBytes } from 'node:crypto';

export const PROJECT = 'trailhead-hellner-tracker';
export const ENV = {
  PROJECT_ID: PROJECT,
  DB_URL: 'https://db.example.test',
  PERSON_A_EMAIL: 'person-a@example.test',
  PERSON_B_EMAIL: 'Person-B@Example.test', // mixed case on purpose
  ALLOWED_ORIGINS: 'https://*.pages.dev,http://localhost:5173',
  VAPID_SUBJECT: 'mailto:test@example.test'
};

/* ---- tiny DER encoder to fake a certificate that embeds a real SPKI ---- */
const len = n => (n < 128 ? [n] : n < 256 ? [0x81, n] : [0x82, n >> 8, n & 255]);
const tlv = (tag, ...parts) => {
  const body = Buffer.concat(parts);
  return Buffer.concat([Buffer.from([tag, ...len(body.length)]), body]);
};
const seq = (...p) => tlv(0x30, ...p);
const sigAlg = seq(tlv(0x06, Buffer.from('2a864886f70d01010b', 'hex')), tlv(0x05));
const name = cn => seq(tlv(0x31, seq(tlv(0x06, Buffer.from('550403', 'hex')), tlv(0x0c, Buffer.from(cn)))));

export function fakeCertPem(spkiDer) {
  const tbs = seq(
    tlv(0xa0, tlv(0x02, Buffer.from([2]))), tlv(0x02, Buffer.from([0x01, 0x00])),
    sigAlg, name('issuer'),
    seq(tlv(0x17, Buffer.from('240101000000Z')), tlv(0x17, Buffer.from('340101000000Z'))),
    name('subject'), spkiDer
  );
  const cert = seq(tbs, sigAlg, tlv(0x03, Buffer.from([0, 1, 2, 3])));
  const b64 = cert.toString('base64').match(/.{1,64}/g).join('\n');
  return `-----BEGIN CERTIFICATE-----\n${b64}\n-----END CERTIFICATE-----\n`;
}

export function makeIssuer(kid = 'kid1') {
  const { privateKey, publicKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
  const pem = fakeCertPem(publicKey.export({ type: 'spki', format: 'der' }));
  const b64u = b => Buffer.from(b).toString('base64url');
  return {
    kid, pem,
    getCerts: async () => ({ [kid]: pem }),
    mint(claims = {}, { header = {}, nowS = Math.floor(Date.now() / 1000) } = {}) {
      const payload = {
        iss: `https://securetoken.google.com/${PROJECT}`, aud: PROJECT, sub: 'uid-1', iat: nowS - 10,
        auth_time: nowS - 10, exp: nowS + 3000, email: 'person-a@example.test', email_verified: true, ...claims
      };
      for (const k of Object.keys(payload)) if (payload[k] === undefined) delete payload[k];
      const h = b64u(JSON.stringify({ alg: 'RS256', kid, typ: 'JWT', ...header }));
      const p = b64u(JSON.stringify(payload));
      const sig = createSign('RSA-SHA256').update(h + '.' + p).sign(privateKey);
      return `${h}.${p}.${b64u(sig)}`;
    }
  };
}

// Fresh VAPID key pair in the env format of the Worker.
export async function vapid() {
  const kp = await crypto.subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, true, ['sign', 'verify']);
  const jwk = await crypto.subtle.exportKey('jwk', kp.privateKey);
  return {
    VAPID_PRIVATE_KEY: jwk.d,
    VAPID_PUBLIC_KEY: Buffer.concat([Buffer.from([4]), Buffer.from(jwk.x, 'base64url'), Buffer.from(jwk.y, 'base64url')]).toString('base64url')
  };
}

// A browser push subscription as stored in pushSubs/<person>/<hash>.
export function makeSub(host = 'push.example.test') {
  const e = createECDH('prime256v1'); e.generateKeys();
  return { endpoint: `https://${host}/` + randomBytes(4).toString('hex'), keys: { p256dh: e.getPublicKey().toString('base64url'), auth: randomBytes(16).toString('base64url') }, ts: 1 };
}
