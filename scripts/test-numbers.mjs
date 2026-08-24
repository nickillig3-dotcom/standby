/**
 * test-numbers.mjs — no number in this repository can ring.
 *
 * Scans every text file in the repository, pulls out anything shaped like a
 * telephone number, and fails unless it falls inside a range a regulator or a
 * network operator has permanently withheld from allocation.
 *
 *     node scripts/test-numbers.mjs
 *
 * WHY A SCANNER AND NOT A CODE REVIEW
 *
 * This repository has already shipped two numbers it should not have. One was a
 * real German mobile, sitting in a test file as a negative assertion — a line
 * checking that the number did NOT appear in the fixtures, which published it
 * on the line doing the checking. The other was a run of zeroes behind a live
 * 0152 prefix, across the whole demo roster, chosen because it looks obviously
 * fake. It is not: 0152 is a live German mobile prefix and every number in it
 * is either allocated already or waiting to be.
 *
 * Both got past a careful author reading carefully. "Looks fake" is not a
 * property a phone number has, and neither is "obviously a placeholder", so the
 * check is mechanical and runs in `npm test`.
 *
 * THE RANGES, AND WHO WITHHELD THEM
 *
 *   +49 176 040690 00–99   German mobile operators, media use     (100 numbers)
 *   +49 171 39200 00–99    German mobile operators, media use     (100 numbers)
 *   +49 30 23125 000–999   Bundesnetzagentur, Berlin drama block
 *   +49 69 90009 000–999   Bundesnetzagentur, Frankfurt
 *   +49 40 66969 000–999   Bundesnetzagentur, Hamburg
 *   +49 221 4710 000–999   Bundesnetzagentur, Cologne
 *   +49 89 99998 000–999   Bundesnetzagentur, Munich
 *   +44 7700 900000–900999 Ofcom, drama mobile
 *   +44 1632 960000–960999 Ofcom, drama geographic
 *   +1 NPA 555 0100–0199   NANPA, fictional use
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(HERE, '..');

const SKIP_DIRS = new Set(['node_modules', '.git', 'out', 'docs', 'captures', '.github']);
const TEXT = new Set(['.js', '.mjs', '.cjs', '.json', '.md', '.html', '.css', '.txt', '.yml', '.yaml', '.svg']);

/** A number is acceptable only if it matches one of these, in E.164 digits. */
const RESERVED = [
  { re: /^\+49176040690\d{2}$/, who: 'DE mobile operators — media block 0176 040690 00-99' },
  { re: /^\+4917139200\d{2}$/, who: 'DE mobile operators — media block 0171 39200 00-99' },
  { re: /^\+493023125\d{3}$/, who: 'Bundesnetzagentur — Berlin drama block' },
  { re: /^\+496990009\d{3}$/, who: 'Bundesnetzagentur — Frankfurt drama block' },
  { re: /^\+494066969\d{3}$/, who: 'Bundesnetzagentur — Hamburg drama block' },
  { re: /^\+492214710\d{3}$/, who: 'Bundesnetzagentur — Cologne drama block' },
  { re: /^\+498999998\d{3}$/, who: 'Bundesnetzagentur — Munich drama block' },
  { re: /^\+447700900\d{3}$/, who: 'Ofcom — drama mobile' },
  { re: /^\+441632960\d{3}$/, who: 'Ofcom — drama geographic' },
  { re: /^\+1\d{3}55501\d{2}$/, who: 'NANPA — 555-0100 to 555-0199, fictional use' },
];

/**
 * Two shapes, because a leak takes either.
 *   international   +49 176 040690 00
 *   German national 0176 04069000
 * Anything else — a date, a version, an id — has no leading + and no leading
 * German mobile prefix, and is left alone.
 */
// `\s` is deliberately not used: it matches a newline, so a number at the end
// of one line swallows the digits at the start of the next and reports a
// nonsense fifteen-digit failure. A phone number does not wrap.
const INTERNATIONAL = /\+\d[\d \t().\-/]{6,}\d/g;
const DE_NATIONAL = /\b0(?:1[5-7]\d)[ \t\-/]?\d{6,}\b/g;

const toE164 = (raw) => {
  const digits = raw.replace(/[^\d+]/g, '');
  return digits.startsWith('+') ? digits : `+49${digits.slice(1)}`;
};

/**
 * Prose and constants name a reserved RANGE, not a number: "+49 176 040690
 * 00-99" in a comment, or the `RESERVED_BLOCK` constant the roster is built
 * from. Those are too short to dial and cannot reach anyone, so they are
 * allowed — but only as an exact prefix of a range above. "+49 152 000 000" is
 * not a prefix of anything reserved and still fails, which is the point.
 */
const BLOCK_PREFIXES = [
  '+49176040690', '+4917139200', '+493023125', '+496990009', '+494066969',
  '+492214710', '+498999998', '+447700900', '+441632960',
];
const namesARange = (e164) => BLOCK_PREFIXES.some((p) => p.startsWith(e164));

function walk(dir, out = []) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (entry.name.startsWith('.') && entry.name !== '.gitignore') continue;
    if (entry.isDirectory()) {
      if (SKIP_DIRS.has(entry.name)) continue;
      walk(path.join(dir, entry.name), out);
    } else if (TEXT.has(path.extname(entry.name)) || !path.extname(entry.name)) {
      out.push(path.join(dir, entry.name));
    }
  }
  return out;
}

const files = walk(ROOT);
const offences = [];
let checked = 0;
let found = 0;

for (const file of files) {
  let text;
  try { text = fs.readFileSync(file, 'utf8'); } catch { continue; }
  checked += 1;
  const rel = path.relative(ROOT, file).replace(/\\/g, '/');
  // This file lists the reserved ranges as regular expressions, which are not
  // numbers. Skipping it is not an exemption: every range it allows is
  // exercised by the files that actually use one.
  if (rel === 'scripts/test-numbers.mjs') continue;

  for (const re of [INTERNATIONAL, DE_NATIONAL]) {
    for (const m of text.matchAll(re)) {
      const e164 = toE164(m[0]);
      if (e164.replace(/\D/g, '').length < 9) continue; // too short to be a number
      found += 1;
      if (!RESERVED.some((r) => r.re.test(e164)) && !namesARange(e164)) {
        const line = text.slice(0, m.index).split('\n').length;
        offences.push({ rel, line, raw: m[0].trim(), e164 });
      }
    }
  }
}

console.log('\nphone numbers\n');
console.log(`  ${checked} text files scanned, ${found} number-shaped strings found`);

if (offences.length) {
  console.log('\n  NOT IN A RESERVED RANGE:\n');
  for (const o of offences) console.log(`  FAIL  ${o.rel}:${o.line}  "${o.raw}"  ->  ${o.e164}`);
  console.log('\n  Replace these with a number from a withheld range — see the header of');
  console.log('  this file, or RESERVED_BLOCK in server/demo.js.\n');
  process.exit(1);
}

console.log('  ok    every one of them is in a permanently withheld range\n');
