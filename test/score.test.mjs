import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  DEFAULT_EMPLOYEE_HANDLES,
  BASE_SCORE,
  EMPLOYEE_SCORE,
  EMPLOYEE_BADGE,
  normalizeHandles,
  isEmployeeHandle,
  scoreTweet,
  parseEmployeeFile,
} from '../scripts/score.mjs';

test('the six Entire handles from the trail are the default roster', () => {
  assert.deepEqual(
    [...normalizeHandles(DEFAULT_EMPLOYEE_HANDLES)].sort(),
    ['ashtom', 'blackgirlbytes', 'evisdrenova', 'haimantikam', 'jkcso', 'lizziepika'],
  );
});

test('an outsider scores the base score and is not badged', () => {
  assert.deepEqual(scoreTweet({ author: 'somedev' }), {
    score: BASE_SCORE,
    isEmployee: false,
  });
});

test('every default employee handle scores down', () => {
  for (const handle of DEFAULT_EMPLOYEE_HANDLES) {
    assert.deepEqual(
      scoreTweet({ author: handle }),
      { score: EMPLOYEE_SCORE, isEmployee: true },
      `${handle} should be recognised as an employee`,
    );
  }
});

test('employee scores are lower than outsider scores', () => {
  // The whole point of the trail: team chatter must not outrank a stranger.
  assert.ok(EMPLOYEE_SCORE < BASE_SCORE);
});

test('employee matching ignores case, since X handles are case-insensitive', () => {
  // The roster literally contains "HaimantikaM"; X will hand us any casing.
  assert.equal(isEmployeeHandle('haimantikam'), true);
  assert.equal(isEmployeeHandle('HAIMANTIKAM'), true);
  assert.equal(isEmployeeHandle('LizziePika'), true);
});

test('employee matching tolerates a leading @ on either side', () => {
  assert.equal(isEmployeeHandle('@ashtom'), true);
  assert.equal(isEmployeeHandle('ashtom', ['@ashtom']), true);
});

test('a custom roster replaces the default entirely', () => {
  const roster = normalizeHandles(['newhire']);
  assert.equal(isEmployeeHandle('newhire', roster), true);
  // Someone who is on the default list but not the custom one is an outsider.
  assert.equal(isEmployeeHandle('ashtom', roster), false);
});

test('scoreTweet accepts a raw array as well as a normalized Set', () => {
  assert.equal(scoreTweet({ author: 'newhire' }, ['@NewHire']).isEmployee, true);
});

test('an empty roster makes everyone an outsider', () => {
  assert.equal(isEmployeeHandle('ashtom', new Set()).valueOf(), false);
  assert.equal(scoreTweet({ author: 'ashtom' }, new Set()).score, BASE_SCORE);
});

test('normalizeHandles trims, strips @, lowercases, dedupes and drops blanks', () => {
  const set = normalizeHandles(['  @Ashtom ', 'ashtom', '', '   ', '@JKCSO']);
  assert.deepEqual([...set].sort(), ['ashtom', 'jkcso']);
});

test('normalizeHandles tolerates junk input', () => {
  assert.deepEqual([...normalizeHandles(null)], []);
  assert.deepEqual([...normalizeHandles([null, 42, undefined, 'ok'])], ['ok']);
});

test('isEmployeeHandle tolerates a missing or non-string author', () => {
  assert.equal(isEmployeeHandle(undefined), false);
  assert.equal(isEmployeeHandle(null), false);
  assert.equal(isEmployeeHandle(42), false);
  assert.equal(isEmployeeHandle(''), false);
  assert.equal(isEmployeeHandle('   '), false);
});

test('scoreTweet tolerates a missing tweet', () => {
  assert.deepEqual(scoreTweet(undefined), { score: BASE_SCORE, isEmployee: false });
});

test('EMPLOYEE_BADGE is the single source of the label both notifiers render', () => {
  assert.equal(EMPLOYEE_BADGE, 'Entire team');
});

test('parseEmployeeFile reads one handle per line', () => {
  assert.deepEqual(parseEmployeeFile('ashtom\njkcso\n'), ['ashtom', 'jkcso']);
});

test('parseEmployeeFile ignores comments and blank lines', () => {
  const file = '# who counts as the team\n\nashtom\n\n  # trailing note\njkcso\n';
  assert.deepEqual(parseEmployeeFile(file), ['ashtom', 'jkcso']);
});

test('parseEmployeeFile keeps only the first field, leaving notes free-form', () => {
  const file = 'lizziepika,Lizzie Siegle,DevRel\nashtom,Thomas,CEO of GitHub\n';
  assert.deepEqual(parseEmployeeFile(file), ['lizziepika', 'ashtom']);
});

test('parseEmployeeFile tolerates @, stray spaces, quotes and CRLF', () => {
  const file = '\r\n  @Ashtom  \r\n"jkcso"\r\n';
  assert.deepEqual(parseEmployeeFile(file), ['ashtom', 'jkcso']);
});

test('parseEmployeeFile drops a spreadsheet header row', () => {
  // "handle" is itself a legal X handle, so shape alone cannot catch this.
  assert.deepEqual(parseEmployeeFile('handle,note\nashtom\n'), ['ashtom']);
});

test('parseEmployeeFile does not drop a real handle that merely comes first', () => {
  assert.deepEqual(parseEmployeeFile('ashtom\njkcso\n'), ['ashtom', 'jkcso']);
});

test('parseEmployeeFile skips entries that are not valid X handles', () => {
  // A full name pasted into the handle column, an over-long handle, an email.
  const file = 'Lizzie Siegle\nthishandleistoolongforx\nnot@an.handle\nashtom\n';
  assert.deepEqual(parseEmployeeFile(file), ['ashtom']);
});

test('parseEmployeeFile dedupes case-insensitively', () => {
  assert.deepEqual(parseEmployeeFile('ashtom\n@Ashtom\nASHTOM\n'), ['ashtom']);
});

test('parseEmployeeFile returns an empty roster for junk or empty input', () => {
  assert.deepEqual(parseEmployeeFile(''), []);
  assert.deepEqual(parseEmployeeFile('# only comments\n'), []);
  assert.deepEqual(parseEmployeeFile(null), []);
  assert.deepEqual(parseEmployeeFile(undefined), []);
});

test('a roster parsed from file drives scoring', () => {
  const roster = parseEmployeeFile('newhire,Some Person\n');
  assert.equal(scoreTweet({ author: 'newhire' }, roster).score, EMPLOYEE_SCORE);
  assert.equal(scoreTweet({ author: 'ashtom' }, roster).score, BASE_SCORE);
});
