/**
 * test-cascade.mjs — the cascade's behaviour, proved without a phone.
 *
 * Every claim the submission makes about the cascade is asserted here, so a
 * judge can verify the interesting part in two seconds and without an account:
 *
 *   node scripts/test-cascade.mjs
 */
import assert from 'node:assert/strict';
import { planCascade, nextAction, applyEvent, finishIfDone, summarise, RESULT, OUTCOME, SKIP } from '../server/cascade.js';
import { RESERVED_BLOCK } from '../server/demo.js';

/** +49 176 040690 nn - a block the German networks keep permanently unassigned. */
const reserved = (nn) => `${RESERVED_BLOCK}${String(nn).padStart(2, '0')}`;

let passed = 0;
let failed = 0;
const test = (name, fn) => {
  try { fn(); passed += 1; console.log(`  ok    ${name}`); }
  catch (err) { failed += 1; console.log(`  FAIL  ${name}\n        ${err.message}`); }
};

const T = (h, m = 0) => Date.UTC(2026, 7, 23, h, m); // 23 Aug 2026, UTC
const SHIFT_START = T(6);

const roster = (n = 5, over = {}) => Array.from({ length: n }, (_, i) => ({
  id: `p${i + 1}`, name: `Person ${i + 1}`, phone: reserved(40 + i), ...(over[`p${i + 1}`] ?? {}),
}));

const base = (over = {}) => planCascade({
  shift: { id: 'shift-1', startsAt: SHIFT_START, timeZone: 'UTC', role: 'Early shift', ...(over.shift ?? {}) },
  roster: over.roster ?? roster(),
  policy: over.policy ?? {},
  now: over.now ?? T(4, 40),
});

const call = (s, id, at) => applyEvent(s, { type: 'call_started', candidateId: id, callRunId: `run-${id}`, at });
const result = (s, id, r, at, extra = {}) => applyEvent(s, { type: 'call_result', candidateId: id, result: r, at, ...extra });

console.log('\ncascade\n');

test('calls the roster in order, one at a time', () => {
  let s = base();
  assert.equal(nextAction(s, T(4, 40)).candidate.id, 'p1');
  s = call(s, 'p1', T(4, 40));
  s = result(s, 'p1', RESULT.DECLINE, T(4, 41));
  assert.equal(nextAction(s, T(4, 41)).candidate.id, 'p2');
});

test('refuses a second call while one is in flight — the whole point', () => {
  let s = base();
  s = call(s, 'p1', T(4, 40));
  assert.throws(() => call(s, 'p2', T(4, 40)), /strictly sequential/);
});

test('stops dead on the first accept and stands the rest down', () => {
  let s = base();
  s = call(s, 'p1', T(4, 40));
  s = result(s, 'p1', RESULT.DECLINE, T(4, 41));
  s = call(s, 'p2', T(4, 42));
  s = result(s, 'p2', RESULT.ACCEPT, T(4, 44), { arrivesAt: T(5, 50) });

  assert.equal(nextAction(s, T(4, 45)).type, 'done');
  assert.equal(s.outcome, OUTCOME.FILLED);
  assert.equal(s.filledBy, 'p2');
  assert.deepEqual(s.candidates.filter((c) => c.state === 'stood_down').map((c) => c.id), ['p3', 'p4', 'p5']);
  const sum = summarise(s);
  assert.equal(sum.calls, 2);
  assert.equal(sum.callsAvoided, 3);
  assert.equal(sum.filledBy.arrivesAt, T(5, 50));
});

test('a no-answer waits for the retry pass, it does not redial immediately', () => {
  let s = base();
  s = call(s, 'p1', T(4, 40));
  s = result(s, 'p1', RESULT.NO_ANSWER, T(4, 41));
  // p1 is queued again, but pass 2 — so p2 (pass 1) goes first.
  assert.equal(nextAction(s, T(4, 41)).candidate.id, 'p2');
  assert.equal(s.candidates.find((c) => c.id === 'p1').pass, 2);
});

test('the retry pass runs only after everyone untried has been tried', () => {
  let s = base({ roster: roster(3) });
  for (const id of ['p1', 'p2', 'p3']) {
    s = call(s, id, T(4, 40));
    s = result(s, id, RESULT.NO_ANSWER, T(4, 41));
  }
  const a = nextAction(s, T(4, 42));
  assert.equal(a.type, 'call');
  assert.equal(a.candidate.id, 'p1');
  assert.equal(a.candidate.pass, 2);
});

