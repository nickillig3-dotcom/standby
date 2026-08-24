/**
 * calle.js — the phone provider, behind one interface with two backings.
 *
 * `fixture` replays authored CALL-E responses from disk. `live` drives the real
 * `calle` CLI, which owns the OAuth token and the MCP session so this file
 * never touches a credential.
 *
 * The point of the split is not testing convenience. **A judge cannot
 * reproduce a phone call.** Most entries in this hackathon will ship a repo
 * that only works if the reviewer signs up, gets a number, and burns their own
 * free calls — so most reviewers will read the README and score the video.
 * Standby runs the entire cascade on a machine with no account at all.
 *
 * The same code path serves both; `CALLE_LIVE=1` is the only difference.
 *
 * The fixtures are WRITTEN, by scripts/make-fixtures.mjs, and `npm test` re-runs
 * that generator in --check mode so the files on disk are provably its output.
 * They used to be captures of four real calls, which had one advantage worth
 * naming: a capture breaks loudly when the provider changes its response shape,
 * and an authored fixture cannot — it agrees with itself for ever. Shape drift
 * is caught by CALLE_LIVE=1 and nowhere else now. That is the price of not
 * republishing a person's transcript, and it is worth paying.
 */
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { RESULT } from './cascade.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const FIXTURE_DIR = path.join(HERE, '..', 'fixtures', 'calls');

export const isLive = () => process.env.CALLE_LIVE === '1';

/* ── reading a decision out of a finished call ────────────────────────────── */

/**
 * WRITTEN AGAINST THE REAL RESPONSE, NOT THE DOCUMENTATION. Four live calls
 * were placed on 22.08.2026 and frozen into fixtures/calls/; what comes back is
 * nothing like the flat `{status, structured, transcript}` that was assumed:
 *
 *   raw.status                            "COMPLETED" — upper case
 *   raw.result.summary                    an ENGLISH sentence stating the outcome
 *   raw.result.outcome.task_completed     boolean
 *   raw.result.outcome.evidence[]         English statements of what happened
 *   raw.result.transcript                 the conversation, in the call's language
 *   raw.result.extracted.calling.calls[0] status / duration_seconds
 *
 * There is no result-schema parameter on `plan_call` — the tool list was
 * checked — so there is no structured decision field to trust. What there is,
 * and what this reads first, is the English summary and evidence: CALL-E writes
 * those in English whatever language the call was in, which makes them a far
 * better classification target than German prose.
 *
 * THREE outcomes, not two. Anything that is not a clear yes is not an accept —
 * but anything that is not clear AT ALL is not a decline either, and that is
 * the correction this file carries. An earlier version returned DECLINE with an
 * `unparsed: true` flag beside it for calls it could not read, and the cascade
 * moved on to the next name. The flag was honest and the behaviour was not: an
 * unreadable call was still, operationally, a no. Someone who said yes into a
 * dropping line got passed over, and the next person was rung about a shift
 * that might already have been taken. So the third outcome is AMBIGUOUS, and
 * the cascade stops on it until a person says what the call meant.
 *
 * The cost ladder, which is what the ordering below actually encodes:
 *   a false ACCEPT     ends the cascade, shift unfilled, everyone stood down
 *   a false DECLINE    passes over a willing person, costs one more call
 *   an AMBIGUOUS hold  costs a supervisor thirty seconds of listening
 * The hold is the cheapest of the three whenever there is genuine doubt.
 *
 * Times come back as WALL CLOCK ("05:50"), not epoch. Resolving one needs the
 * shift's date and timezone, which live in the caller — resolving it here is
 * exactly how an arrival time ended up two hours out.
 */
