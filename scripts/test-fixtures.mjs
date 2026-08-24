/**
 * test-fixtures.mjs — the classifier, against every fixture the app replays.
 *
 * The fixtures are AUTHORED, not recorded: written against the CALL-E response
 * shape by scripts/make-fixtures.mjs, which `npm test` also runs in --check
 * mode so the files on disk are provably the generator's output and nothing
 * else. Nothing here came out of a real conversation.
 *
 * That is a deliberate downgrade from what this file used to test. It used to
 * assert against four genuine captures, which had one real advantage: a change
 * to the CALL-E response shape would break the replay loudly. Authored fixtures
 * agree with themselves for ever, so shape drift is now caught only by
 * CALLE_LIVE=1 against the live API. The trade is the right way round — a
 * fixture that detects an API change is worth less than a public repository
 * that does not republish a person's voice.
 *
 *   node scripts/test-fixtures.mjs
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { classify } from '../server/calle.js';
import { RESULT } from '../server/cascade.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const DIR = path.join(HERE, '..', 'fixtures', 'calls');
const load = (n) => JSON.parse(fs.readFileSync(path.join(DIR, n), 'utf8'));
const names = () => fs.readdirSync(DIR).filter((n) => n.endsWith('.json'));

let passed = 0, failed = 0;
const test = (n, f) => { try { f(); passed++; console.log(`  ok    ${n}`); } catch (e) { failed++; console.log(`  FAIL  ${n}\n        ${e.message}`); } };

console.log('\nfixtures\n');

test('a yes is an accept, with the arrival time the caller spoke', () => {
  const r = classify(load('04-accept.json').raw);
  assert.equal(r.result, RESULT.ACCEPT);
  // "Ja, das mache ich. Ich bin um zehn vor sechs da." -> 05:50 in the summary.
  assert.equal(r.arrivesAtLocal, '05:50');
});

test('a no is a decline, and not a hold', () => {
  const r = classify(load('02-decline.json').raw);
  assert.equal(r.result, RESULT.DECLINE);
  // A plain refusal must not fall through into "we could not tell" — that
  // would stop the cascade for a person over an answer that was perfectly
  // clear, and a hold nobody needed is its own kind of failure.
  assert.notEqual(r.result, RESULT.AMBIGUOUS);
});

test('"in 20 Minuten noch mal" is a callback, carrying the twenty minutes', () => {
  const r = classify(load('03-callback.json').raw);
  assert.equal(r.result, RESULT.CALLBACK);
  assert.equal(r.callbackInMinutes, 20);
});

test('voicemail is a no-answer, not an accept and not a decline', () => {
  // The trap the fixture exists for: the run says COMPLETED and the call says
  // finished, because a message WAS delivered. Nobody agreed to anything.
  const f = load('01-no-answer.json');
  assert.equal(f.raw.status, 'COMPLETED');
  assert.equal(f.raw.result.extracted.calling.calls[0].status, 'finished');
  const r = classify(f.raw);
  assert.equal(r.result, RESULT.NO_ANSWER);
  assert.equal(r.reachedVoicemail, true);
});

test('a dropped, unintelligible call is AMBIGUOUS — not a decline', () => {
  // The whole of blocker 2, in one assertion. This used to classify as a
  // decline with a flag beside it, and the cascade rang the next name.
  const r = classify(load('05-unreadable.json').raw);
  assert.equal(r.result, RESULT.AMBIGUOUS);
  assert.ok(r.why, 'a hold with no stated reason is a shrug');
});

test('every fixture is authored, and says so in the file', () => {
  for (const name of names()) {
    const f = load(name);
    assert.equal(f.synthetic, true, `${name} is not marked synthetic`);
    assert.ok(f.authoredAt, `${name} has no authoredAt`);
    assert.equal(f.recordedAt, undefined, `${name} still carries a recordedAt — is it a capture?`);
    assert.match(f.note, /not a recording/i, `${name} does not state its provenance`);
  }
});

test('no fixture carries a provider identifier that could be looked up', () => {
  // Synthetic ids are readable words on purpose. A fabricated hex id in a
  // public repo is indistinguishable from a real one, and somebody will
  // eventually try to resolve it against the provider.
  for (const name of names()) {
    const f = load(name);
    const ids = [f.raw.run_id, f.raw.result.call_id, ...(f.raw.result.call_ids ?? [])];
    for (const id of ids) {
      assert.match(String(id), /^synthetic-/, `${name}: "${id}" does not announce itself as synthetic`);
    }
    assert.ok(!/[0-9a-f]{16,}/i.test(JSON.stringify(f)), `${name} contains a hash-shaped identifier`);
  }
});

test('every fixture dials a permanently withheld number', () => {
  // scripts/test-numbers.mjs enforces this across the whole repository; this is
  // the same rule asserted where a leak would actually have landed.
  for (const name of names()) {
    for (const p of load(name).raw.result.extracted.to_phones) {
      assert.match(p, /^\+49176040690\d{2}$/, `${name}: ${p} is not in the reserved media block`);
    }
  }
});

console.log(`\n${passed} passed, ${failed} failed\n`);
process.exit(failed === 0 ? 0 : 1);