test('nobody is rung a third time', () => {
  let s = base({ roster: roster(1) });
  s = call(s, 'p1', T(4, 40));
  s = result(s, 'p1', RESULT.NO_ANSWER, T(4, 41));
  s = call(s, 'p1', T(4, 45));
  s = result(s, 'p1', RESULT.NO_ANSWER, T(4, 46));
  assert.equal(nextAction(s, T(4, 47)).type, 'done');
  s = finishIfDone(s, T(4, 47));
  assert.equal(s.outcome, OUTCOME.EXHAUSTED);
});

test('a callback is honoured at the named time and outranks untried names', () => {
  let s = base();
  s = call(s, 'p1', T(4, 40));
  s = result(s, 'p1', RESULT.CALLBACK, T(4, 41), { callbackAt: T(5, 0) });

  // Before the callback is due, carry on down the list.
  assert.equal(nextAction(s, T(4, 42)).candidate.id, 'p2');
  // Once due, p1 jumps ahead of the untried p2.
  assert.equal(nextAction(s, T(5, 1)).candidate.id, 'p1');
});

test('a second callback from the same person is treated as a decline', () => {
  let s = base();
  s = call(s, 'p1', T(4, 40));
  s = result(s, 'p1', RESULT.CALLBACK, T(4, 41), { callbackAt: T(4, 50) });
  s = call(s, 'p1', T(4, 50));
  s = result(s, 'p1', RESULT.CALLBACK, T(4, 51), { callbackAt: T(5, 30) });
  assert.equal(s.candidates.find((c) => c.id === 'p1').state, 'declined');
});

test('opted-out and unreachable people are skipped with a stated reason', () => {
  let s = base({ roster: roster(3, { p1: { optedOut: true }, p2: { phone: null } }) });

  let a = nextAction(s, T(4, 40));
  assert.equal(a.type, 'skip');
  assert.equal(a.reason, SKIP.OPTED_OUT);
  s = applyEvent(s, { type: 'skipped', candidateId: 'p1', reason: a.reason, at: T(4, 40) });

  a = nextAction(s, T(4, 40));
  assert.equal(a.reason, SKIP.NO_PHONE);
  s = applyEvent(s, { type: 'skipped', candidateId: 'p2', reason: a.reason, at: T(4, 40) });

  assert.equal(nextAction(s, T(4, 40)).candidate.id, 'p3');
});

test('quiet hours block the list, but not when the shift is imminent', () => {
  // 23:00 the night before, shift at 06:00 — seven hours out, so: wait.
  const nightBefore = Date.UTC(2026, 7, 22, 23, 0);
  const s = planCascade({
    shift: { id: 's', startsAt: SHIFT_START, timeZone: 'UTC' }, roster: roster(2), now: nightBefore,
  });
  assert.equal(nextAction(s, nightBefore).type, 'wait');
  assert.equal(nextAction(s, nightBefore).reason, SKIP.QUIET_HOURS);

  // 04:40, inside quiet hours but eighty minutes from the shift — ring them.
  assert.equal(nextAction(s, T(4, 40)).type, 'call');
});

test('quiet hours can be made absolute', () => {
  const s = planCascade({
    shift: { id: 's', startsAt: SHIFT_START, timeZone: 'UTC' },
    roster: roster(2),
    policy: { quietHoursOverrideWithinMs: null },
    now: T(4, 40),
  });
  assert.equal(nextAction(s, T(4, 40)).type, 'wait');
});

test('the shift starting ends the cascade even mid-list', () => {
  let s = base({ roster: roster(10) });
  s = call(s, 'p1', T(5, 58));
  s = result(s, 'p1', RESULT.DECLINE, T(5, 59));
  const a = nextAction(s, T(6, 1));
  assert.equal(a.type, 'done');
  assert.equal(a.outcome, OUTCOME.CUTOFF);
});

test('a cutoff margin stops dialling early', () => {
  const s = base({ roster: roster(3), policy: { cutoffBeforeShiftMs: 30 * 60 * 1000 } });
  assert.equal(nextAction(s, T(5, 20)).type, 'call');
  assert.equal(nextAction(s, T(5, 31)).outcome, OUTCOME.CUTOFF);
});

test('a failed call is terminal for that person, not for the cascade', () => {
  let s = base();
  s = call(s, 'p1', T(4, 40));
  s = result(s, 'p1', RESULT.FAILED, T(4, 41));
  assert.equal(s.candidates.find((c) => c.id === 'p1').state, 'failed');
  assert.equal(nextAction(s, T(4, 41)).candidate.id, 'p2');
});

