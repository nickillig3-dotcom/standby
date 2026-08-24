/**
 * make-fixtures.mjs — writes the five fixture calls that fixture mode replays.
 *
 * These fixtures are AUTHORED, not recorded. No call was placed to produce any
 * of them. They contain no transcript, audio, identifier, phone number or
 * timing taken from a real conversation, and this script is the whole of their
 * provenance: run it and you get the files in fixtures/calls/ byte for byte.
 *
 *     node scripts/make-fixtures.mjs            rewrite the fixtures
 *     node scripts/make-fixtures.mjs --check    fail if the files on disk differ
 *
 * `--check` runs as part of `npm test`, which is the point of shipping the
 * generator rather than only its output: a reviewer does not have to take the
 * word "synthetic" on trust. They can regenerate and diff.
 *
 * WHY THIS EXISTS AT ALL
 *
 * The first version of this repository shipped four genuinely recorded CALL-E
 * calls — real German transcripts, real provider run and call identifiers, and
 * screenshots of them. They were placed to a consenting number and the number
 * itself was scrubbed on the way to disk, but that is not enough for a public
 * repository: a transcript is a recording of a person speaking, the identifiers
 * are the provider's, and consent to be called once is not consent to be
 * published and cloned indefinitely. They were replaced with these.
 *
 * WHAT IS LOST, STATED PLAINLY
 *
 * Recorded fixtures had one real advantage: if CALL-E ever changed its response
 * shape, replaying a capture would break loudly. Authored fixtures cannot do
 * that — they are written against the shape, so they agree with themselves for
 * ever. Shape drift is now caught only by `CALLE_LIVE=1`, against the live API.
 * That trade is deliberate and it is the right way round: a fixture that
 * detects an API change is worth less than a repository that does not
 * republish a person's voice.
 *
 * WHAT IS KEPT
 *
 * The shape. Field names, nesting, the upper-case `status`, the English
 * summary-and-evidence beside a German transcript, and the trap that matters —
 * a voicemail run that reports COMPLETED with a finished call, because a
 * message really was delivered to a machine. The classifier is exercised
 * against all of it offline.
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const OUT = path.join(HERE, '..', 'fixtures', 'calls');

/**
 * +49 176 040690 00–99 is one of two mobile blocks the German networks keep
 * permanently unassigned for use in media. Nothing in this range can ring.
 * See references/safety.md in the skill for the full list and its source.
 */
const RESERVED = '+4917604069001';

/** Fixed, not `new Date()`: the generator has to be reproducible to be checkable. */
const AUTHORED_AT = '2026-08-24T09:00:00.000Z';

const NOTE = [
  'Authored fixture, not a recording. No call was placed to produce this file.',
  'It contains no transcript, audio, identifier or timing from any real conversation.',
  'The dialogue is written; the structure reproduces a CALL-E run so the classifier',
  `is exercised offline. The destination is ${RESERVED}, inside a mobile block the`,
  'German networks keep permanently unassigned for use in media.',
].join(' ');

/** The gap every fixture is about — the same one the dashboard demonstrates. */
const GOAL = 'Call the person answering about an open Early care shift starting Sunday 06:00 '
  + 'at Haus Lindenhof, Station 2 (8 hours). Ask whether they can take it. If yes, confirm and '
  + 'ask what time they can arrive. If no, thank them and end the call politely — do not push. '
  + 'If they ask to be called back, note the time they name. Do not offer pay, terms or anything '
  + 'not stated here.';

const DISPLAY_GOAL = 'Call the person who answers about an open Early care shift starting Sunday '
  + 'at 06:00 at Haus Lindenhof, Station 2, for 8 hours. Ask whether they can take the shift. If '
  + 'yes, confirm that they can take it and ask what time they can arrive. If no, thank them and '
  + 'end the call politely without pushing. If they ask to be called back, note the callback time '
  + 'they name and report it back. Do not offer pay, terms, or anything not stated here.';

/**
 * Build one fixture. Identifiers are readable words rather than plausible
 * hashes on purpose: a fake hex id in a public repo looks exactly like a real
 * one, and somebody will eventually try to look it up.
 */
