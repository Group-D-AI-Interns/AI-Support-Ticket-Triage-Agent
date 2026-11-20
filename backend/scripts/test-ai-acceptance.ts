import { readFile, writeFile } from 'node:fs/promises';
import assert from 'node:assert/strict';
import { z } from 'zod';

// Explicit authorized API acceptance. Never creates roles, approves policies, assigns or closes tickets.
const identifier = z.string().min(1).refine(value => !value.startsWith('REPLACE_WITH_'), 'Replace example IDs with existing approved records.');
const schema = z.strictObject({ organisationId: identifier, ticketId: identifier, historicalTicketId: identifier,
  expectedTeamId: identifier, expectedSlaPolicyVersionId: identifier });
const input = schema.parse(JSON.parse(await readFile('.local-data/ai-acceptance-input.json', 'utf8')));
assert.notEqual(input.ticketId, input.historicalTicketId, 'Use a different ticket for historical retrieval.');
const token = (await readFile('.local-data/postman-access-token.txt', 'utf8')).trim();
if (!token || /^Bearer\s/i.test(token)) throw new Error('Save only the access token in the ignored local token file.');
const base = 'http://127.0.0.1:3000/api/v1';
const checks: Array<{ name: string; status: number }> = [];
const report: Record<string, unknown> = { startedAt: new Date().toISOString(), input, checks, passed: false };
async function call(name: string, path: string, method = 'GET', body?: unknown, expected = 200) {
  const response = await fetch(base + path, { method, headers: { authorization: `Bearer ${token}`, 'x-organisation-id': input.organisationId,
    ...(body === undefined ? {} : { 'content-type': 'application/json' }) },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }), signal: AbortSignal.timeout(240000) });
  const result = await response.json();
  checks.push({ name, status: response.status }); console.log(JSON.stringify({ name, status: response.status }));
  assert.equal(response.status, expected, `${name} failed (${result.error?.code ?? 'unexpected status'}).`);
  return result.data;
}
try {
  const me = await call('Current application identity', '/me');
  assert.ok(me.organisations.some((row: { organisationId: string; permissions: string[] }) => row.organisationId === input.organisationId &&
    ['tickets.ai.review', 'tickets.resolution.review', 'tickets.approve', 'configuration.manage'].every(permission => row.permissions.includes(permission))),
  'This acceptance flow needs existing AI, review and SLA permissions; it grants none.');
  const path = `/tickets/${encodeURIComponent(input.ticketId)}`;
  const before = await call('Read legitimate target ticket', path);
  const similar = await call('Verified historical retrieval', `${path}/similar`);
  assert.ok(similar.some((row: {sourceId: string; sourceType: string}) => row.sourceId === input.historicalTicketId && row.sourceType === 'historical_ticket'),
    'The reviewed historical resolution must be visible and relevant to this ticket.');
  const triage = await call('Full live triage', `${path}/triage`, 'POST', {});
  assert.equal(triage.core.orchestration.engine, 'langgraph');
  assert.equal(triage.requiresHumanReview, true);
  assert.equal(triage.routing.status, 'completed'); assert.equal(triage.routing.data.teamId, input.expectedTeamId);
  assert.equal(triage.sla.status, 'completed'); assert.equal(triage.sla.data.status, 'available');
  assert.equal(triage.sla.data.evaluation.policyVersionId, input.expectedSlaPolicyVersionId);
  assert.equal(triage.resolution.status, 'completed');
  report.triageId = triage.triageId;
  report.resolutionStatus = triage.resolution.data.status; // Insufficient evidence is safe, but cannot pass the full guidance acceptance gate.
  const history = await call('Read persisted combined history', `${path}/triages`);
  assert.ok(history.some((row: { id: string; redacted: boolean }) => row.id === triage.triageId && row.redacted === false));
  await call('Exercise human-review recording without accepting recommendations', `${path}/triages/${encodeURIComponent(triage.triageId)}/reviews`, 'POST',
    { decision: 'needs_information', reason: 'Automated acceptance exercised review recording. A person must verify recommendations before accepting or applying them.' }, 201);
  const job = await call('Queue under the current authorized user', `${path}/triage-jobs`, 'POST', {}, 202);
  const processed = await call('Process leased job', `/ai/triage-jobs/${encodeURIComponent(job.id)}/process`, 'POST', {});
  assert.equal(processed.data.status, 'completed'); assert.ok(processed.data.reportId);
  report.jobId = job.id; report.jobReportId = processed.data.reportId;
  const repeated = await call('Repeated processing is idempotent', `/ai/triage-jobs/${encodeURIComponent(job.id)}/process`, 'POST', {});
  assert.equal(repeated.data.reportId, processed.data.reportId); assert.equal(repeated.data.attempts, processed.data.attempts);
  const finalHistory = await call('Queued report is readable', `${path}/triages`);
  assert.ok(finalHistory.some((row: { id: string; redacted: boolean }) => row.id === processed.data.reportId && !row.redacted));
  const queuedReport = finalHistory.find((row: {id: string}) => row.id === processed.data.reportId);
  assert.equal(queuedReport.data.result.routing.data.teamId, input.expectedTeamId);
  assert.equal(queuedReport.data.result.sla.data.status, 'available');
  assert.equal(queuedReport.data.result.sla.data.evaluation.policyVersionId, input.expectedSlaPolicyVersionId);
  const after = await call('Ticket remains unchanged', path);
  assert.ok(JSON.stringify(after) === JSON.stringify(before), 'The source ticket changed during acceptance; inspect its revisions.');
  assert.equal(triage.resolution.data.status, 'recommendation', 'API integration worked, but evidence did not support resolution guidance. Human evidence review is still required.');
  report.passed = true;
} catch (error) {
  report.error = error instanceof Error ? error.message : 'Acceptance failed.';
  console.error(JSON.stringify({ error: report.error })); process.exitCode = 1;
} finally {
  report.completedAt = new Date().toISOString();
  await writeFile('.local-data/ai-acceptance-results.json', JSON.stringify(report, null, 2));
}