test('maxAttempts caps a runaway cascade', () => {
  let s = base({ roster: roster(5), policy: { maxAttempts: 3, retryNoAnswer: false } });
  for (const id of ['p1', 'p2', 'p3']) {
    s = call(s, id, T(4, 40));
    s = result(s, id, RESULT.DECLINE, T(4, 41));
  }
  assert.equal(nextAction(s, T(4, 42)).outcome, OUTCOME.EXHAUSTED);
});

test('an abort is recorded and terminal', () => {
  let s = base();
  s = applyEvent(s, { type: 'aborted', at: T(4, 45), reason: 'supervisor filled it in person' });
  assert.equal(s.outcome, OUTCOME.ABORTED);
  assert.equal(nextAction(s, T(4, 46)).type, 'done');
});

test('the event log replays to the same state — the audit trail is the state', () => {
  let s = base();
  s = call(s, 'p1', T(4, 40));
  s = result(s, 'p1', RESULT.NO_ANSWER, T(4, 41));
  s = call(s, 'p2', T(4, 42));
  s = result(s, 'p2', RESULT.ACCEPT, T(4, 44), { arrivesAt: T(5, 45) });

  let replay = base();
  for (const e of s.events) replay = applyEvent(replay, e);
  assert.deepEqual(summarise(replay), summarise(s));
});

test('a cutoff is written into the state, not only computed', () => {
  let s = base({ roster: roster(4) });
  s = call(s, 'p1', T(5, 58));
  s = result(s, 'p1', RESULT.DECLINE, T(5, 59));
  s = finishIfDone(s, T(6, 1));
  assert.equal(s.outcome, OUTCOME.CUTOFF);
  // Nobody is left dangling as "queued" — an unexplained gap in the log is
  // indistinguishable from a crash.
  assert.equal(s.candidates.filter((c) => c.state === 'queued').length, 0);
  assert.deepEqual(s.candidates.filter((c) => c.skipReason === OUTCOME.CUTOFF).map((c) => c.id), ['p2', 'p3', 'p4']);
});

test('an exhausted cascade replays to an exhausted state', () => {
  let s = base({ roster: roster(2), policy: { retryNoAnswer: false } });
  for (const id of ['p1', 'p2']) {
    s = call(s, id, T(4, 40));
    s = result(s, id, RESULT.DECLINE, T(4, 41));
  }
  s = finishIfDone(s, T(4, 42));

  let replay = base({ roster: roster(2), policy: { retryNoAnswer: false } });
  for (const e of s.events) replay = applyEvent(replay, e);
  assert.equal(replay.outcome, OUTCOME.EXHAUSTED);
  assert.deepEqual(summarise(replay), summarise(s));
});

test('finishIfDone leaves a running cascade alone', () => {
  const s = base();
  assert.equal(finishIfDone(s, T(4, 40)), s);
});

test('callsAvoided counts who was stood down, not roster minus calls', () => {
  // Two are unreachable and never dialled; one is rung twice. The old
  // subtraction would report 2 avoided here when the true answer is 1.
  let s = base({ roster: roster(5, { p2: { optedOut: true }, p3: { phone: null } }) });
  s = applyEvent(s, { type: 'skipped', candidateId: 'p2', reason: SKIP.OPTED_OUT, at: T(4, 40) });
  s = applyEvent(s, { type: 'skipped', candidateId: 'p3', reason: SKIP.NO_PHONE, at: T(4, 40) });
  s = call(s, 'p1', T(4, 41));
  s = result(s, 'p1', RESULT.NO_ANSWER, T(4, 42));
  s = call(s, 'p4', T(4, 43));
  s = result(s, 'p4', RESULT.ACCEPT, T(4, 45));

  const sum = summarise(s);
  assert.equal(sum.calls, 2);
  // p1 (awaiting its retry) and p5 (never reached) were stood down. p2 and p3
  // were skipped, which is not the same thing and must not be counted.
  assert.equal(sum.callsAvoided, 2);
  assert.equal(s.candidates.filter((c) => c.state === 'skipped').length, 2);
});

test('an accept that arrives after the shift starts is flagged, not rounded away', () => {
  // The bug the browser caught: a fixture time written as UTC instead of local
  // put the replacement on site nearly two hours late, and the dashboard still
  // said "Filled" in green. The cascade still stops - a second person turning
  // up mid-shift is worse - but the shortfall has to be stated.
  let s = base();
  s = call(s, 'p1', T(4, 40));
  s = result(s, 'p1', RESULT.ACCEPT, T(4, 42), { arrivesAt: T(7, 50) });
  assert.equal(s.outcome, OUTCOME.FILLED);
  assert.equal(summarise(s).filledBy.lateByMs, 110 * 60 * 1000);
});

