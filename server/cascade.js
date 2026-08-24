/**
 * cascade.js — the sequential shift-fill cascade, as a pure state machine.
 *
 * No I/O lives here. No phone provider, no clock, no network. The cascade is a
 * reducer: you hand it a state and an event, it hands back the next state, and
 * a separate function tells you what to do next. Everything about *why* this
 * product exists is in this file, and all of it can be tested in milliseconds
 * without spending one of twenty free calls.
 *
 * The rule the whole thing turns on: **one call in flight, ever.**
 * Blasting twenty people at once is easy and wrong — you end up with four
 * people showing up for one shift, and the supervisor now has three angry
 * conversations instead of one open slot. Sequential-with-a-stop-condition is
 * why a human does this by hand today, and it is the part an agent has to get
 * right to be worth anything.
 *
 * The five things that make it more than a loop:
 *   1. STOP on the first accept. Nothing after it is dialled.
 *   2. NO-ANSWER goes to one retry pass at the end, not an immediate redial.
 *      Ringing someone twice inside a minute at 05:40 is how a workforce opts
 *      out of the standby list entirely.
 *   3. CALL-ME-BACK re-queues at a time the callee named, and only once.
 *   4. QUIET HOURS and OPT-OUT are checked before dialling, and a skip is
 *      recorded with its reason — a silent skip is indistinguishable from a bug.
 *   5. A WALL CLOCK. The shift starts whether or not the list is exhausted;
 *      past the cutoff the cascade stops and says so, because a "yes" that
 *      arrives after the shift began is not a fill.
 *   6. AN ANSWER NOBODY COULD READ HALTS THE CASCADE. It is not a no. The
 *      whole list stays where it is until a person says what the call meant.
 *      See RESULT.AMBIGUOUS below.
 */

/** Terminal outcomes of a single attempt. */
export const RESULT = {
  ACCEPT: 'accept',
  DECLINE: 'decline',
  CALLBACK: 'callback',
  NO_ANSWER: 'no_answer',
  FAILED: 'failed',
  /**
   * The call happened and its meaning could not be established: half a
   * sentence, a dropped line, evidence pointing both ways.
   *
   * This used to be recorded as a decline with an `unparsed` flag beside it,
   * and the cascade moved on to the next name. That was wrong in a way the
   * flag did not fix. Two people can be harmed by it at once: someone who
   * actually said yes is passed over and never called back, and the next
   * person is rung about a shift that may already be taken. Neither shows up
   * as an error anywhere â€” the log says "declined" and the morning looks
   * normal.
   *
   * So an unreadable answer is its own outcome, and it STOPS the cascade.
   * Nobody else is dialled until a human says what the call meant, through a
   * `reconciled` event. See OUTCOME.NEEDS_REVIEW.
   */
  AMBIGUOUS: 'ambiguous',
};

/** Terminal outcomes of the whole cascade. */
export const OUTCOME = {
  FILLED: 'filled',
  EXHAUSTED: 'exhausted',
  CUTOFF: 'cutoff',
  ABORTED: 'aborted',
  /**
   * Not terminal â€” a halt. The cascade is holding on one unreadable call and
   * will run again from exactly where it stopped once a person reconciles it.
   * Everyone still queued stays queued: this is a pause, not an ending, and
   * standing them down would misreport it in the audit log.
   */
  NEEDS_REVIEW: 'needs_review',
};

export const SKIP = {
  OPTED_OUT: 'opted_out',
  QUIET_HOURS: 'quiet_hours',
  UNAVAILABLE: 'marked_unavailable',
  NO_PHONE: 'no_phone_number',
};

