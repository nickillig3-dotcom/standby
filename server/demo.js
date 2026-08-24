/**
 * demo.js — the roster, the gaps and the scenarios the fixture mode replays.
 *
 * PHONE NUMBERS
 *
 * Every number in this repository is drawn from `RESERVED_BLOCK` below:
 * +49 176 040690 00 to 99, one of two mobile blocks the German network
 * operators keep permanently unassigned so that media can print and speak a
 * number without it ringing in somebody's pocket. It is a regulator-and-
 * operator guarantee, not a guess about which numbers look unused.
 *
 * That distinction is the whole point and it was got wrong here once. An
 * earlier version built the roster on the 0151 and 0152 prefixes with a run of
 * zeroes behind them — numbers that merely look synthetic. Those are live
 * German mobile prefixes; a number inside one is unallocated only until the day
 * it is allocated, and then it belongs to a person who never agreed to appear
 * in a demo. "Looks fake" is not a property a phone number has.
 *
 * The reserved sets, for reference:
 *   DE mobile   +49 176 040690 00–99, +49 171 39200 00–99   (network operators)
 *   DE landline +49 30 23125 000–999 and four other cities  (Bundesnetzagentur)
 *   UK          +44 7700 900000–900999                      (Ofcom, drama)
 *   NANP        +1 XXX 555 0100–0199                        (NANPA, fiction)
 *
 * `scripts/test-numbers.mjs` scans the whole repository and fails if any
 * number outside those sets appears anywhere, including in prose.
 */

/** +49 176 040690 nn — see the note above. Two digits, 00 to 99. */
export const RESERVED_BLOCK = '+49176040690';
const reserved = (nn) => `${RESERVED_BLOCK}${String(nn).padStart(2, '0')}`;

const day = (h, m = 0) => Date.UTC(2026, 7, 23, h - 2, m); // 23 Aug 2026, Europe/Berlin

export const DEMO_SHIFTS = [
  {
    id: 'shift-care-early',
    role: 'Early care shift',
    location: 'Haus Lindenhof, Station 2',
    startsAt: day(6), endsAt: day(14),
    timeZone: 'Europe/Berlin', region: 'DE', language: 'de',
    note: 'Called in sick at 05:12. Two residents need two-person transfers — the station cannot open one short.',
  },
  {
    id: 'shift-kitchen-service',
    role: 'Kitchen, dinner service',
    location: 'Restaurant Alte Muehle',
    startsAt: day(17), endsAt: day(23),
    timeZone: 'Europe/Berlin', region: 'DE', language: 'de',
    note: 'A commis dropped out at 15:40. Fully booked Saturday.',
  },
  {
    id: 'shift-depot-night',
    role: 'Night sort, depot',
    location: 'Verteilzentrum Ost, Tor 4',
    startsAt: day(22), endsAt: day(30),
    timeZone: 'Europe/Berlin', region: 'DE', language: 'de',
    note: 'A no-show on the night sort. The trailer leaves at 04:00 whether or not it is loaded.',
  },
];

export const DEMO_ROSTER = [
  { id: 'p1', name: 'Aylin Kaya', phone: reserved(1), note: 'Nearest, usually says yes' },
  { id: 'p2', name: 'Bruno Feld', phone: reserved(2), optedOut: true, note: 'Asked not to be called before 09:00, ever' },
  { id: 'p3', name: 'Carla Mensah', phone: reserved(3) },
  { id: 'p4', name: 'Dario Petrov', phone: reserved(4) },
  { id: 'p5', name: 'Eva Lindqvist', phone: reserved(5) },
  { id: 'p6', name: 'Farid Haddad', phone: null, note: 'No number on file' },
  { id: 'p7', name: 'Greta Sommer', phone: reserved(7) },
  { id: 'p8', name: 'Hugo Brandt', phone: reserved(8), unavailable: true, note: 'Marked on holiday' },
  { id: 'p9', name: 'Ines Vogel', phone: reserved(9) },
  { id: 'p10', name: 'Jonas Weber', phone: reserved(10) },
];

/**
 * Scenarios name the *outcomes* the fixtures stand in for, in order.
 * They are the honest way to show a ten-person cascade without placing ten
 * real calls out of a budget of twenty.
 */
export const SCENARIOS = {
  // The ordinary case, and the one that makes the argument: five calls, four
  // of them wasted breath, and the fifth fills the shift.
  'typical-morning': ['no_answer', 'decline', 'callback', 'decline', 'accept'],

  // First person says yes. Seven people never get rung at 05:40.
  'first-pick': ['accept'],

  // Nobody can. The cascade has to say so rather than keep dialling.
  'nobody-available': ['decline', 'decline', 'no_answer', 'decline', 'decline', 'no_answer', 'decline',
    'decline', 'decline', 'decline', 'decline', 'decline'],

  // The one that shows the retry pass earning its place: everyone is asleep on
  // the first sweep, and the second sweep finds someone.
  'second-sweep': ['no_answer', 'no_answer', 'no_answer', 'no_answer', 'no_answer',
    'no_answer', 'no_answer', 'accept'],

  // A caller who half-agrees, then confirms when rung back.
  'callback-wins': ['decline', 'callback', 'decline', 'accept'],

  // The third outcome. Somebody picks up, the line drops mid-word, and there
  // is no honest reading of what they meant. The cascade STOPS there — it does
  // not score it as a no and ring the next name — and waits for a person to
  // say what the call meant. Nothing after this step is dialled until they do.
  'unreadable-call': ['decline', 'ambiguous', 'accept'],
};