test('an accept before the shift is not flagged late', () => {
  let s = base();
  s = call(s, 'p1', T(4, 40));
  s = result(s, 'p1', RESULT.ACCEPT, T(4, 42), { arrivesAt: T(5, 50) });
  assert.equal(summarise(s).filledBy.lateByMs, 0);
});

test('an accept with no stated arrival time is not flagged late', () => {
  let s = base();
  s = call(s, 'p1', T(4, 40));
  s = result(s, 'p1', RESULT.ACCEPT, T(4, 42));
  assert.equal(summarise(s).filledBy.arrivesAt, null);
  assert.equal(summarise(s).filledBy.lateByMs, 0);
});

/* ── the hold: an answer nobody could read ────────────────────────────────── */

test('an unreadable answer halts the cascade instead of advancing it', () => {
  let s = base();
  s = call(s, 'p1', T(4, 40));
  s = result(s, 'p1', RESULT.AMBIGUOUS, T(4, 41), { why: 'the line dropped mid-sentence' });

  assert.equal(s.candidates.find((c) => c.id === 'p1').state, 'needs_review');
  assert.equal(s.outcome, OUTCOME.NEEDS_REVIEW);

  const a = nextAction(s, T(4, 42));
  assert.equal(a.type, 'hold');
  assert.equal(a.candidate.id, 'p1');
  assert.equal(a.reason, 'the line dropped mid-sentence');
});

test('the hold is enforced, not advised — no later call can be started', () => {
  // The rule the reviewer of PR #218 asked for, asserted the same way the
  // one-call-in-flight rule is. A guard that only lives in the runner's loop
  // is a guard every other caller walks past.
  let s = base();
  s = call(s, 'p1', T(4, 40));
  s = result(s, 'p1', RESULT.AMBIGUOUS, T(4, 41), { why: 'unintelligible' });
  assert.throws(() => call(s, 'p2', T(4, 42)), /held for human reconciliation/);
});

test('a hold stands nobody down — it is a pause, not an ending', () => {
  // An accept stands the rest of the list down because the shift is filled.
  // A hold must not: those people are still going to be rung.
  let s = base();
  s = call(s, 'p1', T(4, 40));
  s = result(s, 'p1', RESULT.AMBIGUOUS, T(4, 41), { why: 'unintelligible' });
  assert.equal(s.candidates.filter((c) => c.state === 'stood_down').length, 0);
  assert.equal(s.candidates.filter((c) => c.state === 'queued').length, 4);
  assert.equal(summarise(s).heldOn.id, 'p1');
});

test('finishIfDone will not convert a hold into an outcome', () => {
  // The failure this prevents: a held cascade quietly becoming EXHAUSTED or
  // CUTOFF while it waits, and the decision disappearing with it.
  let s = base();
  s = call(s, 'p1', T(4, 40));
  s = result(s, 'p1', RESULT.AMBIGUOUS, T(4, 41), { why: 'unintelligible' });
  assert.equal(finishIfDone(s, T(6, 30)).outcome, OUTCOME.NEEDS_REVIEW);
  assert.equal(nextAction(s, T(6, 30)).type, 'hold');
});

test('a person resolves it as a decline and the cascade carries on', () => {
  let s = base();
  s = call(s, 'p1', T(4, 40));
  s = result(s, 'p1', RESULT.AMBIGUOUS, T(4, 41), { why: 'unintelligible' });
  s = applyEvent(s, {
    type: 'reconciled', candidateId: 'p1', result: RESULT.DECLINE,
    by: 'S. Hoffmann', note: 'listened back — she said no', at: T(4, 46),
  });

  assert.equal(s.outcome, null);
  assert.equal(s.candidates.find((c) => c.id === 'p1').state, 'declined');
  assert.equal(nextAction(s, T(4, 47)).candidate.id, 'p2');

  const attempt = s.candidates.find((c) => c.id === 'p1').attempts[0];
  assert.equal(attempt.reconciledBy, 'S. Hoffmann');
  assert.equal(attempt.result, RESULT.DECLINE);
  assert.equal(attempt.heldWhy, 'unintelligible');
});

