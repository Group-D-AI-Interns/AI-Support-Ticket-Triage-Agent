/** Pure draft-policy preview. It has no ticket, storage, provider or permission access. */
export type PriorityFactor = 'high' | 'medium' | 'low';
export type IncidentPriority = 'P1' | 'P2' | 'P3' | 'P4';
export type PriorityCandidate = {
  schemaVersion: 1;
  status: 'draft';
  requiresHumanReview: true;
  source: { documentId: string; version: string; path: string; sha256: string; section: string };
  matrix: Record<PriorityFactor, Record<PriorityFactor, IncidentPriority>>;
};
const factors: PriorityFactor[] = ['high', 'medium', 'low'];
const priorities: IncidentPriority[] = ['P1', 'P2', 'P3', 'P4'];
function object(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}
function exactKeys(value: Record<string, unknown>, keys: string[]) {
  return Object.keys(value).length === keys.length && keys.every(key => Object.hasOwn(value, key));
}
export function validatePriorityCandidate(value: unknown): PriorityCandidate {
  if (!object(value) || !exactKeys(value, ['schemaVersion', 'status', 'requiresHumanReview', 'source', 'matrix']) ||
    value.schemaVersion !== 1 || value.status !== 'draft' || value.requiresHumanReview !== true ||
    !object(value.source) || !object(value.matrix) || !exactKeys(value.matrix, factors)) {
    throw new Error('Expected a complete inactive draft priority matrix.');
  }
  for (const key of ['documentId', 'version', 'path', 'sha256', 'section']) {
    if (typeof value.source[key] !== 'string' || !value.source[key].trim()) throw new Error('Priority source provenance is required.');
  }
  if (!/^[a-f0-9]{64}$/.test(value.source.sha256 as string)) throw new Error('Invalid source checksum.');
  for (const factor of factors) {
    const row = value.matrix[factor];
    if (!object(row) || !exactKeys(row, factors) || factors.some(urgency => !priorities.includes(row[urgency] as IncidentPriority))) {
      throw new Error('Every impact/urgency pair requires a P1–P4 priority.');
    }
  }
  return structuredClone(value) as PriorityCandidate;
}
export type PriorityPreview = {
  priority: IncidentPriority | null;
  status: 'recommendation' | 'insufficient_information';
  requiresHumanReview: true;
  missingInformation: string[];
  warnings: string[];
  evidence: PriorityCandidate['source'];
};
export function previewPriority(candidate: unknown, input: unknown): PriorityPreview {
  const policy = validatePriorityCandidate(candidate);
  if (!object(input) || !exactKeys(input, ['impact', 'urgency'])) {
    throw new Error('Supply only impact and urgency; no permissions, client tier or ticket changes.');
  }
  const missingInformation: string[] = [];
  for (const key of ['impact', 'urgency']) {
    if (input[key] === null) missingInformation.push(key);
    else if (!factors.includes(input[key] as PriorityFactor)) throw new Error(`${key} must be high, medium, low or null.`);
  }
  return {
    priority: missingInformation.length ? null : policy.matrix[input.impact as PriorityFactor][input.urgency as PriorityFactor],
    status: missingInformation.length ? 'insufficient_information' : 'recommendation',
    requiresHumanReview: true,
    missingInformation,
    warnings: ['DRAFT_POLICY: preview only; no organisation approval or effective date recorded.'],
    evidence: policy.source,
  };
}