const DEFAULT_POLICY = {
  // One retry pass over everyone who did not pick up, after the first pass.
  retryNoAnswer: true,
  // Local hours during which the list may be rung at all. A shift starting at
  // 06:00 is exactly the case where you *do* ring at 05:40, so this defaults
  // wide and is meant to be set per employer, not guessed.
  quietHours: { fromHour: 22, toHour: 5 },
  // Ringing into quiet hours is allowed when the shift is this close, because
  // the alternative is nobody turning up at all. Set to null to forbid it.
  quietHoursOverrideWithinMs: 90 * 60 * 1000,
  // Stop dialling this long before the shift starts; a yes after that is not a fill.
  cutoffBeforeShiftMs: 0,
  // Guard against a runaway loop no matter what the roster says.
  maxAttempts: 40,
};

/**
 * Build the initial state. `roster` is ordered — position 0 is called first.
 * Ordering is the employer's business rule (seniority, fairness, cost, who is
 * nearest); the cascade does not invent one, it honours the one it is given.
 */
export function planCascade({ shift, roster, policy = {}, now }) {
  if (!shift || typeof shift.startsAt !== 'number') {
    throw new Error('planCascade: shift.startsAt (epoch ms) is required');
  }
  if (!Array.isArray(roster) || roster.length === 0) {
    throw new Error('planCascade: roster must be a non-empty ordered array');
  }
  if (typeof now !== 'number') throw new Error('planCascade: now (epoch ms) is required');

  const merged = { ...DEFAULT_POLICY, ...policy, quietHours: { ...DEFAULT_POLICY.quietHours, ...(policy.quietHours ?? {}) } };

  return {
    id: shift.id ?? `cascade-${shift.startsAt}`,
    shift,
    policy: merged,
    createdAt: now,
    // Set only while the cascade is halted on an answer nobody could read.
    heldOn: null,
    // The queue is rebuilt as we go; `pass` distinguishes the first sweep from
    // the retry sweep so a no-answer cannot be retried twice.
    candidates: roster.map((p, i) => ({
      ...p,
      position: i,
      state: 'queued',
      pass: 1,
      attempts: [],
      // Set when the callee asked to be rung back at a specific time.
      notBefore: null,
    })),
    events: [],
    outcome: null,
    filledBy: null,
  };
}

/* ── the decision: what should happen next ────────────────────────────────── */

const hourInZone = (epochMs, timeZone) => {
  // Intl gives the local hour without pulling in a date library, and without
  // the classic UTC-offset bug of doing it by hand.
  const fmt = new Intl.DateTimeFormat('en-GB', { hour: 'numeric', hour12: false, timeZone });
  return Number(fmt.format(new Date(epochMs)));
};

function inQuietHours(state, now) {
  const { fromHour, toHour } = state.policy.quietHours;
  if (fromHour === null || toHour === null) return false;
  const tz = state.shift.timeZone ?? 'UTC';
  const h = hourInZone(now, tz);
  // Window wraps midnight when fromHour > toHour (e.g. 22 → 5).
  return fromHour > toHour ? (h >= fromHour || h < toHour) : (h >= fromHour && h < toHour);
}

function quietHoursBlocked(state, now) {
  if (!inQuietHours(state, now)) return false;
  const override = state.policy.quietHoursOverrideWithinMs;
  if (override === null) return true;
  // Close enough to the shift that not calling is the worse outcome.
  return state.shift.startsAt - now > override;
}

function skipReason(candidate) {
  if (candidate.optedOut) return SKIP.OPTED_OUT;
  if (candidate.unavailable) return SKIP.UNAVAILABLE;
  if (!candidate.phone) return SKIP.NO_PHONE;
  return null;
}

/**
 * What to do right now. Returns one of:
 *   { type: 'call',  candidate }            place exactly this one call
 *   { type: 'skip',  candidate, reason }    record and move on, do not dial
 *   { type: 'wait',  untilMs, candidate }   a callback time has not arrived
 *   { type: 'hold',  candidate, reason }    a call needs a person before any other
 *   { type: 'done',  outcome }              the cascade is over
 *
 * Deliberately a *query*, not a mutation: the caller decides whether to act.
 */