test('a person resolving it as an accept fills the shift, exactly as a read one would', () => {
  // Same state, same summary, whichever decided it — otherwise the audit log
  // is describing two different products.
  let s = base();
  s = call(s, 'p1', T(4, 40));
  s = result(s, 'p1', RESULT.AMBIGUOUS, T(4, 41), { why: 'unintelligible' });
  s = applyEvent(s, {
    type: 'reconciled', candidateId: 'p1', result: RESULT.ACCEPT,
    by: 'S. Hoffmann', at: T(4, 46), arrivesAt: T(5, 50),
  });

  assert.equal(s.outcome, OUTCOME.FILLED);
  assert.equal(s.filledBy, 'p1');
  assert.deepEqual(s.candidates.filter((c) => c.state === 'stood_down').map((c) => c.id), ['p2', 'p3', 'p4', 'p5']);
  assert.equal(summarise(s).filledBy.arrivesAt, T(5, 50));
  assert.equal(summarise(s).heldOn, null);
});

test('a reconciliation must carry a name, and cannot resolve to another hold', () => {
  let s = base();
  s = call(s, 'p1', T(4, 40));
  s = result(s, 'p1', RESULT.AMBIGUOUS, T(4, 41), { why: 'unintelligible' });

  assert.throws(() => applyEvent(s, { type: 'reconciled', candidateId: 'p1', result: RESULT.DECLINE, at: T(4, 46) }), /by/);
  assert.throws(() => applyEvent(s, { type: 'reconciled', candidateId: 'p1', result: RESULT.AMBIGUOUS, by: 'S. H.', at: T(4, 46) }), /not back to ambiguous/);
  assert.throws(() => applyEvent(s, { type: 'reconciled', candidateId: 'p1', result: 'maybe', by: 'S. H.', at: T(4, 46) }), /unknown result/);
});

test('nothing can be reconciled that was not held', () => {
  let s = base();
  s = call(s, 'p1', T(4, 40));
  s = result(s, 'p1', RESULT.DECLINE, T(4, 41));
  assert.throws(() => applyEvent(s, {
    type: 'reconciled', candidateId: 'p1', result: RESULT.ACCEPT, by: 'S. H.', at: T(4, 46),
  }), /not held for review/);
});

test('a held cascade replays from its log to the same held state', () => {
  // The audit trail has to be able to reproduce a pending decision, not only
  // finished mornings.
  let s = base();
  s = call(s, 'p1', T(4, 40));
  s = result(s, 'p1', RESULT.AMBIGUOUS, T(4, 41), { why: 'unintelligible' });

  let replay = base();
  for (const e of s.events) replay = applyEvent(replay, e);
  assert.equal(replay.outcome, OUTCOME.NEEDS_REVIEW);
  assert.deepEqual(summarise(replay), summarise(s));
});

test('a resolved hold replays, reconciliation and all', () => {
  let s = base();
  s = call(s, 'p1', T(4, 40));
  s = result(s, 'p1', RESULT.AMBIGUOUS, T(4, 41), { why: 'unintelligible' });
  s = applyEvent(s, { type: 'reconciled', candidateId: 'p1', result: RESULT.DECLINE, by: 'S. Hoffmann', at: T(4, 46) });
  s = call(s, 'p2', T(4, 47));
  s = result(s, 'p2', RESULT.ACCEPT, T(4, 49), { arrivesAt: T(5, 50) });

  let replay = base();
  for (const e of s.events) replay = applyEvent(replay, e);
  assert.deepEqual(summarise(replay), summarise(s));
  assert.equal(replay.outcome, OUTCOME.FILLED);
});

test('the shift can still start under a hold, and the cutoff applies on resume', () => {
  // The clock does not stop because somebody is thinking. A "yes" reconciled
  // after 06:00 is not a fill, and the cascade must not resume dialling.
  let s = base({ roster: roster(4) });
  s = call(s, 'p1', T(5, 55));
  s = result(s, 'p1', RESULT.AMBIGUOUS, T(5, 56), { why: 'unintelligible' });
  s = applyEvent(s, { type: 'reconciled', candidateId: 'p1', result: RESULT.DECLINE, by: 'S. H.', at: T(6, 10) });
  const a = nextAction(s, T(6, 10));
  assert.equal(a.type, 'done');
  assert.equal(a.outcome, OUTCOME.CUTOFF);
});

test('planCascade rejects nonsense rather than half-working', () => {
  assert.throws(() => planCascade({ shift: { startsAt: SHIFT_START }, roster: [], now: 0 }), /non-empty/);
  assert.throws(() => planCascade({ shift: {}, roster: roster(1), now: 0 }), /startsAt/);
  assert.throws(() => planCascade({ shift: { startsAt: SHIFT_START }, roster: roster(1) }), /now/);
});

console.log(`\n${passed} passed, ${failed} failed\n`);
process.exit(failed === 0 ? 0 : 1);
