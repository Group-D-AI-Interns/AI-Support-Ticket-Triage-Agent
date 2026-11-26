import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, mkdir } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import * as z from 'zod';
import { createLiveTicketAiRuntime, liveTicketAiConfigurationFromEnvironment } from '../src/modules/ai/live-ticket-ai-runtime.js';
import { PriorityRecommender } from '../src/modules/ai/components/priority-recommender.js';
import { ProviderDocumentExtractionAdapter } from '../src/modules/ai/provider-document-extraction.adapter.js';
import { JsonAiAnalysisRepository } from '../src/modules/ai/json-ai-analysis.repository.js';
import { JsonFileStore } from '../src/infrastructure/persistence/json/json-file-store.js';

// Explicit live test. Only synthetic ticket/document/runbook data leaves this process.
// Keycloak, real application collections and shared configuration are untouched.
const environment = { ...process.env, APP_ENV: 'development', TICKET_AI_DEMO_ENABLED: 'false', TICKET_AI_LIVE_ENABLED: 'true',
  TICKET_AI_CATEGORIES: JSON.stringify([{ id: 'ACCOUNT_ACCESS', name: 'Account access' }]) };
const localRoot = resolve('.local-data');
await mkdir(localRoot, { recursive: true });
const root = await mkdtemp(join(localRoot, 'ai-workflow-smoke-'));
const deadline = setTimeout(() => { console.error('AI workflow test exceeded two minutes.'); process.exit(1); }, 120_000);
try {
  const configuration = liveTicketAiConfigurationFromEnvironment(environment)!;
  configuration.timeoutMs = Math.min(configuration.timeoutMs, 15_000);
  configuration.inceptionMaxRetries = Math.min(configuration.inceptionMaxRetries, 1);
  configuration.inceptionBackoffBaseMs = Math.min(configuration.inceptionBackoffBaseMs, 1_000);
  configuration.inceptionBackoffMaxMs = Math.min(configuration.inceptionBackoffMaxMs, 2_000);
  const ticket = { id: 'synthetic-workflow-ticket', organisationId: 'synthetic-org', title: 'Account locked after failed login attempts',
    description: 'My account is locked. Only my account is affected. I cannot work and have no workaround. I need access within one hour.' };
  const tenant = { organisationId: ticket.organisationId, userId: 'synthetic-agent', roles: ['support_agent'] };
  const repository = new JsonAiAnalysisRepository(new JsonFileStore(root));
  const runtime = createLiveTicketAiRuntime({ async getAuthorizedTicket() { return ticket; } }, configuration, environment, undefined, repository);
  const policy = JSON.parse(await readFile('data/reference/candidates/priority-policy.json', 'utf8'));
  const service = runtime.createTriageService({ priority: new PriorityRecommender(runtime.priorityRunner, policy, 0.75),
    knowledge: { async listAuthorizedDocuments() { return [{ id: 'SYNTHETIC-RUNBOOK', version: '1', organisationId: tenant.organisationId,
      sourceType: 'knowledge_article', title: 'Synthetic account lockout procedure',
      content: 'For an account locked after failed login attempts: wait 15 minutes before trying to log in again. If the account remains locked, contact the service desk and provide the exact error message.',
      approved: true, status: 'active', effectiveFrom: '2020-01-01T00:00:00Z', effectiveTo: null }]; } },
    routing: { async getAuthorizedRoutingContext() { return { organisationId: tenant.organisationId,
      eligibleTeams: [{ id: 'synthetic-account-team', organisationId: tenant.organisationId, name: 'Synthetic account support' }],
      rules: [{ id: 'synthetic-routing-rule', version: '1', organisationId: tenant.organisationId, teamId: 'synthetic-account-team', categoryIds: ['ACCOUNT_ACCESS'], approved: true, effectiveFrom: '2020-01-01T00:00:00Z', effectiveTo: null }] }; } },
  });
  console.log('Live AI-only verification: synthetic identity and evidence; no Keycloak changes.');
  const result = await service.analyze({ tenant, ticketId: ticket.id, categories: configuration.categories });
  assert.equal(result.core.orchestration?.engine, 'langgraph');
  assert.equal(result.core.classification.category, 'ACCOUNT_ACCESS');
  assert.equal(result.priority.status, 'completed');
  assert.equal(result.resolution.status, 'completed');
  assert.equal(result.routing.status, 'completed');
  assert.equal(result.routing.data.status, 'recommendation');
  assert.equal(result.sla.status, 'completed');
  assert.equal(result.sla.data.status, 'unavailable');
  assert.equal((await repository.listWorkflowRuns(tenant, ticket.id)).length, 1);
  const extractor = new ProviderDocumentExtractionAdapter(runtime.priorityRunner, {
    response_time: { description: 'Explicit response time in hours; convert written numbers to numeric hours.', payload: z.strictObject({ targetHours: z.number().finite().nonnegative() }) },
  });
  const extraction = await extractor.extract({ tenant, documentId: 'synthetic-document', documentVersionId: 'synthetic-version', executionId: 'synthetic-job',
    content: 'For account access support, the first response must be within two hours.',
    segments: [{ text: 'For account access support, the first response must be within two hours.', page: 1 }] });
  assert.equal(extraction.status, 'succeeded');
  assert.equal(extraction.rules[0]?.payload.targetHours, 2);
  assert.equal(extraction.rules[0]?.requiresHumanReview, true);
  console.log(JSON.stringify({ result: 'PASS', fixtureOnly: true, orchestration: result.core.orchestration,
    classification: result.core.classification.category, priorityStatus: result.priority.data.status,
    resolutionStatus: result.resolution.data.status, routing: result.routing.data.teamId,
    slaStatus: result.sla.data.status, extraction: { provider: extraction.executionMetadata.provider, candidateCount: extraction.rules.length, reviewRequired: true },
    realTeamAdaptersConnected: false }, null, 2));
} catch (error) {
  const code = error && typeof error === 'object' && 'code' in error ? error.code : 'CONFIGURATION_OR_TEST_FAILURE';
  console.error(JSON.stringify({ result: 'FAIL', code }));
  process.exitCode = 1;
} finally {
  clearTimeout(deadline);
  if (dirname(root) !== localRoot || !root.startsWith(join(localRoot, 'ai-workflow-smoke-'))) throw new Error('Unexpected smoke directory.');
  await rm(root, { recursive: true, force: true });
}
