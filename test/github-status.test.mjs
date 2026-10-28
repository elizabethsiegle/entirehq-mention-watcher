import { test } from 'node:test';
import assert from 'node:assert/strict';
import { fetchGithubStatus, parseGithubStatus, describeGithubStatus, GITHUB_STATUS_URL } from '../scripts/github-status.mjs';

const summary = (extra = {}) => ({
  status: { indicator: 'none', description: 'All Systems Operational' },
  components: [{ name: 'Git Operations', status: 'operational' }],
  incidents: [],
  ...extra,
});
const incident = (extra = {}) => ({ name: 'API disruption', status: 'investigating', impact: 'major', ...extra });

test('operational status does not confirm an outage', () => {
  const status = parseGithubStatus(summary());
  assert.equal(status.ok, true);
  assert.equal(status.active, false);
  assert.match(describeGithubStatus(status), /no current disruption; replies held/);
});

test('degraded indicators, affected components, or active impactful incidents confirm a disruption', () => {
  for (const indicator of ['minor', 'major', 'critical']) {
    assert.equal(parseGithubStatus(summary({ status: { indicator, description: 'Disruption' } })).active, true);
  }
  for (const status of ['degraded_performance', 'partial_outage', 'major_outage']) {
    const result = parseGithubStatus(summary({ components: [{ name: 'Actions', status }] }));
    assert.equal(result.active, true);
    assert.match(describeGithubStatus(result), /Actions/);
  }
  for (const status of ['investigating', 'identified']) {
    const result = parseGithubStatus(summary({ incidents: [incident({ status })] }));
    assert.equal(result.active, true);
    assert.match(describeGithubStatus(result), /API disruption/);
  }
});

test('resolved, recovered, informational incidents and maintenance alone do not authorize replies', () => {
  for (const status of ['monitoring', 'resolved', 'postmortem']) {
    assert.equal(parseGithubStatus(summary({ incidents: [incident({ status })] })).active, false);
  }
  assert.equal(parseGithubStatus(summary({ incidents: [incident({ impact: 'none' })] })).active, false);
  assert.equal(parseGithubStatus(summary({
    status: { indicator: 'maintenance', description: 'Scheduled maintenance' },
    components: [{ name: 'Pages', status: 'under_maintenance' }],
  })).active, false);
});

test('missing or unfamiliar response fields fail closed', () => {
  for (const body of [null, {}, summary({ components: [] }), summary({ incidents: null }),
    summary({ status: { indicator: 'unexpected', description: 'Changed' } }),
    summary({ components: [{ name: 'Actions', status: 'unexpected' }] }),
    summary({ incidents: [incident({ status: 'unexpected' })] }),
    summary({ incidents: [incident({ impact: undefined })] })]) {
    assert.throws(() => parseGithubStatus(body), /Unexpected GitHub Status response/);
  }
});

test('fetch uses the public official summary, a timeout, and a fresh request', async () => {
  let calls = 0;
  const fetchImpl = async (url, options) => {
    calls++;
    assert.equal(url, GITHUB_STATUS_URL);
    assert.equal(url, 'https://www.githubstatus.com/api/v2/summary.json');
    assert.equal(options.headers['cache-control'], 'no-cache');
    assert.ok(options.signal instanceof AbortSignal);
    return { ok: true, json: async () => summary() };
  };
  const first = await fetchGithubStatus({ fetchImpl });
  await fetchGithubStatus({ fetchImpl });
  assert.equal(calls, 2);
  assert.equal(first.active, false);
  assert.ok(Number.isFinite(Date.parse(first.checkedAt)));
});

test('HTTP errors, invalid JSON, network failures and timeouts remain unknown, never outages', async () => {
  for (const fetchImpl of [
    async () => ({ ok: false, status: 503 }),
    async () => ({ ok: true, json: async () => { throw new Error('invalid JSON'); } }),
    async () => { throw new Error('network unavailable'); },
    async () => { throw new DOMException('timed out', 'TimeoutError'); },
    async () => ({ ok: true, json: async () => ({}) }),
  ]) {
    const status = await fetchGithubStatus({ fetchImpl });
    assert.equal(status.ok, false);
    assert.equal(status.active, false);
    assert.match(describeGithubStatus(status), /unavailable — replies held/);
  }
});
