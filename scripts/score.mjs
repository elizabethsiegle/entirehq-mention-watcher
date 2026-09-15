// A mention's score answers one question: how much does this deserve a human's
// attention right now?
//
// Today exactly one signal moves it. A post authored by someone on the Entire
// team is usually the company talking to itself: a teammate answering an
// inbound tag we were already notified about, or amplifying something we
// shipped. Worth recording, but it is not an outsider raising something
// unprompted, and a channel that presents both identically teaches you to skim
// past both.
//
// Note what this deliberately does NOT do: a tweet that *tags* an employee
// scores the same as any other outsider tweet. Only authorship moves the
// number.

export const DEFAULT_EMPLOYEE_HANDLES = [
  'blackgirlbytes',
  'lizziepika',
  'evisdrenova',
  'ashtom',
  'jkcso',
  'HaimantikaM',
];

// X handles are at most 15 characters of [A-Za-z0-9_]. Reusing parse.mjs's
// shape rule for the hand-edited roster does two jobs: it keeps a typo from
// becoming a bogus roster entry, and it holds the same guarantee downstream
// that notify-slack.mjs's `<url|text>` construct depends on.
const HANDLE_RE = /^[A-Za-z0-9_]{1,15}$/;

// Parses employees.csv. One handle per line, @ optional, case-insensitive;
// anything after the first comma is a free-text note; # starts a comment.
// A plain one-handle-per-line .txt is simply the one-column case of this.
//
// Malformed lines are skipped rather than thrown on: this file is edited by
// hand, and a stray line should mis-score one person, not stop the watcher
// from booting.
export function parseEmployeeFile(contents) {
  if (typeof contents !== 'string') return [];

  const handles = [];
  let sawFirstRow = false;

  for (const line of contents.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (trimmed === '' || trimmed.startsWith('#')) continue;

    const field = trimmed.split(',')[0].trim().replace(/^["']|["']$/g, '');
    const handle = field.replace(/^@/, '').trim();

    // A spreadsheet export leads with a header row. "handle" is a legal X
    // handle, so it has to be dropped by position rather than by shape.
    if (!sawFirstRow) {
      sawFirstRow = true;
      if (handle.toLowerCase() === 'handle') continue;
    }

    if (!HANDLE_RE.test(handle)) continue;
    handles.push(handle.toLowerCase());
  }

  return [...new Set(handles)];
}

export const BASE_SCORE = 60;
export const EMPLOYEE_SCORE = 20;

// Rendered by both notifiers. Lives here so the two never drift apart.
export const EMPLOYEE_BADGE = 'Entire team';

// X handles are case-insensitive and users write them with and without the
// leading @, so every comparison happens on a normalized form. Returns a Set
// because the caller checks membership once per tweet per poll.
export function normalizeHandles(handles) {
  const list = Array.isArray(handles) ? handles : [];
  const normalized = list
    .filter((h) => typeof h === 'string')
    .map((h) => h.trim().replace(/^@/, '').toLowerCase())
    .filter((h) => h !== '');
  return new Set(normalized);
}

const DEFAULT_EMPLOYEE_SET = normalizeHandles(DEFAULT_EMPLOYEE_HANDLES);

// Accepts either an already-normalized Set (the hot path, built once per poll)
// or a raw array, so callers are not forced to remember which they hold.
function asSet(employees) {
  if (employees === undefined || employees === null) return DEFAULT_EMPLOYEE_SET;
  return employees instanceof Set ? employees : normalizeHandles(employees);
}

export function isEmployeeHandle(author, employees) {
  if (typeof author !== 'string') return false;
  const handle = author.trim().replace(/^@/, '').toLowerCase();
  if (handle === '') return false;
  return asSet(employees).has(handle);
}

// Returns the scoring verdict rather than a bare number: the caller needs the
// boolean for badging too, and deriving one from the other by comparing
// against EMPLOYEE_SCORE would break the moment a second signal is added.
export function scoreTweet(tweet, employees) {
  const isEmployee = isEmployeeHandle(tweet?.author, employees);
  return {
    score: isEmployee ? EMPLOYEE_SCORE : BASE_SCORE,
    isEmployee,
  };
}
