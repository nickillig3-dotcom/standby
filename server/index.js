/**
 * index.js — the Standby server. No dependencies, no build step.
 *
 *   npm start                 fixture mode: the whole product, no credentials
 *   CALLE_LIVE=1 npm start    the same code path against real phone calls
 *
 * Zero npm dependencies is a deliberate submission choice, not minimalism for
 * its own sake: `npm install` on a stranger's machine is the step where a
 * judge gives up. There is nothing to install.
 */
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { planCascade, summarise, nextAction, applyEvent, OUTCOME, RESULT } from './cascade.js';
import { makeProvider, isLive } from './calle.js';
import { runCascade, callGoal } from './runner.js';
import { SCENARIOS, DEMO_SHIFTS, DEMO_ROSTER } from './demo.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const PUBLIC = path.join(HERE, '..', 'public');
const PORT = Number(process.env.PORT ?? 3000);

/* ── state, in memory: a demo server should start clean every time ────────── */

const runs = new Map();       // id -> cascade state
const streams = new Map();    // id -> Set<res> for server-sent events
// id -> { provider, clock }. Kept because a cascade held for human
// reconciliation is not finished: when the person decides, the SAME run has to
// carry on from where it stopped, with the same provider and the same clock.
const contexts = new Map();

const send = (res, code, body, headers = {}) => {
  const payload = typeof body === 'string' ? body : JSON.stringify(body, null, 2);
  res.writeHead(code, { 'content-type': typeof body === 'string' ? 'text/plain; charset=utf-8' : 'application/json; charset=utf-8', ...headers });
  res.end(payload);
};

const broadcast = (id, event, state) => {
  const set = streams.get(id);
  if (!set) return;
  const frame = `data: ${JSON.stringify({ event, view: viewOf(state) })}\n\n`;
  for (const res of set) res.write(frame);
};

/** The shape the browser renders. Derived, never stored — one source of truth. */
function viewOf(state) {
  return {
    id: state.id,
    shift: state.shift,
    policy: state.policy,
    outcome: state.outcome,
    summary: summarise(state),
    mode: isLive() ? 'live' : 'fixture',
    candidates: state.candidates.map((c) => ({
      id: c.id, name: c.name, position: c.position, state: c.state, pass: c.pass,
      phone: c.phone ? maskPhone(c.phone) : null,
      skipReason: c.skipReason ?? null,
      notBefore: c.notBefore,
      arrivesAt: c.arrivesAt ?? null,
      lateByMs: c.lateByMs ?? 0,
      attempts: c.attempts.map((a) => ({
        startedAt: a.startedAt, endedAt: a.endedAt ?? null, result: a.result,
        transcript: a.transcript ?? null, callRunId: a.callRunId ?? null,
        // Why a call could not be read, and who decided what it meant. Both
        // belong in the view: the audit trail is the thing being shown.
        why: a.why ?? null,
        reconciledBy: a.reconciledBy ?? null,
        reconciledAt: a.reconciledAt ?? null,
      })),
    })),
    events: state.events.map((e) => ({ ...e, raw: undefined })),
  };
}

/**
 * Numbers are masked everywhere they leave the process. The contribution
 * guidelines for the CALL-E repo require "fictional or masked phone numbers in
 * samples", and a demo video is the easiest place in the world to leak a real
 * one by accident.
 */
const maskPhone = (p) => (p.length <= 5 ? p : `${p.slice(0, 4)}…${p.slice(-3)}`);

/* ── routes ───────────────────────────────────────────────────────────────── */

