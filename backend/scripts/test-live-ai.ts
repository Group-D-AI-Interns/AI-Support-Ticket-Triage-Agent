import { createLiveTicketAiRuntime, liveTicketAiConfigurationFromEnvironment } from '../src/modules/ai/live-ticket-ai-runtime.js';

// Synthetic provider smoke test only. No HTTP auth bypass and no application data writes.
const environment = { ...process.env, APP_ENV: 'development', TICKET_AI_DEMO_ENABLED: 'false', TICKET_AI_LIVE_ENABLED: 'true',
  TICKET_AI_CATEGORIES: process.env.TICKET_AI_CATEGORIES || JSON.stringify([
    { id: 'ACCOUNT_ACCESS', name: 'Account access', description: 'Login failures and account lockouts' },
    { id: 'BILLING', name: 'Billing', description: 'Invoices and payments' },
  ]),
};
const deadline = setTimeout(() => { console.error('Live smoke test exceeded 90 seconds.'); process.exit(1); }, 90_000);
try {
  const configuration = liveTicketAiConfigurationFromEnvironment(environment);
  if (!configuration) throw new Error('Live configuration is disabled.');
  // Bound network time/cost for this test independently of normal runtime settings.
  configuration.timeoutMs = Math.min(configuration.timeoutMs, 15_000);
  configuration.inceptionMaxRetries = Math.min(configuration.inceptionMaxRetries, 1);
  configuration.inceptionBackoffBaseMs = Math.min(configuration.inceptionBackoffBaseMs, 1_000);
  configuration.inceptionBackoffMaxMs = Math.min(configuration.inceptionBackoffMaxMs, 2_000);
  const ticket = { id: 'synthetic-live-test', organisationId: 'synthetic-test-org',
    title: 'Unable to log in to my account', description: 'My account is locked. I reset my password twice but still cannot log in. The error is Account locked.' };
  const tenant = { organisationId: ticket.organisationId, userId: 'synthetic-test-user', roles: ['support_agent'] };
  const fetcher: typeof fetch = async (url, options) => {
    const response = await fetch(url, options);
    console.log(JSON.stringify({ providerHost: new URL(String(url)).hostname, httpStatus: response.status }));
    return response;
  };
  const runtime = createLiveTicketAiRuntime({ async getAuthorizedTicket() { return ticket; } }, configuration, environment, fetcher);
  console.log('Testing live AI with a synthetic ticket. No Keycloak login or persisted records are involved.');
  const result = await runtime.service.analyze({ tenant, ticketId: ticket.id, categories: configuration.categories, informationToCollect: ['Exact error message'] });
  console.log(JSON.stringify({ result: 'PASS', classification: result.classification, summary: result.summary,
    executions: result.executions.map(({ task, provider, model, attempts }) => ({ task, provider, model, attempts })) }, null, 2));
} catch (error) {
  const code = error && typeof error === 'object' && 'code' in error ? error.code : 'CONFIGURATION_OR_TEST_FAILURE';
  console.error(JSON.stringify({ result: 'FAIL', code }));
  process.exitCode = 1;
} finally { clearTimeout(deadline); }
