/**
 * smoke.mjs — a whole morning, end to end, with no account and no phone.
 *
 * This is the command in the README's first line. If it does not print a
 * filled shift, nothing else about the submission matters.
 */
import { planCascade, summarise, RESULT, OUTCOME } from '../server/cascade.js';
import { makeFixtureProvider } from '../server/calle.js';
import { runCascade } from '../server/runner.js';
import { RESERVED_BLOCK } from '../server/demo.js';

/** +49 176 040690 nn — a block the German networks keep permanently unassigned. */
const reserved = (nn) => `${RESERVED_BLOCK}${String(nn).padStart(2, '0')}`;

// 06:00 Europe/Berlin (CEST = UTC+2), and the roster is rung from 04:40 local.
const START = Date.UTC(2026, 7, 23, 4, 0);
const NOW = Date.UTC(2026, 7, 23, 2, 40);

const shift = {
  id: 'shift-early-231', startsAt: START, endsAt: START + 8 * 3600e3,
  timeZone: 'Europe/Berlin', role: 'Early care shift', location: 'Haus Lindenhof, Station 2',
  region: 'DE', language: 'de',
};

const roster = [
  { id: 'p1', name: 'Aylin Kaya',      phone: reserved(21) },
  { id: 'p2', name: 'Bruno Feld',      phone: reserved(22), optedOut: true },
  { id: 'p3', name: 'Carla Mensah',    phone: reserved(23) },
  { id: 'p4', name: 'Dario Petrov',    phone: reserved(24) },
  { id: 'p5', name: 'Eva Lindqvist',   phone: reserved(25) },
  { id: 'p6', name: 'Farid Haddad',    phone: null },
  { id: 'p7', name: 'Greta Sommer',    phone: reserved(27) },
];

// The morning as it actually goes: nobody picks up, one is out, one declines,
// one asks to be rung back, and the fifth name says yes.
const scenario = [RESULT.NO_ANSWER, RESULT.DECLINE, RESULT.CALLBACK, RESULT.DECLINE, RESULT.ACCEPT];

// Times are printed in the shift's own timezone. Printing UTC here once made a
// correct 05:50 arrival read as 03:50 and sent me hunting a bug that was in
// the console, not the code.
const local = (ms) => (ms == null ? '—'
  : new Date(ms).toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit', timeZone: shift.timeZone }));

let clockMs = NOW;
const clock = () => (clockMs += 45_000); // each call eats about 45 seconds

const provider = makeFixtureProvider({ scenario, speed: 40 });
console.log(`\nStandby — fixture mode, ${provider.fixtureCount} authored fixtures, no credentials\n`);
console.log(`  gap: ${shift.role}, ${new Date(START).toISOString()} · ${roster.length} on the standby list\n`);

const state = await runCascade(planCascade({ shift, roster, now: NOW }), {
  provider,
  clock,
  onEvent: (e, s) => {
    const who = s.candidates.find((c) => c.id === e.candidateId);
    const t = local(e.at);
    if (e.type === 'call_started') console.log(`  ${t}  calling  ${who.name}`);
    if (e.type === 'skipped')      console.log(`  ${t}  skipped  ${who.name.padEnd(16)} ${e.reason}`);
    if (e.type === 'call_result')  console.log(`  ${t}  ${String(e.result).padEnd(11)}${who.name.padEnd(16)}${e.summary ? e.summary.slice(0, 76) : ''}`);
    if (e.type === 'held')         console.log(`  ${t}  HELD — ${who?.name ?? '?'}: ${e.reason}. No further call until a person resolves it.`);
    if (e.type === 'finished')     console.log(`  ${t}  ${e.outcome.toUpperCase()}`);
  },
});

const s = summarise(state);
console.log(`\n  outcome        ${s.outcome}`);
console.log(`  filled by      ${s.filledBy ? `${s.filledBy.name}, arriving ${local(s.filledBy.arrivesAt)} local` : '—'}`);
console.log(`  calls placed   ${s.calls} of ${s.rosterSize} on the list`);
console.log(`  calls avoided  ${s.callsAvoided}  (stood down the moment the shift was filled)`);
console.log(`  audit events   ${state.events.length}\n`);

if (s.outcome !== OUTCOME.FILLED) { console.error('smoke: the shift was not filled'); process.exit(1); }
