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

export async function fetchGithubStatus({ fetchImpl = fetch, timeoutMs = 10000 } = {}) {
  try {
    const response = await fetchImpl(GITHUB_STATUS_URL, {
      headers: { accept: 'application/json', 'cache-control': 'no-cache' },
      signal: AbortSignal.timeout(timeoutMs),
    });
    if (!response.ok) throw new Error(`GitHub Status returned HTTP ${response.status}`);
    return { ...parseGithubStatus(await response.json()), checkedAt: new Date().toISOString() };
  } catch (error) {
    return { ok: false, active: false, description: 'GitHub Status unavailable', error: error.message };
  }
}

export function describeGithubStatus(status) {
  if (!status?.ok) return `githubstatus.com: unavailable — replies held (${status?.error || 'no result'})`;
  const details = [...status.components.map((c) => c.name), ...status.incidents.map((i) => i.name)];
  return `githubstatus.com: ${status.description}${details.length ? ` — ${details.join('; ')}` : ''} — ${status.active ? 'disruption confirmed' : 'no current disruption; replies held'}`;
}