const fixture = ({ name, durationSeconds, status = 'COMPLETED', callStatus = 'finished',
  summary, evidence, taskCompleted, confidence, label, transcript, nextAction }) => ({
  synthetic: true,
  authoredAt: AUTHORED_AT,
  durationSeconds,
  note: NOTE,
  goal: GOAL,
  raw: {
    run_id: `synthetic-run-${name}`,
    status,
    message: 'Synthetic fixture — no call was placed.',
    display_goal: DISPLAY_GOAL,
    schedule_mode: 'immediate',
    result: {
      summary,
      post_summary: summary,
      outcome: {
        task_completed: taskCompleted,
        completion_confidence: { score: confidence, label },
        evidence,
      },
      extracted: {
        goal: DISPLAY_GOAL,
        region: 'DE',
        language: 'German',
        calling: {
          calls: [{ status: callStatus, reason_code: '0', duration_seconds: durationSeconds }],
          status: callStatus,
          callee_count: 1,
          duration_seconds: durationSeconds,
        },
        to_phones: [RESERVED],
      },
      transcript,
      call_id: `synthetic-call-${name}`,
      call_ids: [`synthetic-call-${name}`],
    },
    next_step: { action: nextAction },
  },
});

const FIXTURES = {
  /**
   * The trap that justifies fixture mode existing: the run reports COMPLETED
   * and the call reports finished, because a message genuinely was delivered.
   * Nobody agreed to anything. A status check alone reads this as a success.
   */
  '01-no-answer': fixture({
    name: '01-no-answer',
    durationSeconds: 42,
    summary: 'The call reached voicemail and the recorded message was sent, but no live '
      + 'availability answer was obtained. The recipient may be busy or unavailable.',
    evidence: [
      'Voicemail answered instead of a live person.',
      'A recorded message about the shift purpose was sent.',
      'No live availability answer or arrival time was obtained.',
    ],
    taskCompleted: false,
    confidence: 0.85,
    label: 'high',
    transcript: [
      '[00:00:00] BOT: Hallo.',
      '[00:00:05] USER: Guten Tag, Sie haben die Mailbox erreicht. Bitte hinterlassen Sie eine Nachricht nach dem Ton.',
      '[00:00:08] BOT: Hallo, es geht um einen offenen Frühdienst am Sonntag ab sechs Uhr im Haus Lindenhof,',
      '[00:00:15] BOT: Station zwei, für acht Stunden.',
      '[00:00:21] BOT: Bitte melden Sie sich kurz, falls Sie die Schicht übernehmen können.',
      '[00:00:28] USER: Die Nachricht wurde gespeichert. Auf Wiederhören.',
    ].join('\n'),
    nextAction: 'ask_user_for_retry_confirmation',
  }),

  '02-decline': fixture({
    name: '02-decline',
    durationSeconds: 22,
    summary: 'The call was completed. The person answered and said they cannot take the '
      + 'Sunday 06:00 early care shift at Haus Lindenhof, Station 2.',
    evidence: [
      'A live person answered the call.',
      'They were asked whether they could take the Sunday 06:00 shift for 8 hours.',
      'They clearly declined, and the call ended politely.',
    ],
    taskCompleted: true,
    confidence: 0.95,
    label: 'high',
    transcript: [
      '[00:00:00] BOT: Hallo.',
      '[00:00:03] USER: Ja, hallo?',
      '[00:00:04] BOT: Ich rufe wegen eines offenen Frühdienstes am Sonntag um sechs Uhr morgens im Haus Lindenhof,',
      '[00:00:11] BOT: Station zwei, für acht Stunden an; können Sie die Schicht übernehmen?',
      '[00:00:17] USER: Nein, am Sonntag kann ich nicht, da bin ich schon verplant.',
      '[00:00:20] BOT: Alles klar, danke Ihnen. Auf Wiederhören.',
    ].join('\n'),
    nextAction: 'report_result',
  }),

  '03-callback': fixture({
    name: '03-callback',
    durationSeconds: 33,
    summary: 'The person answered and asked to be called back in 20 minutes. No shift '
      + 'acceptance or arrival time was confirmed during this call.',
    evidence: [
      'A live person answered the call.',
      'They asked for a callback in 20 minutes.',
      'No confirmation about taking the shift was obtained.',
    ],
    taskCompleted: true,
    confidence: 0.9,
    label: 'high',
    transcript: [
      '[00:00:00] BOT: Hallo.',
      '[00:00:03] USER: Hallo.',
      '[00:00:04] BOT: Ich rufe wegen eines offenen Frühdienstes am Sonntag um sechs Uhr morgens im Haus Lindenhof,',
      '[00:00:11] BOT: Station zwei, für acht Stunden an; können Sie den Dienst übernehmen?',
      '[00:00:18] USER: Können Sie mich in 20 Minuten noch mal anrufen? Ich muss kurz nachsehen.',
      '[00:00:22] BOT: Natürlich, ich rufe in zwanzig Minuten noch einmal an.',
      '[00:00:29] USER: Danke sehr.',
    ].join('\n'),
    nextAction: 'report_blocked',
  }),

  '04-accept': fixture({
    name: '04-accept',
    durationSeconds: 22,
    summary: 'The call was completed successfully. The person agreed to take the early shift '
      + 'and said they will arrive at 05:50.',
    evidence: [
      'A live person answered the call.',
      'They agreed to take the Sunday 06:00 early shift at Haus Lindenhof, Station 2.',
      'They provided an arrival time of 05:50.',
    ],
    taskCompleted: true,
    confidence: 0.95,
    label: 'high',
    transcript: [
      '[00:00:00] BOT: Hallo.',
      '[00:00:03] USER: Hallo.',
      '[00:00:04] BOT: Ich rufe wegen einer offenen Frühdienst-Schicht am Sonntag ab sechs Uhr morgens im Haus Lindenhof,',
      '[00:00:12] BOT: Station zwei, für acht Stunden an; können Sie diese Schicht übernehmen?',
      '[00:00:19] USER: Ja, das mache ich. Ich bin um zehn vor sechs da.',
      '[00:00:22] BOT: Wunderbar, vielen Dank. Bis Sonntag.',
    ].join('\n'),
    nextAction: 'report_result',
  }),

  /**
   * The fixture the reviewer of PR #218 asked for, in runnable form.
   *
   * A person picked up, the question was asked, and the line dropped before an
   * answer existed. The old classifier called this a decline and rang the next
   * name. It now stops the cascade and waits for a human — and this file is how
   * that is demonstrated with no account: pick the "unreadable call" scenario
   * in the dashboard, or run `npm test`.
   */
  '05-unreadable': fixture({
    name: '05-unreadable',
    durationSeconds: 19,
    summary: 'The call connected and the shift question was asked, but the reply was not '
      + 'intelligible and the line dropped before any answer was given.',
    evidence: [
      'A person answered the call.',
      'The shift question was asked.',
      'The reply was not intelligible and the call ended before an answer was given.',
    ],
    taskCompleted: false,
    confidence: 0.2,
    label: 'low',
    transcript: [
      '[00:00:00] BOT: Hallo.',
      '[00:00:04] USER: [unverständlich]',
      '[00:00:05] BOT: Ich rufe wegen eines offenen Frühdienstes am Sonntag um sechs Uhr morgens im Haus Lindenhof,',
      '[00:00:12] BOT: Station zwei, an; können Sie die Schicht übernehmen?',
      '[00:00:17] USER: Ähm — also ich — [Verbindung bricht ab]',
    ].join('\n'),
    nextAction: 'report_blocked',
  }),
};

