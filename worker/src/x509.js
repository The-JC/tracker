// Minimal DER walk: PEM certificate -> SubjectPublicKeyInfo bytes (for crypto.subtle.importKey('spki')).
// We never validate the certificate chain: Google publishes the signing certs at a fixed HTTPS URL and
// trust comes from that TLS connection, exactly like firebase-admin does.
import { b64urlDecode } from './encoding.js';

function readTLV(buf, pos) {
  if (pos + 2 > buf.length) throw new Error('DER truncated');
  const tag = buf[pos];
  let len = buf[pos + 1];
  let p = pos + 2;
  if (len & 0x80) {
    const n = len & 0x7f;
    if (n < 1 || n > 4 || p + n > buf.length) throw new Error('DER bad length');
    len = 0;
    for (let i = 0; i < n; i++) len = len * 256 + buf[p + i];
    p += n;
  }
  if (p + len > buf.length) throw new Error('DER overrun');
  return { tag, header: pos, start: p, end: p + len };
}

export function pemToDer(pem) {
  const m = /-----BEGIN CERTIFICATE-----([\s\S]+?)-----END CERTIFICATE-----/.exec(pem);
  if (!m) throw new Error('not a PEM certificate');
  return b64urlDecode(m[1].replace(/\s+/g, ''));
}

// Certificate ::= SEQ { tbsCertificate SEQ { [0] version?, serial, sigAlg, issuer, validity, subject, SPKI, ... }, ... }
export function spkiFromCertDer(der) {
  const cert = readTLV(der, 0);
  if (cert.tag !== 0x30) throw new Error('certificate is not a SEQUENCE');
  const tbs = readTLV(der, cert.start);
  if (tbs.tag !== 0x30) throw new Error('tbsCertificate is not a SEQUENCE');
  let pos = tbs.start;
  let el = readTLV(der, pos);
  if (el.tag === 0xa0) { pos = el.end; el = readTLV(der, pos); } // optional explicit version
  pos = el.end; // serialNumber
  for (let i = 0; i < 4; i++) pos = readTLV(der, pos).end; // signature, issuer, validity, subject
  const spki = readTLV(der, pos);
  if (spki.tag !== 0x30) throw new Error('SPKI is not a SEQUENCE');
  return der.slice(spki.header, spki.end);
}

export const spkiFromPem = pem => spkiFromCertDer(pemToDer(pem));

export function importRsaVerifyKey(pem) {
  return crypto.subtle.importKey('spki', spkiFromPem(pem), { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' }, false, ['verify']);
}
