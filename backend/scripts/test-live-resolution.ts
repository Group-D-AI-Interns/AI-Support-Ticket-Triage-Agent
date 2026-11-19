import { createLiveTicketAiRuntime, liveTicketAiConfigurationFromEnvironment } from '../src/modules/ai/live-ticket-ai-runtime.js';
import { ResolutionRecommendationService } from '../src/modules/ai/resolution-recommendation.service.js';
import { KnowledgeRetriever } from '../src/modules/knowledge/retrieval.js';

// Explicit live smoke test: synthetic approved runbook only, no application data writes.
const environment = { ...process.env, APP_ENV: 'development', TICKET_AI_DEMO_ENABLED: 'false', TICKET_AI_LIVE_ENABLED: 'true',
  TICKET_AI_CATEGORIES: JSON.stringify([{ id: 'ACCOUNT_ACCESS', name: 'Account access' }]),
};
const deadline = setTimeout(() => { console.error('Resolution smoke test exceeded 60 seconds.'); process.exit(1); }, 60_000);
try {
  const configuration = liveTicketAiConfigurationFromEnvironment(environment);
  if (!configuration) throw new Error('Live configuration is disabled.');
  configuration.timeoutMs = Math.min(configuration.timeoutMs, 15_000);
  configuration.inceptionMaxRetries = Math.min(configuration.inceptionMaxRetries, 1);
  configuration.inceptionBackoffBaseMs = Math.min(configuration.inceptionBackoffBaseMs, 1_000);
  configuration.inceptionBackoffMaxMs = Math.min(configuration.inceptionBackoffMaxMs, 2_000);
  const ticket = { id: 'synthetic-resolution-test', organisationId: 'synthetic-test-org',
    title: 'Account locked after failed login attempts', description: 'Account locked message. I need the approved account lockout procedure.' };
  const tenant = { organisationId: ticket.organisationId, userId: 'synthetic-test-user', roles: ['support_agent'] };
  const source = { async getAuthorizedTicket() { return ticket; } };
  const runtime = createLiveTicketAiRuntime(source, configuration, environment);
  const retrieval = new KnowledgeRetriever({ async listAuthorizedDocuments() { return [{
    id: 'SYNTHETIC-RUNBOOK', version: '1', organisationId: tenant.organisationId, sourceType: 'knowledge_article' as const,
    title: 'Synthetic account lockout runbook', approved: true, status: 'active' as const, effectiveFrom: '2020-01-01T00:00:00.000Z', effectiveTo: null,
    content: 'For an account locked after failed login attempts: wait 15 minutes before trying to log in again. If the account remains locked, contact the service desk and provide the exact error message. Never share passwords.',
  }]; } });
  const service = new ResolutionRecommendationService(source, retrieval, runtime.priorityRunner);
  console.log('Testing live resolution with SYNTHETIC evidence. No real policy approval, ticket reads or data writes.');
  const result = await service.recommend(tenant, ticket.id);
  console.log(JSON.stringify({ result: result.status === 'recommendation' ? 'PASS' : 'SAFE_DECLINE', fixtureOnly: true, status: result.status, summary: result.summary,
    steps: result.steps, missingInformation: result.missingInformation, warnings: result.warnings, requiresHumanReview: result.requiresHumanReview,
    execution: result.execution }, null, 2));
} catch (error) {
  const code = error && typeof error === 'object' && 'code' in error ? error.code : 'CONFIGURATION_OR_TEST_FAILURE';
  console.error(JSON.stringify({ result: 'FAIL', code }));
  process.exitCode = 1;
} finally { clearTimeout(deadline); }