const routes = {
  'GET /api/health': (req, res) => send(res, 200, {
    ok: true, mode: isLive() ? 'live' : 'fixture', runs: runs.size,
    node: process.version,
  }),

  /** Everything the landing screen needs to be useful with one click. */
  'GET /api/demo': (req, res) => send(res, 200, {
    shifts: DEMO_SHIFTS, roster: DEMO_ROSTER, scenarios: Object.keys(SCENARIOS),
    mode: isLive() ? 'live' : 'fixture',
  }),

  /**
   * The capability statement, shown on the landing screen. Standby is an agent
   * that phones people; saying plainly what it will never do is part of being
   * allowed to do the rest.
   */
  'GET /api/capabilities': (req, res) => send(res, 200, {
    can: [
      { tool: 'plan_call', provider: 'CALL-E', what: 'Draft the call, its goal and its language. Costs nothing and is reversible.' },
      { tool: 'run_call', provider: 'CALL-E', what: 'Place exactly one outbound call, after a confirm token the planner issued.' },
      { tool: 'get_call_run', provider: 'CALL-E', what: 'Read back the transcript and the structured outcome.' },
      { tool: 'cascade', provider: 'Standby', what: 'Decide who is next, and when to stop.' },
    ],
    withheld: [
      {
        tool: 'call in parallel',
        why: 'Two calls in flight can produce two acceptances for one shift. The cascade throws rather than allow it — see the "strictly sequential" guard in cascade.js and its test.',
      },
      {
        tool: 'negotiate pay or terms',
        why: 'The call goal states the shift and asks yes or no. An agent improvising terms on the phone binds an employer to something nobody approved.',
      },
      {
        tool: 'call anyone not on the roster',
        why: 'The roster is the consent list. Numbers arrive from the employer, never from the agent, and opted-out people are skipped before dialling with the reason recorded.',
      },
      {
        tool: 'ring outside quiet hours for a distant shift',
        why: 'Ringing a standby list at 23:00 for a shift two days out is how a workforce leaves the list. The override exists only when the shift is imminent, and it is a policy number, not a judgement call.',
      },
    ],
  }),

  /** Start a cascade. Returns immediately; watch it on the stream. */
  'POST /api/cascades': async (req, res, body) => {
    const { shiftId, scenario = 'typical-morning', speed, rosterOverride } = body ?? {};
    const shift = DEMO_SHIFTS.find((s) => s.id === shiftId) ?? DEMO_SHIFTS[0];
    const roster = rosterOverride ?? DEMO_ROSTER;

    // The demo starts eighty minutes before the shift so the quiet-hours
    // override is genuinely in play rather than being stepped around.
    const now = shift.startsAt - 80 * 60 * 1000;

    let state = planCascade({ shift, roster, now });
    runs.set(state.id, state);

    const steps = SCENARIOS[scenario] ?? SCENARIOS['typical-morning'];

    // Time-compress the replay to a target wall-clock length. Without this a
    // twelve-call scenario takes four times as long on screen as a five-call
    // one for no reason a viewer cares about - the interesting thing is the
    // shape of the cascade, not that fixture playback is proportional.
    const replaySpeed = speed ?? Math.max(20, Math.round((steps.length * 25) / (body?.targetSeconds ?? 9)));

    const provider = isLive()
      ? makeProvider({ dryRun: process.env.CALLE_DRY_RUN === '1' })
      : makeProvider({ scenario: steps, speed: replaySpeed });

    send(res, 202, { id: state.id, mode: provider.mode, stream: `/api/cascades/${state.id}/stream` });

    let clockMs = now;
    const clock = () => (clockMs += 45_000);
    contexts.set(state.id, { provider, clock });

    drive(state, contexts.get(state.id));
  },

  'GET /api/cascades': (req, res) => send(res, 200, [...runs.values()].map(viewOf)),
};

function matchDynamic(method, pathname) {
  let m = pathname.match(/^\/api\/cascades\/([^/]+)\/stream$/);
  if (m && method === 'GET') return { handler: 'stream', id: m[1] };
  m = pathname.match(/^\/api\/cascades\/([^/]+)$/);
  if (m && method === 'GET') return { handler: 'get', id: m[1] };
  m = pathname.match(/^\/api\/cascades\/([^/]+)\/abort$/);
  if (m && method === 'POST') return { handler: 'abort', id: m[1] };
  m = pathname.match(/^\/api\/cascades\/([^/]+)\/reconcile$/);
  if (m && method === 'POST') return { handler: 'reconcile', id: m[1] };
  return null;
}

/**
 * Run a cascade and stream it, then decide whether it is over.
 *
 * A cascade held on an unreadable call has NOT ended: the stream stays open and
 * the run stays in memory, because the next thing to happen to it is a person
 * pressing a button. Closing the stream here would leave the dashboard staring
 * at a dead connection with a decision still outstanding — which is exactly the
 * silent-stall failure the hold exists to prevent.
 */
function drive(state, ctx) {
  return runCascade(state, {
    provider: ctx.provider,
    clock: ctx.clock,
    onEvent: (event, s) => { runs.set(s.id, s); broadcast(s.id, event, s); },
  }).then((final) => {
    runs.set(final.id, final);
    if (final.outcome === OUTCOME.NEEDS_REVIEW) return final;
    broadcast(final.id, { type: 'closed', at: ctx.clock() }, final);
    for (const r of streams.get(final.id) ?? []) r.end();
    streams.delete(final.id);
    contexts.delete(final.id);
    return final;
  }).catch((err) => {
    broadcast(state.id, { type: 'error', at: Date.now(), message: String(err.message) }, state);
    return state;
  });
}

/* ── static files ─────────────────────────────────────────────────────────── */

const TYPES = { '.ico': 'image/x-icon', '.png': 'image/png', '.html': 'text/html; charset=utf-8', '.css': 'text/css; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.json': 'application/json', '.svg': 'image/svg+xml', '.mp3': 'audio/mpeg', '.wav': 'audio/wav' };