/* ── write, or check ──────────────────────────────────────────────────────── */

const check = process.argv.includes('--check');
fs.mkdirSync(OUT, { recursive: true });

let differed = 0;
for (const [name, body] of Object.entries(FIXTURES)) {
  const file = path.join(OUT, `${name}.json`);
  const text = `${JSON.stringify(body, null, 2)}\n`;
  if (check) {
    const onDisk = fs.existsSync(file) ? fs.readFileSync(file, 'utf8') : null;
    if (onDisk !== text) { differed += 1; console.log(`  DIFFERS  ${name}.json`); }
    else console.log(`  ok       ${name}.json`);
  } else {
    fs.writeFileSync(file, text);
    console.log(`  wrote    ${name}.json`);
  }
}

// A stray file in fixtures/calls/ is replayed by the provider like any other,
// so an old recorded capture left behind would quietly come back. Checked.
const stray = fs.readdirSync(OUT)
  .filter((f) => f.endsWith('.json'))
  .filter((f) => !Object.keys(FIXTURES).includes(f.replace(/\.json$/, '')));
if (stray.length) {
  console.log(`\n  UNKNOWN FIXTURE FILES: ${stray.join(', ')}`);
  console.log('  Everything fixture mode replays must come from this generator.');
  if (check) process.exit(1);
}

if (check && differed) {
  console.log(`\n${differed} fixture(s) differ from the generator. Run: node scripts/make-fixtures.mjs\n`);
  process.exit(1);
}
console.log(check ? '\nfixtures match the generator\n' : `\n${Object.keys(FIXTURES).length} fixtures written\n`);
