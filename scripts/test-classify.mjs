/**
 * test-classify.mjs — the edge cases the five fixtures do not cover.
 *
 * scripts/test-fixtures.mjs runs the classifier over everything the app
 * replays. This file covers the shapes those do not happen to produce: the
 * refusal that looks like an agreement, a run that never became a call,
 * evidence pointing both ways, and a yes with nothing behind it.
 *
 * Every payload here uses the SHAPE of a real response — `result.summary`,
 * `result.outcome`, `result.transcript` — because that is the shape the live
 * API returns. The earlier version of this file asserted a flat
 * `{status, structured, transcript}` object that the documentation described
 * and the API has never sent.
 *
 * The cost ladder these assertions encode, worst first:
 *   a false ACCEPT     ends the cascade, shift unfilled, everyone stood down
 *   a false DECLINE    passes over a willing person and rings the next one
 *   an AMBIGUOUS hold  costs a supervisor thirty seconds
 */
import assert from 'node:assert/strict';
import { classify } from '../server/calle.js';
import { RESULT } from '../server/cascade.js';

let passed = 0; let failed = 0;
const test = (n, f) => { try { f(); passed += 1; console.log(`  ok    ${n}`); } catch (e) { failed += 1; console.log(`  FAIL  ${n}\n        ${e.message}`); } };

/** A response in the real shape. */
const run = ({ summary = '', evidence = [], transcript = '', done = false, status = 'COMPLETED', callStatus = 'finished' }) => ({
  status,
  result: {
    summary,
    transcript,
    outcome: { task_completed: done, evidence, completion_confidence: { score: done ? 0.95 : 0.2 } },
    extracted: { calling: { calls: [{ status: callStatus, duration_seconds: 20 }] } },
  },
});

console.log('\nclassify — edge cases\n');

test('a refusal that contains "take" is still a refusal', () => {
  // The trap: "cannot take" contains "take", and the accept branch looks for
  // "will take". Refusal is checked first, deliberately.
  const r = classify(run({ summary: 'The person said they cannot take the shift.', done: false }));
  assert.equal(r.result, RESULT.DECLINE);
  assert.notEqual(r.unparsed, true);
});

test('an agreement needs the run\'s own completion flag behind it', () => {
  // Summary says agreed, but the run did not complete the task. That
  // combination is a half-finished call, not a filled shift.
  const r = classify(run({ summary: 'The person agreed to take the shift.', done: false }));
  assert.notEqual(r.result, RESULT.ACCEPT);
});

test('an agreement with the flag set is an accept, and carries the time', () => {
  const r = classify(run({
    summary: 'The person agreed to take the early shift and will arrive at 05:40.',
    evidence: ['They provided an arrival time of 05:40.'], done: true,
  }));
  assert.equal(r.result, RESULT.ACCEPT);
  assert.equal(r.arrivesAtLocal, '05:40');
  assert.equal(r.confidence, 0.95);
});

test('an accept with no time spoken still accepts, with no time', () => {
  const r = classify(run({ summary: 'The person agreed to take the shift.', done: true }));
  assert.equal(r.result, RESULT.ACCEPT);
  assert.equal(r.arrivesAtLocal, null);
});

test('a callback outranks the "no acceptance was obtained" wording beside it', () => {
  // A callback summary always also says no acceptance was obtained, which on
  // its own reads as a refusal. Callback is checked first.
  const r = classify(run({
    summary: 'The person asked to be called back in 45 minutes. No acceptance was obtained.',
  }));
  assert.equal(r.result, RESULT.CALLBACK);
  assert.equal(r.callbackInMinutes, 45);
});

test('a callback in hours is converted to minutes', () => {
  const r = classify(run({ summary: 'They asked for a callback in 2 hours.' }));
  assert.equal(r.result, RESULT.CALLBACK);
  assert.equal(r.callbackInMinutes, 120);
});

test('a callback with no time named defaults to ten minutes', () => {
  const r = classify(run({ summary: 'They asked to be called back later.' }));
  assert.equal(r.result, RESULT.CALLBACK);
  assert.equal(r.callbackInMinutes, 10);
});

test('voicemail is a no-answer even when the run says COMPLETED', () => {
  const r = classify(run({ summary: 'The call reached voicemail and a message was left.', callStatus: 'finished' }));
  assert.equal(r.result, RESULT.NO_ANSWER);
  assert.equal(r.reachedVoicemail, true);
});

test('the German voicemail greeting is recognised from the transcript alone', () => {
  const r = classify(run({
    summary: '', transcript: '[00:00:05] USER: Guten Tag, Sie haben die Mailbox erreicht. Bitte hinterlassen Sie eine Nachricht nach dem Ton.',
  }));
  assert.equal(r.result, RESULT.NO_ANSWER);
});

