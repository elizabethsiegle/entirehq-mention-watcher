import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  bandFor,
  buildScorePrompt,
  readScore,
  createScorer,
  scoreTweet,
  SCORE_MODEL,
} from '../scripts/score.mjs';

const tweet = {
  id: '1958000000000000001',
  author: 'somedev',
  text: 'is @entirehq down? my checkpoints stopped saving an hour ago',
  url: 'https://x.com/somedev/status/1958000000000000001',
  createdAt: '2026-08-18T14:02:11.000Z',
  kind: 'reply',
};

// Minimal stand-in for the Anthropic client: records the request and returns
// whatever the test wants the model to have said.
function stubClient(response, calls = []) {
  return {
    messages: {
      create: async (request, options) => {
        calls.push({ request, options });
        if (response instanceof Error) throw response;
        return response;
      },
    },
  };
}

const jsonResponse = (payload) => ({
  stop_reason: 'end_turn',
  content: [{ type: 'text', text: JSON.stringify(payload) }],
});

test('bandFor maps each score band to its label', () => {
  assert.equal(bandFor(100).label, 'now');
  assert.equal(bandFor(85).label, 'now');
  assert.equal(bandFor(84).label, 'today');
  assert.equal(bandFor(60).label, 'today');
  assert.equal(bandFor(59).label, 'this week');
  assert.equal(bandFor(35).label, 'this week');
  assert.equal(bandFor(34).label, 'fyi');
  assert.equal(bandFor(10).label, 'fyi');
  assert.equal(bandFor(9).label, 'noise');
  assert.equal(bandFor(0).label, 'noise');
});

test('bandFor clamps scores outside 0-100 rather than returning undefined', () => {
  assert.equal(bandFor(140).label, 'now');
  assert.equal(bandFor(-20).label, 'noise');
});

test('bandFor gives every band a dot', () => {
  for (const score of [0, 10, 35, 60, 85]) {
    assert.match(bandFor(score).dot, /\S/);
  }
});

test('buildScorePrompt fences the tweet and labels it as untrusted data', () => {
  const prompt = buildScorePrompt(tweet);
  assert.match(prompt, /untrusted data/);
  assert.match(prompt, /<mention kind="reply" author="somedev">/);
  assert.match(prompt, /checkpoints stopped saving/);
  assert.match(prompt, /<\/mention>/);
});

test('readScore reads structured parsed_output', () => {
  const result = readScore({ parsed_output: { score: 91, reason: 'possible outage' } });
  assert.deepEqual(result, { score: 91, reason: 'possible outage' });
});

test('readScore falls back to parsing a JSON text block', () => {
  const result = readScore(jsonResponse({ score: 42, reason: 'feature request' }));
  assert.deepEqual(result, { score: 42, reason: 'feature request' });
});

test('readScore clamps and rounds an out-of-range score', () => {
  assert.equal(readScore({ parsed_output: { score: 132, reason: 'x' } }).score, 100);
  assert.equal(readScore({ parsed_output: { score: -5, reason: 'x' } }).score, 0);
  assert.equal(readScore({ parsed_output: { score: 61.6, reason: 'x' } }).score, 62);
});

test('readScore returns null when there is no usable score', () => {
  assert.equal(readScore(null), null);
  assert.equal(readScore({ content: [] }), null);
  assert.equal(readScore({ content: [{ type: 'text', text: 'not json at all' }] }), null);
  assert.equal(readScore({ parsed_output: { reason: 'no score field' } }), null);
  assert.equal(readScore({ parsed_output: { score: 'high', reason: 'x' } }), null);
});

test('readScore collapses whitespace and truncates a long reason', () => {
  assert.equal(readScore({ parsed_output: { score: 5, reason: ' spam\n bait ' } }).reason, 'spam bait');
  const long = readScore({ parsed_output: { score: 5, reason: 'y'.repeat(200) } }).reason;
  assert.equal(long.length, 90);
  assert.equal(long.at(-1), '…');
});

test('readScore tolerates a missing reason', () => {
  assert.deepEqual(readScore({ parsed_output: { score: 20 } }), { score: 20, reason: '' });
});

test('createScorer returns null without an API key, so scoring stays opt-in', () => {
  assert.equal(createScorer({ anthropicApiKey: '' }), null);
  assert.equal(createScorer({}), null);
  assert.equal(createScorer(null), null);
});

test('createScorer sends the configured model, a schema and the fenced tweet', async () => {
  const calls = [];
  const scorer = createScorer(
    { anthropicApiKey: 'k', scoreModel: 'claude-opus-5' },
    { client: stubClient(jsonResponse({ score: 88, reason: 'possible outage' }), calls) },
  );

  assert.deepEqual(await scorer(tweet), { score: 88, reason: 'possible outage' });
  assert.equal(calls.length, 1);
  const { request, options } = calls[0];
  assert.equal(request.model, 'claude-opus-5');
  assert.equal(request.output_config.format.type, 'json_schema');
  assert.deepEqual(Object.keys(request.output_config.format.schema.properties), ['score', 'reason']);
  assert.equal(request.output_config.format.schema.additionalProperties, false);
  // Structured outputs reject minimum/maximum/maxLength, and sending them risks a
  // 400 on every scoring call, so the schema must stay free of them.
  const schemaJson = JSON.stringify(request.output_config.format.schema);
  for (const keyword of ['minimum', 'maximum', 'maxLength', 'minLength', 'multipleOf']) {
    assert.ok(!schemaJson.includes(keyword), `schema must not use the unsupported keyword ${keyword}`);
  }
  assert.match(request.system, /@entirehq/);
  assert.match(request.messages[0].content, /checkpoints stopped saving/);
  assert.ok(options.timeout > 0, 'a scoring call must be bounded by a timeout');
});

test('createScorer defaults to the pinned model when config does not name one', async () => {
  const calls = [];
  const scorer = createScorer({ anthropicApiKey: 'k' }, { client: stubClient(jsonResponse({ score: 1, reason: 'spam' }), calls) });
  await scorer(tweet);
  assert.equal(calls[0].request.model, SCORE_MODEL);
});

test('createScorer returns null when the model refuses instead of inventing a score', async () => {
  const scorer = createScorer(
    { anthropicApiKey: 'k' },
    { client: stubClient({ stop_reason: 'refusal', content: [], stop_details: { type: 'refusal' } }) },
  );
  assert.equal(await scorer(tweet), null);
});

test('scoreTweet swallows an API failure so the mention still gets posted', async () => {
  const scorer = createScorer({ anthropicApiKey: 'k' }, { client: stubClient(new Error('429 rate limited')) });
  const result = await scoreTweet(scorer, tweet);
  assert.equal(result.pressing, null);
  assert.match(result.error, /429/);
});

test('scoreTweet with scoring switched off reports neither score nor error', async () => {
  assert.deepEqual(await scoreTweet(null, tweet), { pressing: null, error: null });
});

test('scoreTweet passes a successful score straight through', async () => {
  const scorer = createScorer({ anthropicApiKey: 'k' }, { client: stubClient(jsonResponse({ score: 70, reason: 'buying signal' })) });
  assert.deepEqual(await scoreTweet(scorer, tweet), {
    pressing: { score: 70, reason: 'buying signal' },
    error: null,
  });
});