export function nextAction(state, now) {
  // Checked before everything else, including the clock: a held cascade must
  // not quietly convert itself into a cutoff or an exhaustion while it waits.
  // The hold is the answer to "what happens next", and the answer is a person.
  if (state.outcome === OUTCOME.NEEDS_REVIEW) {
    return {
      type: 'hold',
      outcome: OUTCOME.NEEDS_REVIEW,
      candidate: state.candidates.find((c) => c.state === 'needs_review') ?? null,
      reason: state.heldOn?.why ?? 'a call could not be read',
    };
  }
  if (state.outcome) return { type: 'done', outcome: state.outcome };

  const cutoff = state.shift.startsAt - state.policy.cutoffBeforeShiftMs;
  if (now >= cutoff) return { type: 'done', outcome: OUTCOME.CUTOFF };

  const attemptCount = state.candidates.reduce((n, c) => n + c.attempts.length, 0);
  if (attemptCount >= state.policy.maxAttempts) return { type: 'done', outcome: OUTCOME.EXHAUSTED };

  // A skip is cheap and must be drained before dialling, so the log reads in
  // roster order rather than interleaving skips behind calls.
  const skippable = state.candidates.find((c) => c.state === 'queued' && skipReason(c));
  if (skippable) return { type: 'skip', candidate: skippable, reason: skipReason(skippable) };

  if (quietHoursBlocked(state, now)) {
    // Not a failure — the list simply may not be rung yet. Wake at the earlier
    // of the quiet-hours end and the cutoff, and let the caller decide.
    return { type: 'wait', untilMs: cutoff, reason: SKIP.QUIET_HOURS, candidate: null };
  }

  const ready = state.candidates.filter((c) => c.state === 'queued' && (c.notBefore === null || c.notBefore <= now));
  if (ready.length > 0) {
    // Callbacks first when due, then roster order. Someone who said "ring me
    // back at 5:50" has already half-agreed; they outrank an untried name.
    ready.sort((a, b) => {
      if ((a.notBefore !== null) !== (b.notBefore !== null)) return a.notBefore !== null ? -1 : 1;
      if (a.pass !== b.pass) return a.pass - b.pass;
      return a.position - b.position;
    });
    return { type: 'call', candidate: ready[0] };
  }

  const pending = state.candidates.filter((c) => c.state === 'queued');
  if (pending.length > 0) {
    const untilMs = Math.min(...pending.map((c) => c.notBefore ?? Infinity));
    return { type: 'wait', untilMs: Math.min(untilMs, cutoff), reason: 'callback_pending', candidate: null };
  }

  return { type: 'done', outcome: OUTCOME.EXHAUSTED };
}

/* ── the reducer: fold an event into the state ────────────────────────────── */

const clone = (state) => ({
  ...state,
  candidates: state.candidates.map((c) => ({ ...c, attempts: [...c.attempts] })),
  events: [...state.events],
});

/**
 * Events:
 *   { type:'skipped',      candidateId, reason, at }
 *   { type:'call_started', candidateId, callRunId, at }
 *   { type:'call_result',  candidateId, result, at, arrivesAt?, callbackAt?, transcript?, raw?, why? }
 *   { type:'reconciled',   candidateId, result, by, at, note?, arrivesAt?, callbackAt? }
 *   { type:'aborted',      at, reason }
 *   { type:'finished',     at, outcome }
 */
