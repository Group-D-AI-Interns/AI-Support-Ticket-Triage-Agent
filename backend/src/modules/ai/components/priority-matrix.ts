/** Pure policy-matrix preview. It has no ticket, storage, provider or permission access. */
export type PriorityFactor = 'critical' | 'high' | 'medium' | 'low' | 'immediate';
export type PriorityImpactFactor = 'critical' | 'high' | 'medium' | 'low';
export type PriorityUrgencyFactor = 'immediate' | 'high' | 'medium' | 'low';
export type IncidentPriority = 'P1' | 'P2' | 'P3' | 'P4';
export type LegacyPriorityMatrix = Record<'high' | 'medium' | 'low', Record<'high' | 'medium' | 'low', IncidentPriority>>;
export type CurrentPriorityMatrix = Record<PriorityImpactFactor, Record<PriorityUrgencyFactor, IncidentPriority>>;
export type PriorityMatrix = LegacyPriorityMatrix | CurrentPriorityMatrix;
export type PriorityCandidate = {
  schemaVersion: 1 | 2;
  status: 'draft' | 'active';
  requiresHumanReview: true;
  source: { documentId: string; version: string; path: string; sha256: string; section: string };
  matrix: PriorityMatrix;
};
const legacyFactors = ['high', 'medium', 'low'] as const;
const impactFactors: PriorityImpactFactor[] = ['critical', 'high', 'medium', 'low'];
const urgencyFactors: PriorityUrgencyFactor[] = ['immediate', 'high', 'medium', 'low'];
const priorities: IncidentPriority[] = ['P1', 'P2', 'P3', 'P4'];
function object(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}
function exactKeys(value: Record<string, unknown>, keys: string[]) {
  return Object.keys(value).length === keys.length && keys.every(key => Object.hasOwn(value, key));
}
export function validatePriorityCandidate(value: unknown): PriorityCandidate {
  if (!object(value) || !exactKeys(value, ['schemaVersion', 'status', 'requiresHumanReview', 'source', 'matrix']) ||
    (value.schemaVersion !== 1 && value.schemaVersion !== 2) || (value.status !== 'draft' && value.status !== 'active') || value.requiresHumanReview !== true ||
    !object(value.source) || !object(value.matrix)) {
    throw new Error('Expected a complete inactive draft priority matrix.');
  }
  const impacts = value.schemaVersion === 1 ? legacyFactors : impactFactors;
  const urgencies = value.schemaVersion === 1 ? legacyFactors : urgencyFactors;
  if (!exactKeys(value.matrix, [...impacts])) throw new Error('Priority matrix impact rows do not match its schema version.');
  for (const key of ['documentId', 'version', 'path', 'sha256', 'section']) {
    if (typeof value.source[key] !== 'string' || !value.source[key].trim()) throw new Error('Priority source provenance is required.');
  }
  if (!/^[a-f0-9]{64}$/.test(value.source.sha256 as string)) throw new Error('Invalid source checksum.');
  for (const factor of impacts) {
    const row = value.matrix[factor];
    if (!object(row) || !exactKeys(row, [...urgencies]) || urgencies.some(urgency => !priorities.includes(row[urgency] as IncidentPriority))) {
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
  if (input.impact === null) missingInformation.push('impact');
  else if (!impactFactors.includes(input.impact as PriorityImpactFactor)) throw new Error('impact must be critical, high, medium, low or null.');
  if (input.urgency === null) missingInformation.push('urgency');
  else if (!urgencyFactors.includes(input.urgency as PriorityUrgencyFactor)) throw new Error('urgency must be immediate, high, medium, low or null.');
  const axesDefined = input.impact !== null && input.urgency !== null &&
    Object.hasOwn(policy.matrix, input.impact as string) &&
    Object.hasOwn((policy.matrix as Record<string, Record<string, IncidentPriority>>)[input.impact as string] ?? {}, input.urgency as string);
  if (input.impact !== null && input.urgency !== null && !axesDefined) missingInformation.push('The active policy version does not define this impact/urgency combination.');
  return {
    priority: missingInformation.length ? null : (policy.matrix as Record<string, Record<string, IncidentPriority>>)[input.impact as string]![input.urgency as string]!,
    status: missingInformation.length ? 'insufficient_information' : 'recommendation',
    requiresHumanReview: true,
    missingInformation,
    warnings: [...(policy.status === 'draft' ? ['DRAFT_POLICY: preview only; no organisation approval or effective date recorded.'] : []), ...(!axesDefined && input.impact !== null && input.urgency !== null ? ['POLICY_MATRIX_AXIS_UNSUPPORTED: no fallback or urgency downgrade was applied.'] : [])],
    evidence: policy.source,
  };
}