function serveStatic(pathname, res) {
  // A browser asks for /favicon.ico unprompted; without one the console shows a
  // 404 on every load, which reads as a broken app in a screen recording.
  if (pathname === '/favicon.ico') pathname = '/favicon.svg';
  const rel = pathname === '/' ? 'index.html' : pathname.replace(/^\//, '');
  // Refuse to walk out of public/ — the one line that stops a demo server from
  // serving the token cache.
  const file = path.join(PUBLIC, rel);
  if (!file.startsWith(PUBLIC) || !fs.existsSync(file) || fs.statSync(file).isDirectory()) {
    return send(res, 404, 'not found');
  }
  res.writeHead(200, { 'content-type': TYPES[path.extname(file)] ?? 'application/octet-stream' });
  fs.createReadStream(file).pipe(res);
}

/* ── the server ───────────────────────────────────────────────────────────── */

/** Collect a JSON request body, or answer 400. */
function readBody(req, res, then) {
  let raw = '';
  req.on('data', (d) => { raw += d; });
  req.on('end', () => {
    let body = {};
    try { body = raw ? JSON.parse(raw) : {}; } catch { return send(res, 400, { error: 'body is not JSON' }); }
    return then(body);
  });
  return undefined;
}

const server = http.createServer((req, res) => {
  const url = new URL(req.url, `http://${req.headers.host}`);
  const key = `${req.method} ${url.pathname}`;

  const dyn = matchDynamic(req.method, url.pathname);
  if (dyn) {
    const state = runs.get(dyn.id);
    if (!state) return send(res, 404, { error: `no cascade ${dyn.id}` });

    if (dyn.handler === 'get') return send(res, 200, viewOf(state));

    if (dyn.handler === 'abort') {
      const next = applyEvent(state, { type: 'aborted', at: Date.now(), reason: 'stopped from the dashboard' });
      runs.set(next.id, next);
      broadcast(next.id, { type: 'aborted', at: Date.now() }, next);
      return send(res, 200, viewOf(next));
    }

    /**
     * A person has listened to the held call and said what it meant. This is
     * the only route that can lift a NEEDS_REVIEW hold, and the only way a
     * cascade dials again after one.
     *
     * `by` is required, not defaulted. An audit line reading "reconciled by
     * (unknown)" is worse than none: it looks like accountability.
     */
    if (dyn.handler === 'reconcile') {
      return readBody(req, res, (body) => {
        const ctx = contexts.get(dyn.id);
        if (!ctx) return send(res, 409, { error: 'this cascade is no longer running' });
        const at = ctx.clock();
        let next;
        try {
          next = applyEvent(state, {
            type: 'reconciled',
            candidateId: body.candidateId ?? state.heldOn?.candidateId,
            result: body.result,
            by: body.by,
            note: body.note ?? null,
            arrivesAt: body.arrivesAt ?? null,
            callbackAt: body.callbackAt ?? null,
            at,
          });
        } catch (err) {
          return send(res, 400, { error: String(err.message) });
        }
        runs.set(next.id, next);
        broadcast(next.id, { type: 'reconciled', at, by: body.by, result: body.result }, next);
        send(res, 200, viewOf(next));
        // Carry on from exactly where it stopped.
        drive(next, ctx);
        return undefined;
      });
    }

    // Server-sent events: one-way, no library, reconnects for free.
    res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache', connection: 'keep-alive' });
    res.write(`data: ${JSON.stringify({ event: { type: 'hello' }, view: viewOf(state) })}\n\n`);
    if (!streams.has(dyn.id)) streams.set(dyn.id, new Set());
    streams.get(dyn.id).add(res);
    req.on('close', () => streams.get(dyn.id)?.delete(res));
    return undefined;
  }

  if (routes[key]) {
    if (req.method === 'POST') return readBody(req, res, (body) => routes[key](req, res, body));
    return routes[key](req, res);
  }

  if (url.pathname.startsWith('/api/')) return send(res, 404, { error: `no route ${key}` });
  return serveStatic(url.pathname, res);
});

server.listen(PORT, () => {
  const mode = isLive() ? `LIVE — real calls will be placed${process.env.CALLE_DRY_RUN === '1' ? ' (dry run: planned, not dialled)' : ''}` : 'fixture — authored calls, no credentials, no cost';
  console.log(`\n  Standby  ·  http://localhost:${PORT}`);
  console.log(`  mode: ${mode}`);
  console.log(`  ${DEMO_SHIFTS.length} demo gaps, ${DEMO_ROSTER.length} on the standby list\n`);
});
