/**
 * capture-call.mjs — place one real CALL-E call and keep the response, locally.
 *
 * A development tool for checking the live path by hand. It writes to
 * `captures/`, which is git-ignored, and it CANNOT write into `fixtures/`.
 *
 *   STANDBY_TEST_PHONE=+49... node scripts/capture-call.mjs accept-check
 *
 * NOTHING THIS PRODUCES MAY BE COMMITTED.
 *
 * An earlier version of this script wrote straight into `fixtures/calls/`, and
 * four real calls were published in this repository as a result — German
 * transcripts, provider run and call identifiers, and screenshots of them. The
 * destination number was scrubbed on the way to disk and that was not enough:
 * a transcript is a recording of a person speaking, the identifiers are the
 * provider's, and agreeing to take one call is not agreeing to be published and
 * cloned indefinitely.
 *
 * What fixture mode replays now comes from `scripts/make-fixtures.mjs`, which
 * writes the fixtures rather than recording them. A capture is for looking at.
 *
 * The destination number is still read from the environment and scrubbed out of
 * everything written to disk, because a git-ignored file is one `git add -f`
 * away from a public one.
 */
import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { callGoal } from '../server/runner.js';
import { classify } from '../server/calle.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
// Git-ignored, and deliberately NOT fixtures/calls/. See the header.
const OUT = path.join(HERE, '..', 'captures');

const name = process.argv[2];
const phone = process.env.STANDBY_TEST_PHONE;
if (!name || !phone) {
  console.error('usage: STANDBY_TEST_PHONE=+49... node scripts/capture-call.mjs <name>');
  console.error('writes to captures/ — git-ignored, and never to be committed');
  process.exit(2);
}
if (/[/\\]|\.\./.test(name)) {
  // The one way this could still land in fixtures/ is a name that walks there.
  console.error('name must be a plain filename, not a path');
  process.exit(2);
}

/** The shift the callee will be asked about — the same one the demo shows. */
const day = (h, m = 0) => Date.UTC(2026, 7, 23, h - 2, m);
const shift = {
  id: 'shift-care-early', role: 'Early care shift', location: 'Haus Lindenhof, Station 2',
  startsAt: day(6), endsAt: day(14), timeZone: 'Europe/Berlin', region: 'DE', language: 'de',
};
const candidate = { id: 'p-test', name: 'the person answering', phone };

const goal = callGoal({ shift, candidate });

/** Never let the real number reach disk or the console. */
const scrub = (value) => {
  const tail = phone.replace(/\D/g, '').slice(-9);
  return JSON.parse(
    JSON.stringify(value)
      .split(phone).join('+49XXXXXXXXX')
      .split(phone.replace('+', '')).join('49XXXXXXXXX')
      .split(tail).join('XXXXXXXXX'),
  );
};

// shell:true mangles the goal into separate arguments; shell:false cannot
// launch a .cmd under Node 24. Run the CLI's entry point under this node.
const CALLE = path.join(HERE, '..', 'node_modules', '@call-e', 'cli', 'bin', 'calle.js');
if (!fs.existsSync(CALLE)) {
  console.error('missing CLI. run: npm install --no-save @call-e/cli');
  process.exit(2);
}
const calle = (args, timeoutMs = 240000) => new Promise((resolve, reject) => {
  const child = spawn(process.execPath, [CALLE, ...args], { shell: false });
  let out = ''; let err = '';
  const t = setTimeout(() => { child.kill(); reject(new Error(`timeout: calle ${args[0]} ${args[1]}`)); }, timeoutMs);
  child.stdout.on('data', (d) => { out += d; });
  child.stderr.on('data', (d) => { err += d; });
  child.on('close', (code) => {
    clearTimeout(t);
    if (code !== 0) return reject(new Error(`calle exited ${code}: ${(err || out).slice(0, 400)}`));
    try { resolve(JSON.parse(out.slice(out.indexOf('{')))); }
    catch { reject(new Error(`unparsable: ${out.slice(0, 300)}`)); }
  });
});

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

console.log(`\ncapturing "${name}"`);
console.log(`goal: ${goal}\n`);

const plan = await calle(['call', 'plan', '--to-phone', phone, '--goal', goal, '--region', 'DE', '--language', 'de']);
const p = plan?.result?.structuredContent ?? {};
if (!p.ready_to_run) {
  console.error('plan not ready:', JSON.stringify(scrub(p.clarifying_questions ?? p)).slice(0, 400));
  process.exit(1);
}
console.log(`plan ok — ${p.plan_id}`);
console.log(`the agent will say: ${p.display_goal}\n`);

console.log('DIALLING NOW…');
const t0 = Date.now();
const run = await calle(['call', 'run', '--plan-id', p.plan_id, '--confirm-token', p.confirm_token, '--timezone', 'Europe/Berlin']);
const r = run?.result?.structuredContent ?? {};
const runId = r.call_run_id ?? r.run_id ?? r.id ?? null;
console.log(`run started — ${runId}`);

// Poll until the call is over. A call runs 15-60s; give it three minutes.
let status = r;
for (let i = 0; i < 36; i += 1) {
  await sleep(5000);
  const s = await calle(['call', 'status', '--run-id', String(runId), '--timezone', 'Europe/Berlin']).catch(() => null);
  const sc = s?.result?.structuredContent;
  if (!sc) continue;
  status = sc;
  const state = String(sc.status ?? sc.call_status ?? '').toLowerCase();
  process.stdout.write(`\r  ${((Date.now() - t0) / 1000).toFixed(0)}s  ${state || 'running'}   `);
  if (['completed', 'finished', 'success', 'no_answer', 'failed', 'ended'].includes(state)) break;
}
console.log('\n');

const clean = scrub(status);
const read = classify(clean);
// The CALL length the provider reports, not how long this script sat polling.
// Fixture playback paces itself from this; using the capture wall time made
// every replayed call hit the four-second ceiling.
const durationSeconds = clean.result?.extracted?.calling?.calls?.[0]?.duration_seconds
  ?? Math.round((Date.now() - t0) / 1000);
const capturedInSeconds = Math.round((Date.now() - t0) / 1000);

const capture = {
  recordedAt: new Date().toISOString(),
  durationSeconds,
  capturedInSeconds,
  note: 'REAL CALL — DO NOT COMMIT. A recording of a person speaking, plus the provider\'s '
    + 'own run and call identifiers. The destination number is scrubbed; that is not enough '
    + 'to make this publishable. Fixture mode replays scripts/make-fixtures.mjs, not this.',
  goal,
  raw: clean,
};

fs.mkdirSync(OUT, { recursive: true });
const file = path.join(OUT, `${name}.json`);
fs.writeFileSync(file, JSON.stringify(capture, null, 2));

console.log(`read as     : ${read.result}${read.why ? ` (${read.why})` : ''}`);
if (read.arrivesAt) console.log(`arrives at  : ${new Date(read.arrivesAt).toISOString()}`);
if (read.callbackAt) console.log(`callback at : ${new Date(read.callbackAt).toISOString()}`);
console.log(`transcript  : ${String(clean.transcript ?? clean.summary ?? '(none)').slice(0, 200)}`);
console.log(`saved       : ${file}  (${durationSeconds}s)`);
console.log('\nDO NOT COMMIT THIS FILE. captures/ is git-ignored for a reason.\n');
