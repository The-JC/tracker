// Renders database.rules.json (gitignored) from database.rules.template.json.
// The two allowed Google emails come from VITE_PERSON_A_EMAIL / VITE_PERSON_B_EMAIL
// (environment or .env.local), so they never need to be committed.
import { readFileSync, writeFileSync, existsSync } from 'node:fs';

function loadEnvFile(path) {
  if (!existsSync(path)) return {};
  return Object.fromEntries(
    readFileSync(path, 'utf8')
      .split('\n')
      .map(line => line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*?)\s*$/))
      .filter(Boolean)
      .map(([, key, value]) => [key, value.replace(/^['"]|['"]$/g, '')])
  );
}

const env = { ...loadEnvFile('.env.local'), ...process.env };
const emailA = (env.VITE_PERSON_A_EMAIL || '').trim().toLowerCase();
const emailB = (env.VITE_PERSON_B_EMAIL || '').trim().toLowerCase();
const valid = email => /^[^\s@']+@[^\s@']+\.[^\s@']+$/.test(email);

if (!valid(emailA) || !valid(emailB)) {
  console.error('Set VITE_PERSON_A_EMAIL and VITE_PERSON_B_EMAIL (in .env.local or the environment).');
  process.exit(1);
}

const template = readFileSync('database.rules.template.json', 'utf8');
writeFileSync('database.rules.json', template.replaceAll('__EMAIL_A__', emailA).replaceAll('__EMAIL_B__', emailB));
console.log('Wrote database.rules.json');