export function applyEvent(state, event) {
  if (typeof event.at !== 'number') throw new Error('applyEvent: event.at (epoch ms) is required');
  const next = clone(state);
  next.events.push(event);

  if (event.type === 'aborted') {
    next.outcome = OUTCOME.ABORTED;
    next.abortReason = event.reason ?? null;
    return next;
  }

  if (event.type === 'finished') {
    // EXHAUSTED and CUTOFF are conclusions nextAction draws from the clock and
    // the queue, not things that happen to a candidate. Without this event
    // they would live only in the caller's head and the replayed log would end
    // with outcome null — an audit trail that cannot say how the shift ended.
    next.outcome = event.outcome;
    for (const c of next.candidates) {
      if (c.state === 'queued') { c.state = 'stood_down'; c.skipReason = event.outcome; }
    }
    return next;
  }

  const c = next.candidates.find((x) => x.id === event.candidateId);
  if (!c) throw new Error(`applyEvent: no candidate ${event.candidateId}`);

  switch (event.type) {
    case 'skipped':
      c.state = 'skipped';
      c.skipReason = event.reason;
      break;

    case 'call_started':
      if (next.candidates.some((x) => x.state === 'calling')) {
        // The invariant, enforced rather than documented. If this ever throws,
        // something tried to parallelise the cascade and would have
        // double-booked the shift.
        throw new Error('applyEvent: a call is already in flight — the cascade is strictly sequential');
      }
      if (next.candidates.some((x) => x.state === 'needs_review')) {
        // The second invariant, enforced the same way and for the same kind of
        // reason. A rule that lives only in the runner's loop is a rule every
        // other caller can walk straight past. While one answer is unread,
        // dialling the next name risks ringing somebody about a shift that may
        // already be taken.
        throw new Error('applyEvent: a call is held for human reconciliation — no further calls until it is resolved');
      }
      c.state = 'calling';
      c.attempts.push({ startedAt: event.at, callRunId: event.callRunId ?? null, result: null });
      break;

    case 'call_result': {
      const attempt = c.attempts[c.attempts.length - 1];
      if (!attempt) throw new Error(`applyEvent: call_result for ${c.id} with no started attempt`);
      attempt.result = event.result;
      attempt.endedAt = event.at;
      attempt.transcript = event.transcript ?? null;
      attempt.raw = event.raw ?? null;

      if (event.result === RESULT.AMBIGUOUS) {
        // Not a no. Not a yes. The cascade halts here and the roster stays
        // exactly as it is until a person says what this call meant.
        attempt.why = event.why ?? null;
        c.state = 'needs_review';
        next.outcome = OUTCOME.NEEDS_REVIEW;
        next.heldOn = {
          candidateId: c.id,
          at: event.at,
          why: event.why ?? 'the call could not be read',
          summary: event.summary ?? null,
        };
        break;
      }

      settle(next, c, event.result, event);
      break;
    }

    /**
     * A person has listened to the held call and said what it meant. This is
     * the only way out of NEEDS_REVIEW, and therefore the only way the cascade
     * ever dials again after one.
     *
     * `by` is required and recorded. "A human reconciled it" is not an audit
     * trail; "Sabine H., 05:12, from the recording" is. And the resolution may
     * not itself be ambiguous — a hold that resolves into another hold is not
     * a stop condition.
     */
    case 'reconciled': {
      if (c.state !== 'needs_review') {
        throw new Error(`applyEvent: ${c.id} is not held for review (state ${c.state})`);
      }
      if (!event.by) throw new Error('applyEvent: reconciled needs `by` — who decided, recorded in the log');
      if (event.result === RESULT.AMBIGUOUS) {
        throw new Error('applyEvent: reconciled must resolve to a real outcome, not back to ambiguous');
      }
      if (!Object.values(RESULT).includes(event.result)) {
        throw new Error(`applyEvent: reconciled with unknown result ${event.result}`);
      }

      const attempt = c.attempts[c.attempts.length - 1];
      attempt.result = event.result;
      attempt.reconciledBy = event.by;
      attempt.reconciledAt = event.at;
      attempt.reconciledNote = event.note ?? null;
      attempt.heldWhy = next.heldOn?.why ?? null;

      // Lift the hold BEFORE settling, so an accept can write FILLED over it.
      next.outcome = null;
      next.heldOn = null;
      settle(next, c, event.result, event);
      break;
    }

    default:
      throw new Error(`applyEvent: unknown event type ${event.type}`);
  }

  return next;
}