test('a failed run is a failure, not a decline', () => {
  assert.equal(classify(run({ status: 'FAILED' })).result, RESULT.FAILED);
  assert.equal(classify(run({ callStatus: 'invalid_number' })).result, RESULT.FAILED);
  assert.equal(classify(null).result, RESULT.FAILED);
  assert.equal(classify(undefined).result, RESULT.FAILED);
});

test('a German refusal in the transcript is read when the summary is silent', () => {
  const r = classify(run({ summary: '', transcript: '[00:00:17] USER: Nein, das schaffe ich am Sonntag leider nicht.' }));
  assert.equal(r.result, RESULT.DECLINE);
});

test('a bare yes in the transcript, with nothing behind it, is held not filled', () => {
  // The weakest possible evidence for the most expensive decision available.
  // No summary, no completion flag — just a word. It stops for a person
  // instead of standing the whole list down.
  const r = classify(run({ summary: '', transcript: '[00:00:18] USER: Ja, klar, das kann ich machen.' }));
  assert.equal(r.result, RESULT.AMBIGUOUS);
  assert.ok(r.why);
});

test('the agent\'s own agreeable script is not read as the callee agreeing', () => {
  // The bot opens with "Hallo" and closes with "Super, danke" — and says "Ja,
  // gerne" when a callee asks for a callback. Matching the whole transcript
  // classifies the agent congratulating itself as a filled shift.
  const r = classify(run({
    summary: '',
    transcript: [
      '[00:00:00] BOT: Hallo.',
      '[00:00:04] USER: [unverständlich]',
      '[00:00:12] BOT: Ja, gerne. Super, danke, auf Wiederhören.',
    ].join('\n'),
  }));
  assert.notEqual(r.result, RESULT.ACCEPT);
  assert.equal(r.result, RESULT.AMBIGUOUS);
});

test('an unreadable call is AMBIGUOUS, never a decline', () => {
  // The correction at the centre of this file. A decline ADVANCES the cascade,
  // so recording an unreadable call as one meant it was operationally a no —
  // the `unparsed` flag that used to sit beside it changed nothing.
  const r = classify(run({ summary: '', transcript: '[00:00:03] USER: mmhm ... [inaudible]' }));
  assert.equal(r.result, RESULT.AMBIGUOUS);
  assert.notEqual(r.result, RESULT.DECLINE);
  assert.ok(r.why, 'a hold must state why');
});

test('evidence pointing both ways is held, not silently resolved to a no', () => {
  // Checking refusal before agreement is right when only one of them is
  // present. When BOTH are, it is not caution, it is a coin toss that always
  // lands the same way — and the person who said yes is passed over.
  const r = classify(run({
    summary: 'The person agreed to take the shift.',
    evidence: ['They said they cannot take the Sunday shift.'],
    done: true,
  }));
  assert.equal(r.result, RESULT.AMBIGUOUS);
});

test('an agreement the run does not stand behind is held, not accepted', () => {
  // Same payload as the "needs the completion flag" case above, checked from
  // the other side: not accepting it is necessary but not sufficient. Calling
  // it a decline would pass over someone who very likely said yes.
  const r = classify(run({ summary: 'The person agreed to take the shift.', done: false }));
  assert.equal(r.result, RESULT.AMBIGUOUS);
});

test('an empty completed run never becomes an accept', () => {
  const r = classify(run({}));
  assert.notEqual(r.result, RESULT.ACCEPT);
  assert.equal(r.result, RESULT.AMBIGUOUS);
});

test('a clear refusal is still a plain decline — holds are for doubt only', () => {
  // The counterweight to everything above. A hold costs a supervisor's
  // attention at 05:40; handing them one for an answer that was perfectly
  // clear teaches them to stop reading the holds that matter.
  for (const summary of [
    'The person said they cannot take the shift.',
    'The person declined the shift.',
    'They are not available on Sunday.',
  ]) {
    assert.equal(classify(run({ summary, done: true })).result, RESULT.DECLINE, summary);
  }
});

test('the old flat shape still classifies, so a hand-written fixture works', () => {
  const r = classify({ structured: { decision: 'accept', arrives_at: '2026-08-23T05:50:00Z' } });
  assert.equal(r.result, RESULT.ACCEPT);
  assert.equal(r.arrivesAtLocal, '05:50');
});

console.log(`\n${passed} passed, ${failed} failed\n`);
process.exit(failed === 0 ? 0 : 1);
