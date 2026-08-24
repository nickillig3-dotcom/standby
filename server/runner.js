/**
 * runner.js — turns the cascade's decisions into actual calls.
 *
 * The cascade decides, the provider dials, the runner is the loop between
 * them. It holds no rules of its own: every "should we call this person"
 * question is answered by `nextAction`, so the behaviour proved in
 * scripts/test-cascade.mjs is the behaviour that runs in production.
 *
 * It emits events as it goes so the dashboard can watch a cascade unfold
 * rather than being handed the result at the end — that live progression is
 * what the demo video films, and it is also how a supervisor would actually
 * use it: watching, ready to stop it.
 */
import { nextAction, applyEvent, finishIfDone, summarise, RESULT, OUTCOME } from './cascade.js';
import { classify } from './calle.js';

/**
 * Turn a spoken wall-clock time into an instant.
 *
 * classify() deliberately returns "05:50" rather than an epoch: resolving it
 * needs the shift's date and timezone, which live here and not in the phone
 * layer. Doing it there is exactly how an arrival time ended up two hours out.
 *
 * The date is the shift's own day. A time earlier than the shift start is
 * before it, not the next morning - somebody saying "ten to six" for a six
 * o'clock shift means today.
 */
function resolveLocalTime(shift, hhmm) {
  if (!hhmm) return null;
  const [h, m] = hhmm.split(':').map(Number);
  const tz = shift.timeZone ?? 'UTC';
  // Find the offset that timezone had at the shift, then place the wall clock
  // against it. Intl gives the parts; no date library needed.
  const parts = new Intl.DateTimeFormat('en-GB', {
    timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit',
  }).formatToParts(new Date(shift.startsAt));
  const get = (t) => Number(parts.find((p) => p.type === t).value);
  const guess = Date.UTC(get('year'), get('month') - 1, get('day'), h, m);
  // Correct for the zone offset by measuring how far the guess lands from the
  // wall clock it should show.
  const shown = new Intl.DateTimeFormat('en-GB', { timeZone: tz, hour: '2-digit', minute: '2-digit', hour12: false })
    .format(new Date(guess));
  const [sh, sm] = shown.split(':').map(Number);
  const driftMs = ((sh - h) * 60 + (sm - m)) * 60000;
  return guess - driftMs;
}

/** What the agent is told to achieve on the phone. */
export function callGoal({ shift, candidate }) {
  const when = new Date(shift.startsAt).toLocaleString('en-GB', {
    weekday: 'long', hour: '2-digit', minute: '2-digit', timeZone: shift.timeZone ?? 'UTC',
  });
  return [
    `Call ${candidate.name} about an open ${shift.role ?? 'shift'} starting ${when}`,
    shift.location ? `at ${shift.location}` : null,
    `(${Math.round((shift.endsAt - shift.startsAt) / 3600000)} hours).`,
    'Ask whether they can take it.',
    'If yes, confirm and ask what time they can arrive.',
    'If no, thank them and end the call politely — do not push.',
    'If they ask to be called back, note the time they name.',
    'Do not offer pay, terms or anything not stated here.',
  ].filter(Boolean).join(' ');
}

/**
 * Run a cascade to its end.
 *
 * `onEvent` is called for every state change. `clock` is injectable so the
 * fixture replay can run on a fake one — the dashboard demo compresses a
 * fifty-minute morning into ninety seconds without touching the logic.
 */
export async function runCascade(initial, { provider, onEvent = () => {}, clock = Date.now, maxWaitMs = 0 } = {}) {
  let state = initial;

  const emit = (event) => {
    state = applyEvent(state, event);
    onEvent(event, state);
    return state;
  };

  for (;;) {
    const now = clock();
    const action = nextAction(state, now);

    if (action.type === 'done') {
      const before = state.outcome;
      state = finishIfDone(state, now);
      if (!before && state.outcome) onEvent({ type: 'finished', at: now, outcome: state.outcome }, state);
      return state;
    }

    if (action.type === 'skip') {
      emit({ type: 'skipped', candidateId: action.candidate.id, reason: action.reason, at: now });
      continue;
    }

    if (action.type === 'hold') {
      // One call could not be read, so no further call is placed by anybody —
      // not by this loop, and not by another caller either: `applyEvent`
      // refuses `call_started` while a candidate is held. The cascade resumes
      // from exactly here when a `reconciled` event arrives, which is why this
      // returns the state rather than finishing it.
      onEvent({
        type: 'held',
        at: now,
        candidateId: action.candidate?.id ?? null,
        outcome: OUTCOME.NEEDS_REVIEW,
        reason: action.reason,
      }, state);
      return state;
    }

    if (action.type === 'wait') {
      // A real deployment sleeps here and wakes up; a demo run must not. The
      // caller says which it is, and the default is to stop rather than block
      // an HTTP request for six hours.
      const sleepFor = Math.max(0, Math.min(action.untilMs - now, maxWaitMs));
      if (sleepFor <= 0) {
        onEvent({ type: 'waiting', at: now, untilMs: action.untilMs, reason: action.reason }, state);
        return state;
      }
      await new Promise((r) => setTimeout(r, sleepFor));
      continue;
    }

    const candidate = action.candidate;
    const goal = callGoal({ shift: state.shift, candidate });
    emit({ type: 'call_started', candidateId: candidate.id, at: clock(), goal });

    let outcome;
    try {
      const res = await provider.placeCall({ candidate, shift: state.shift, goal });
      const read = classify(res.raw);
      const at = clock();
      outcome = {
        type: 'call_result',
        candidateId: candidate.id,
        result: read.result,
        arrivesAt: resolveLocalTime(state.shift, read.arrivesAtLocal),
        callbackAt: read.callbackInMinutes ? at + read.callbackInMinutes * 60000 : null,
        // Why the classifier could not decide, carried through to the person
        // who has to. "Held for review" without a reason is a shrug.
        why: read.why ?? null,
        reachedVoicemail: read.reachedVoicemail ?? false,
        summary: read.summary ?? null,
        transcript: res.raw?.result?.transcript ?? res.raw?.transcript ?? null,
        audio: res.audio ?? null,
        callRunId: res.callRunId ?? null,
        source: res.source ?? provider.mode,
        at,
      };
    } catch (err) {
      // A provider blowing up must not abort the cascade: the next person on
      // the list is still a candidate, and a shift half-filled by a crash is
      // worse than one filled by the sixth name.
      outcome = {
        type: 'call_result', candidateId: candidate.id, result: RESULT.FAILED,
        error: String(err.message).slice(0, 200), at: clock(),
      };
    }

    emit(outcome);
  }
}

export { summarise };