/**
 * Move a candidate to the state their answer implies, and the cascade with
 * them. Shared by `call_result` and `reconciled` on purpose: a person deciding
 * "she said yes" has to land in exactly the same state as the classifier
 * deciding it, or the audit log is describing two different products.
 */
function settle(next, c, result, event) {
  if (result === RESULT.ACCEPT) {
    c.state = 'accepted';
    c.arrivesAt = event.arrivesAt ?? null;
    // "Yes, I can be there by eight" for a six o'clock shift is not a
    // fill, it is a two-hour hole with someone's name on it. The cascade
    // still stops - a second person turning up mid-shift is worse - but
    // the shortfall is stated in minutes instead of being rounded away
    // into a green tick.
    c.lateByMs = (c.arrivesAt !== null && c.arrivesAt > next.shift.startsAt)
      ? c.arrivesAt - next.shift.startsAt
      : 0;
    next.outcome = OUTCOME.FILLED;
    next.filledBy = c.id;
    // Everyone still queued is stood down explicitly. Leaving them
    // "queued" forever would read, in the audit log, as if the cascade
    // simply stopped — the difference matters when someone asks later why
    // person 7 was never called.
    for (const other of next.candidates) {
      if (other.state === 'queued') { other.state = 'stood_down'; other.skipReason = 'filled'; }
    }
    return;
  }

  if (result === RESULT.CALLBACK) {
    if (c.pass > 1 || c.notBefore !== null) {
      // Already given one callback. A second is a polite no.
      c.state = 'declined';
    } else {
      c.state = 'queued';
      c.notBefore = event.callbackAt ?? (event.at + 10 * 60 * 1000);
    }
    return;
  }

  if (result === RESULT.NO_ANSWER && next.policy.retryNoAnswer && c.pass === 1) {
    c.state = 'queued';
    c.pass = 2;
    c.notBefore = null;
    return;
  }

  c.state = result === RESULT.DECLINE ? 'declined'
    : result === RESULT.NO_ANSWER ? 'no_answer'
      : 'failed';
}

/**
 * Advance the state to its terminal outcome if `nextAction` says it is over.
 * Returns the state unchanged when there is still work to do, so a runner can
 * call it unconditionally at the top of its loop.
 */
export function finishIfDone(state, now) {
  if (state.outcome) return state;
  const a = nextAction(state, now);
  if (a.type !== 'done') return state;
  return applyEvent(state, { type: 'finished', at: now, outcome: a.outcome });
}

/** A flat summary for the UI and for the audit log. */
export function summarise(state) {
  const counts = state.candidates.reduce((acc, c) => {
    acc[c.state] = (acc[c.state] ?? 0) + 1;
    return acc;
  }, {});
  const calls = state.candidates.reduce((n, c) => n + c.attempts.length, 0);
  const filled = state.candidates.find((c) => c.id === state.filledBy) ?? null;
  const held = state.candidates.find((c) => c.state === 'needs_review') ?? null;
  return {
    id: state.id,
    outcome: state.outcome,
    calls,
    rosterSize: state.candidates.length,
    counts,
    // Present only while the cascade is halted on an unreadable answer. The
    // dashboard and the log both need to say WHO is waiting on a person, not
    // merely that something is.
    heldOn: held
      ? { id: held.id, name: held.name, why: state.heldOn?.why ?? null, at: state.heldOn?.at ?? null }
      : null,
    filledBy: filled
      ? { id: filled.id, name: filled.name, arrivesAt: filled.arrivesAt ?? null, lateByMs: filled.lateByMs ?? 0 }
      : null,
    // The number that sells the product. Counted, not derived from the roster
    // length: people who were never rung *because the cascade stopped*. The
    // subtraction rosterSize - calls happens to agree in simple runs and
    // silently disagrees as soon as anyone is skipped or rung twice.
    callsAvoided: state.candidates.filter((c) => c.state === 'stood_down').length,
  };
}
