import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { previewPriority, validatePriorityCandidate } from '../src/modules/ai/components/priority-matrix.js';
const root = new URL('../data/reference/', import.meta.url);
const candidate = JSON.parse(await readFile(new URL('candidates/priority-policy.json', root), 'utf8'));
for (const [impact, urgency, expected] of [
  ['high', 'high', 'P1'], ['high', 'medium', 'P2'], ['high', 'low', 'P3'],
  ['medium', 'high', 'P2'], ['medium', 'medium', 'P3'], ['medium', 'low', 'P4'],
  ['low', 'high', 'P3'], ['low', 'medium', 'P4'], ['low', 'low', 'P4'],
]) {
  test(`${impact} impact and ${urgency} urgency preview ${expected}`, () => {
    const input = { impact, urgency };
    const result = previewPriority(candidate, input);
    assert.equal(result.priority, expected);
    assert.equal(result.requiresHumanReview, true);
    assert.equal(result.evidence.documentId, 'ITSM-POL-001');
    assert.deepEqual(input, { impact, urgency });
  });
}
test('missing evidence never defaults to low priority', () => {
  const result = previewPriority(candidate, { impact: null, urgency: 'high' });
  assert.equal(result.priority, null);
  assert.equal(result.status, 'insufficient_information');
  assert.deepEqual(result.missingInformation, ['impact']);
});
test('legacy matrices never downgrade critical impact or immediate urgency when their axes are unsupported', () => {
  const result = previewPriority(candidate, { impact: 'critical', urgency: 'immediate' });
  assert.equal(result.priority, null);
  assert.equal(result.status, 'insufficient_information');
  assert.deepEqual(result.missingInformation, ['The active policy version does not define this impact/urgency combination.']);
  assert.ok(result.warnings.includes('POLICY_MATRIX_AXIS_UNSUPPORTED: no fallback or urgency downgrade was applied.'));
});
test('current matrix explicitly maps critical and immediate inputs using configured cells', () => {
  const current = validatePriorityCandidate({
    schemaVersion: 2, status: 'active', requiresHumanReview: true, source: candidate.source,
    matrix: {
      critical: { immediate: 'P1', high: 'P1', medium: 'P1', low: 'P2' },
      high: { immediate: 'P1', high: 'P2', medium: 'P2', low: 'P3' },
      medium: { immediate: 'P2', high: 'P2', medium: 'P3', low: 'P4' },
      low: { immediate: 'P3', high: 'P3', medium: 'P4', low: 'P4' },
    },
  });
  for (const [impact, urgency, expected] of [
    ['critical', 'immediate', 'P1'], ['high', 'high', 'P2'],
    ['medium', 'medium', 'P3'], ['low', 'low', 'P4'],
  ] as const) {
    const result = previewPriority(current, { impact, urgency });
    assert.equal(result.priority, expected);
    assert.equal(result.status, 'recommendation');
    assert.equal(result.requiresHumanReview, true);
  }
});
test('rejects invalid factors, permission/client overrides, incomplete matrices and approval claims', () => {
  for (const input of [{ impact: 'urgent', urgency: 'high' }, { impact: 'high', urgency: 'urgent' }, { impact: 'high', urgency: 'high', clientTier: 'bronze' }, { impact: 'high', urgency: 'high', roles: ['organisation_admin'] }]) {
    assert.throws(() => previewPriority(candidate, input));
  }
  assert.throws(() => validatePriorityCandidate({ ...candidate, requiresHumanReview: false }));
  assert.throws(() => validatePriorityCandidate({ ...candidate, matrix: { high: { high: 'P1' } } }));
});
test('reference catalogue and candidates point to unchanged source bytes', async () => {
  const catalogue = JSON.parse(await readFile(new URL('catalogue.json', root), 'utf8'));
  for (const source of catalogue.records) {
    const bytes = await readFile(new URL(source.path, root));
    assert.equal(createHash('sha256').update(bytes).digest('hex'), source.sha256);
    assert.equal(source.applicationStatus, 'reference_only');
    assert.equal(source.approval, null);
  }
  for (const name of ['priority-policy', 'sla-targets', 'support_agent-performance', 'support_lead-performance']) {
    const draft = JSON.parse(await readFile(new URL(`candidates/${name}.json`, root), 'utf8'));
    assert.equal(draft.status, 'draft');
    assert.equal(draft.source.sha256, createHash('sha256').update(await readFile(new URL(draft.source.path, root))).digest('hex'));
  }
});
test('SLA units and performance targets remain explicit draft data, not active calculations', async () => {
  const sla = JSON.parse(await readFile(new URL('candidates/sla-targets.json', root), 'utf8'));
  assert.equal(sla.targetsByClientTier.diamond.P1.response, '10 minutes');
  assert.equal(sla.targetsByClientTier.bronze.P4.resolution, '15 business days');
  assert.equal(sla.unitsNormalised, false);
  for (const [role, count] of [['support_agent', 8], ['support_lead', 9]] as const) {
    const draft = JSON.parse(await readFile(new URL(`candidates/${role}-performance.json`, root), 'utf8'));
    assert.equal(draft.kpas.length, count);
    assert.equal(draft.kpas.reduce((sum: number, kpa: { weightPercent: number }) => sum + kpa.weightPercent, 0), 100);
    assert.equal(draft.scoringFormula, null);
  }
});
