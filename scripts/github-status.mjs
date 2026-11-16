import { setTimeout as delay } from 'node:timers/promises';

export const GITHUB_STATUS_URL = 'https://www.githubstatus.com/api/v2/summary.json';

const INDICATORS = new Set(['none', 'minor', 'major', 'critical', 'maintenance']);
const COMPONENT_STATES = new Set(['operational', 'degraded_performance', 'partial_outage', 'major_outage', 'under_maintenance']);
const INCIDENT_STATES = new Set(['investigating', 'identified', 'monitoring', 'resolved', 'postmortem']);
const IMPACTS = new Set(['none', 'minor', 'major', 'critical']);
const DISRUPTIONS = new Set(['minor', 'major', 'critical']);
const DEGRADED = new Set(['degraded_performance', 'partial_outage', 'major_outage']);

export function parseGithubStatus(body) {
  if (!INDICATORS.has(body?.status?.indicator) || typeof body?.status?.description !== 'string'
    || !Array.isArray(body.components) || body.components.length === 0 || !Array.isArray(body.incidents)
    || body.components.some((component) => !component || typeof component.name !== 'string' || !COMPONENT_STATES.has(component.status))
    || body.incidents.some((incident) => !incident || typeof incident.name !== 'string'
      || !INCIDENT_STATES.has(incident.status) || !IMPACTS.has(incident.impact))) {
    throw new Error('Unexpected GitHub Status response');
  }
  const components = body.components.filter((component) => DEGRADED.has(component.status))
    .map(({ name, status }) => ({ name, status }));
  const incidents = body.incidents.filter((incident) => ['investigating', 'identified'].includes(incident.status)
    && DISRUPTIONS.has(incident.impact))
    .map(({ name, status, impact }) => ({ name, status, impact }));
  return {
    ok: true,
    active: DISRUPTIONS.has(body.status.indicator) || components.length > 0 || incidents.length > 0,
    description: body.status.description,
    components,
    incidents,
  };
}

export async function fetchGithubStatus({ fetchImpl = fetch, timeoutMs = 10000, sleep = delay } = {}) {
  const maxAttempts = 3;
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    let retryable = true;
    try {
      const response = await fetchImpl(GITHUB_STATUS_URL, {
        headers: { accept: 'application/json', 'cache-control': 'no-cache' },
        signal: AbortSignal.timeout(timeoutMs),
      });
      if (!response.ok) {
        retryable = response.status === 408 || response.status === 429 || response.status >= 500;
        await response.body?.cancel();
        throw new Error(`GitHub Status returned HTTP ${response.status}`);
      }
      const body = await response.json();
      retryable = false;
      return { ...parseGithubStatus(body), checkedAt: new Date().toISOString() };
    } catch (error) {
      if (retryable && attempt < maxAttempts) {
        await sleep(500 * 2 ** (attempt - 1));
        continue;
      }
      const cause = error?.cause?.code || error?.cause?.message;
      const detail = `${error?.message || String(error)}${cause ? ` (${cause})` : ''}`;
      return {
        ok: false, active: false, description: 'GitHub Status unavailable',
        error: `${detail}; ${attempt} attempt${attempt === 1 ? '' : 's'}`,
        checkedAt: new Date().toISOString(),
      };
    }
  }
}

export function describeGithubStatus(status) {
  if (!status?.ok) return `githubstatus.com: unavailable — replies held (${status?.error || 'no result'})`;
  const details = [...status.components.map((c) => c.name), ...status.incidents.map((i) => i.name)];
  return `githubstatus.com: ${status.description}${details.length ? ` — ${details.join('; ')}` : ''} — ${status.active ? 'disruption confirmed' : 'no current disruption; replies held'}`;
}