export function classify(raw) {
  if (!raw || typeof raw !== 'object') return { result: RESULT.FAILED, why: 'no response' };

  const result = raw.result ?? {};
  const outcome = result.outcome ?? {};
  const summary = String(result.summary ?? result.post_summary ?? raw.summary ?? '');
  const evidence = Array.isArray(outcome.evidence) ? outcome.evidence.join(' ') : '';
  const transcript = String(result.transcript ?? raw.transcript ?? '');
  const english = `${summary} ${evidence}`.toLowerCase();

  const runState = String(raw.status ?? raw.call_status ?? '').toLowerCase();
  const callState = String(
    result.extracted?.calling?.calls?.[0]?.status ?? result.extracted?.calling?.status ?? '',
  ).toLowerCase();

  // A run that never became a call at all.
  if (['failed', 'error', 'cancelled', 'canceled', 'rejected'].includes(runState)
    || ['failed', 'error', 'invalid_number', 'rejected'].includes(callState)) {
    return { result: RESULT.FAILED, why: `run ${runState || callState}`, summary };
  }

  // The older flat shape, kept so a hand-written fixture still classifies.
  const flat = raw.structured ?? null;
  if (flat && typeof flat.decision === 'string') {
    const d = flat.decision.toLowerCase();
    if (['accept', 'yes', 'accepted'].includes(d)) {
      return { result: RESULT.ACCEPT, arrivesAtLocal: hhmm(flat.arrives_at ?? flat.arrivesAt), summary };
    }
    if (['decline', 'no', 'declined'].includes(d)) return { result: RESULT.DECLINE, summary };
    if (['callback', 'call_back', 'later'].includes(d)) {
      return { result: RESULT.CALLBACK, callbackInMinutes: 10, summary };
    }
  }
  if (['no_answer', 'noanswer', 'busy', 'voicemail', 'unanswered'].includes(runState)) {
    return { result: RESULT.NO_ANSWER, summary };
  }

  // ── the real path, in refusal-first order ────────────────────────────────

  const refuses = REFUSAL.test(english);
  const agrees = AGREEMENT.test(english);

  // 1. Nobody spoke to us. Voicemail counts: a message left on a machine is not
  //    a person agreeing to come in at six.
  if (/voicemail|answering machine|no answer|nobody answered|did not answer|not answered|mailbox/.test(english)
    || VOICEMAIL_GREETING.test(transcript)) {
    return { result: RESULT.NO_ANSWER, summary, reachedVoicemail: true };
  }

  // 2. "Ring me back" — before decline, because a callback summary also says no
  //    acceptance was obtained, which on its own reads as a refusal.
  if (/call(ed)? ?back|callback|ring .*back|call again/.test(english)) {
    return { result: RESULT.CALLBACK, callbackInMinutes: minutesFrom(english) ?? 10, summary };
  }

  // 3. Evidence pointing both ways. The run says it completed the task, the
  //    wording contains a refusal AND an agreement, and there is no honest way
  //    to pick one. Silently preferring the refusal — which is what checking
  //    refusal-first amounts to here — passes over someone who may well have
  //    said yes. This is the case a person resolves in thirty seconds.
  if (outcome.task_completed === true && refuses && agrees) {
    return {
      result: RESULT.AMBIGUOUS,
      why: 'the call summary contains both a refusal and an agreement',
      summary,
    };
  }

  // 4. Refusal before agreement: "cannot take" contains "take".
  if (refuses) return { result: RESULT.DECLINE, summary };

  // 5. Agreement, and only with the run's own completion flag behind it.
  if (outcome.task_completed === true && agrees) {
    return {
      result: RESULT.ACCEPT,
      arrivesAtLocal: hhmm(english.match(/(?:arriv\w*|be there)[^0-9]{0,24}(\d{1,2}[:.]\d{2})/)?.[1]),
      confidence: outcome.completion_confidence?.score ?? null,
      summary,
    };
  }

  // 6. An agreement the run itself does not stand behind. Not an accept — the
  //    flag is the only corroboration there is — but not a no either.
  if (agrees) {
    return {
      result: RESULT.AMBIGUOUS,
      why: 'the summary reads as an agreement but the run did not mark the task completed',
      summary,
    };
  }

  // 7. Last resort: the transcript, in either language, and only the CALLEE's
  //    half of it. Matching the whole transcript reads the agent's own lines
  //    too — the bot opens with "Hallo" and closes with "Super, danke", and a
  //    bare word-match on that is a filled shift with nobody in it.
  //    Word-bounded as well: unbounded, "ja" matches inside "Anja".
  const text = calleeLines(transcript);
  if (text) {
    if (/(?:^|\W)(nein|tut mir leid|kann ich nicht|geht bei mir nicht|sorry|can't|cannot|no thanks)(?:\W|$)/.test(text)) {
      return { result: RESULT.DECLINE, summary, from: 'transcript' };
    }
    if (/(?:^|\W)(ruf .*noch ?mal|ruf .*zur[uü]ck|call me back|later)(?:\W|$)/.test(text)) {
      return { result: RESULT.CALLBACK, callbackInMinutes: minutesFrom(text) ?? 10, summary, from: 'transcript' };
    }
    // A bare "ja" with no summary and no completion flag behind it is the
    // weakest possible evidence for the most expensive decision this code can
    // make. It stops the cascade for a person instead of filling the shift.
    if (/(?:^|\W)(ja|passt|mache ich|yes|sure|okay)(?:\W|$)/.test(text)) {
      return {
        result: RESULT.AMBIGUOUS,
        why: 'the only sign of agreement is a single word in the transcript, with nothing corroborating it',
        summary,
        from: 'transcript',
      };
    }
  }

  // Understood nothing at all. Not a decline: "they said no" and "we could not
  // tell" are different facts, and only one of them means the next person
  // should be rung.
  return {
    result: RESULT.AMBIGUOUS,
    why: 'nothing decidable in the summary, the evidence or the transcript',
    summary,
  };
}

/** The words that mean no, and the words that mean yes. Named so the conflict
 *  check and the branches below cannot drift apart. */
const REFUSAL = /cannot take|can ?not take|can't take|unable to|declin|refus|said no|not available|is unavailable|will not/;
const AGREEMENT = /agreed to take|accepted|will take|confirmed .*(shift|it)|said yes/;

/** Voicemail systems announcing themselves, in German and English. */
const VOICEMAIL_GREETING = /nachricht nach dem (signal)?ton|mailbox erreicht|sprachbox|anruf kann derzeit nicht|leave a message after/i;

/**
 * Only what the person on the other end said.
 *
 * A CALL-E transcript interleaves both sides:
 *   [00:00:00] BOT: Hallo.  [00:00:03] USER: Hallo.  [00:00:19] BOT: Super, danke.
 * Classifying the whole string means classifying the agent's own script, which
 * is written to be agreeable and contains "Ja", "gerne" and "danke" in almost
 * every call.
 */
function calleeLines(transcript) {
  if (!transcript) return '';
  return [...String(transcript).matchAll(/USER:\s*([^\n[]*)/g)]
    .map((m) => m[1].trim())
    .join(' \n ')
    .toLowerCase();
}

/** "in 20 minutes" / "in 2 hours" -> minutes. */
function minutesFrom(text) {
  const m = text.match(/(\d{1,3})\s*(minute|minuten|min\b)/);
  if (m) return Number(m[1]);
  const h = text.match(/(\d{1,2})\s*(hour|hours|stunde|stunden)/);
  if (h) return Number(h[1]) * 60;
  return null;
}

/** Normalise anything time-like to "HH:MM", or null. */
function hhmm(v) {
  if (!v) return null;
  const m = String(v).match(/(\d{1,2})[:.](\d{2})/);
  if (!m) return null;
  return `${String(m[1]).padStart(2, '0')}:${m[2]}`;
}

/* ── the fixture backing ──────────────────────────────────────────────────── */

function loadFixtures() {
  if (!fs.existsSync(FIXTURE_DIR)) return [];
  return fs.readdirSync(FIXTURE_DIR)
    .filter((f) => f.endsWith('.json'))
    .sort()
    .map((f) => ({ name: f, ...JSON.parse(fs.readFileSync(path.join(FIXTURE_DIR, f), 'utf8')) }));
}

/**
 * Fixtures are chosen by the outcome the scenario asks for, not by candidate
 * id — so one recorded decline can stand in for any declining candidate, and a
 * ten-person cascade can be shown honestly without spending ten of twenty
 * free calls.
 */
export function makeFixtureProvider({ scenario = [], speed = 1 } = {}) {
  const fixtures = loadFixtures();
  const byResult = new Map();
  for (const f of fixtures) {
    const { result } = classify(f.raw ?? f);
    if (!byResult.has(result)) byResult.set(result, []);
    byResult.get(result).push(f);
  }
  let step = 0;

  return {
    mode: 'fixture',
    fixtureCount: fixtures.length,
    async placeCall({ candidate, shift }) {
      const want = scenario[step] ?? RESULT.DECLINE;
      step += 1;
      const pool = byResult.get(want) ?? [];
      const f = pool[step % Math.max(pool.length, 1)] ?? null;

      // Replay at a believable pace so the dashboard animates like the real
      // thing instead of resolving twenty calls in one frame.
      const dwellMs = Math.round(((f?.durationSeconds ?? 22) * 1000) / speed);
      await new Promise((r) => setTimeout(r, Math.min(dwellMs, 4000)));

      if (!f) {
        return { raw: { status: want === RESULT.NO_ANSWER ? 'no_answer' : 'failed' }, source: 'synthetic' };
      }
      return {
        raw: f.raw ?? f,
        callRunId: `fixture:${f.name}`,
        audio: f.audio ?? null,
        source: f.name,
        replayedFor: { candidate: candidate.id, shift: shift.id },
      };
    },
  };
}

/* ── the live backing ─────────────────────────────────────────────────────── */

/**
 * Two Windows traps, both hit for real:
 *   `shell: true` concatenates argv instead of escaping it, so a goal
 *   containing spaces — every goal — arrives as thirty separate arguments and
 *   the CLI rejects the em-dash it finds at the front of one of them.
 *   `shell: false` then fails outright, because Node 24 refuses to spawn a
 *   `.cmd` at all.
 * Running the package's own entry point under this node binary avoids both.
 */
function calleEntry() {
  const local = path.join(HERE, '..', 'node_modules', '@call-e', 'cli', 'bin', 'calle.js');
  return fs.existsSync(local) ? local : null;
}

function runCalle(args, { timeoutMs = 240000 } = {}) {
  return new Promise((resolve, reject) => {
    const entry = calleEntry();
    if (!entry) return reject(new Error('live mode needs the CLI: npm install --no-save @call-e/cli'));
    const child = spawn(process.execPath, [entry, ...args], { shell: false });
    let out = '';
    let err = '';
    const timer = setTimeout(() => { child.kill(); reject(new Error(`calle ${args[0]} ${args[1]} timed out`)); }, timeoutMs);
    child.stdout.on('data', (d) => { out += d; });
    child.stderr.on('data', (d) => { err += d; });
    child.on('close', (code) => {
      clearTimeout(timer);
      if (code !== 0) return reject(new Error(`calle exited ${code}: ${err.slice(0, 400) || out.slice(0, 400)}`));
      try {
        // Parsed from the PLAIN output, not from `--json`: `calle mcp tools
        // --json` returns an empty tool list while the same command without the
        // flag returns the full one, so the flag is not trusted anywhere here.
        resolve(JSON.parse(out.slice(out.indexOf('{'))));
      } catch {
        reject(new Error(`calle ${args[0]}: unparsable output: ${out.slice(0, 300)}`));
      }
    });
  });
}

export function makeLiveProvider({ dryRun = false } = {}) {
  return {
    mode: dryRun ? 'live-dry-run' : 'live',
    async placeCall({ candidate, shift, goal }) {
      const plan = await runCalle([
        'call', 'plan',
        '--to-phone', candidate.phone,
        '--goal', goal,
        '--region', shift.region ?? 'DE',
        '--language', shift.language ?? 'de',
      ]);

      const planned = plan?.result?.structuredContent ?? {};
      if (!planned.ready_to_run) {
        return { raw: { status: 'failed', reason: 'plan_not_ready', questions: planned.clarifying_questions ?? [] } };
      }
      if (dryRun) {
        // Planning costs nothing; running costs one of twenty. A dry run proves
        // the whole path end to end and stops one step short.
        return { raw: { status: 'planned_not_run', plan_id: planned.plan_id }, source: 'dry-run' };
      }

      const run = await runCalle([
        'call', 'run', '--plan-id', planned.plan_id, '--confirm-token', planned.confirm_token,
        '--timezone', shift.timeZone ?? 'UTC',
      ]);
      const started = run?.result?.structuredContent ?? {};
      const runId = started.run_id ?? started.call_run_id ?? null;

      // run_call returns as soon as the call is queued; the outcome arrives on
      // the status endpoint a minute or two later.
      let status = started;
      for (let i = 0; i < 36; i += 1) {
        await new Promise((r) => setTimeout(r, 5000));
        const s = await runCalle(['call', 'status', '--run-id', String(runId), '--timezone', shift.timeZone ?? 'UTC'])
          .catch(() => null);
        const sc = s?.result?.structuredContent;
        if (!sc) continue;
        status = sc;
        const state = String(sc.status ?? '').toLowerCase();
        if (['completed', 'finished', 'success', 'failed', 'ended'].includes(state)) break;
      }

      return { raw: status, callRunId: runId, source: 'live' };
    },
  };
}

export function makeProvider(opts = {}) {
  return isLive() ? makeLiveProvider(opts) : makeFixtureProvider(opts);
}
