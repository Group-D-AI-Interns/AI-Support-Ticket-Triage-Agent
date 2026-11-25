import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { TicketAnalysisGraph } from '../src/modules/ai/ticket-analysis.graph.js';
import { TicketAiAnalysisService } from '../src/modules/ai/ticket-ai-analysis.service.js';
import { JsonAiAnalysisRepository } from '../src/modules/ai/json-ai-analysis.repository.js';
import { JsonFileStore } from '../src/infrastructure/persistence/json/json-file-store.js';
import { InMemoryAiAnalysisRepository } from '../src/modules/ai/local-demo-runtime.js';
import { AiExecutionRunner, AiExecutionError } from '../src/modules/ai/ai-execution-runner.js';
import { TicketClassifier } from '../src/modules/ai/components/ticket-classifier.js';
import { TicketSummarizer } from '../src/modules/ai/components/ticket-summarizer.js';
import { DeterministicFakeProvider } from '../src/infrastructure/llm/deterministic-fake-provider.js';
import { LlmProviderError } from '../src/infrastructure/llm/structured-generation-provider.js';
import type { AiTask, TicketAiAnalysis } from '../src/modules/ai/contracts.js';

const tenant = { organisationId: 'org-a', userId: 'agent', roles: ['support_agent'] };
const ticket = { id: 'ticket-a', organisationId: 'org-a', title: 'Locked account', description: 'Sensitive example text: account locked.' };
const categories = [{ id: 'ACCESS', name: 'Account access' }];
const classification = { categories: ['ACCESS'], reason: 'Account locked.', confidence: 0.9, evidence: [{ categoryId: 'ACCESS', field: 'title', start: 0, end: 14, excerpt: 'Locked account' }], requiresHumanReview: false, warnings: [] };
const summary = { summary: 'Account locked.', symptoms: ['Locked'], attemptedActions: [], affectedFunctionality: 'Account sign-in', businessImpact: null, missingInformation: [], warnings: [] };
function fixture(mode = 'complete') {
  const calls: AiTask[] = [];
  const provider = new DeterministicFakeProvider({ ticket_classification() {
    calls.push('ticket_classification');
    if (mode === 'failure') throw new LlmProviderError('REMOTE_FAILURE', 'secret-provider-error', false);
    if (mode === 'timeout') return new Promise(() => {});
    if (mode === 'invalid-classification') return { ...classification, categories: ['MADE_UP'] };
    if (mode === 'review') return { ...classification, categories: [], confidence: null, evidence: [], requiresHumanReview: true };
    return classification;
  }, ticket_summarization() { calls.push('ticket_summarization'); return mode === 'invalid-summary' ? { summary: 'Only one field' } : summary; } });
  const runner = new AiExecutionRunner(provider, { async record() {} }, { model: 'fixture', timeoutMs: 30, maxRetries: 0 });
  const classifier = new TicketClassifier(runner);
  const summarizer = new TicketSummarizer(runner);
  return { graph: new TicketAnalysisGraph(classifier, summarizer), classifier, summarizer, calls };
}

test('LangGraph calls existing components in order and returns typed execution and snapshot provenance', async () => {
  const f = fixture();
  const before = structuredClone(ticket);
  const result = await f.graph.run({ ticket, categories });
  assert.equal(result.status, 'completed');
  assert.deepEqual(result.trace, ['classify', 'summarize', 'complete']);
  assert.deepEqual(f.calls, ['ticket_classification', 'ticket_summarization']);
  assert.equal(result.orchestration.engine, 'langgraph');
  assert.equal(result.orchestration.promptVersions?.classification, 'ticket-classification-v2');
  assert.equal(result.orchestration.promptVersions?.summarization, 'ticket-summary-v2');
  assert.match(result.orchestration.snapshotHash, /^[a-f0-9]{64}$/);
  assert.equal(result.executions.length, 2);
  assert.deepEqual(ticket, before);
});

test('uncertain classification takes an explicit review branch and still returns the summary', async () => {
  const result = await fixture('review').graph.run({ ticket, categories });
  assert.equal(result.status, 'insufficient_information');
  assert.deepEqual(result.classification?.categories, []);
  assert.equal(result.summary?.summary, summary.summary);
  assert.equal(result.trace.at(-1), 'review');
});

test('invalid classification stops before summarization; invalid summary returns no complete analysis', async () => {
  const first = fixture('invalid-classification');
  const rejected = await first.graph.run({ ticket, categories });
  assert.equal(rejected.status, 'invalid_analysis');
  assert.equal(rejected.trace.at(-1), 'invalid');
  assert.deepEqual(first.calls, ['ticket_classification']);
  const second = await fixture('invalid-summary').graph.run({ ticket, categories });
  assert.equal(second.status, 'invalid_analysis');
  assert.equal(second.summary, null);
  assert.equal(second.executions.length, 1);
});

test('provider failure/timeout takes a separate branch without raw error text', async () => {
  for (const mode of ['failure', 'timeout']) {
    const result = await fixture(mode).graph.run({ ticket, categories });
    assert.equal(result.status, 'failed');
    assert.equal(result.trace.at(-1), 'execution_failed');
    assert.equal(JSON.stringify(result.failure).includes('secret-provider-error'), false);
  }
});

test('denied or malformed ticket data cannot reach graph nodes or durable history', async () => {
  for (const projection of [null, { ...ticket, organisationId: 'foreign' }, { ...ticket, title: 42 }]) {
    const f = fixture();
    const repository = new InMemoryAiAnalysisRepository();
    const service = new TicketAiAnalysisService({ async getAuthorizedTicket() { return projection as typeof ticket | null; } }, f.classifier, f.summarizer, repository);
    await assert.rejects(service.analyze({ tenant, ticketId: ticket.id, categories }));
    assert.equal(f.calls.length, 0);
    assert.equal((await repository.listWorkflowRuns(tenant, ticket.id)).length, 0);
  }
});

test('new authorized ticket/category data is loaded on the next run and graph invocations stay isolated', async () => {
  const f = fixture();
  let current = { ...ticket };
  const source = { async getAuthorizedTicket() { return current; } };
  const repository = new InMemoryAiAnalysisRepository();
  const service = new TicketAiAnalysisService(source, f.classifier, f.summarizer, repository);
  const first = await service.analyze({ tenant, ticketId: ticket.id, categories });
  current = { ...ticket, description: 'Updated ticket details from the ticket module.' };
  const second = await service.analyze({ tenant, ticketId: ticket.id, categories: [{ ...categories[0]!, description: 'New taxonomy description' }] });
  assert.notEqual(first.orchestration?.snapshotHash, second.orchestration?.snapshotHash);
  assert.notEqual(first.orchestration?.configurationHash, second.orchestration?.configurationHash);
  const parallel = await Promise.all([f.graph.run({ ticket, categories }), f.graph.run({ ticket: current, categories })]);
  assert.notEqual(parallel[0].orchestration.runId, parallel[1].orchestration.runId);
  assert.deepEqual(parallel[0].trace, parallel[1].trace);
  assert.equal((await repository.listWorkflowRuns(tenant, ticket.id)).length, 2);
});

test('workflow metadata reads recheck source access after permission revocation', async () => {
  const f = fixture();
  let permitted = true;
  const service = new TicketAiAnalysisService({ async getAuthorizedTicket() { return permitted ? ticket : null; } },
    f.classifier, f.summarizer, new InMemoryAiAnalysisRepository());
  await service.analyze({ tenant, ticketId: ticket.id, categories });
  assert.equal((await service.listWorkflowRuns(tenant, ticket.id)).length, 1);
  permitted = false;
  await assert.rejects(service.listWorkflowRuns(tenant, ticket.id));
  await assert.rejects(service.listAnalyses(tenant, ticket.id));
});

test('JSON history preserves legacy analyses and persists safe failed-run metadata with tenant isolation', async () => {
  const root = await mkdtemp(join(tmpdir(), 'ai-graph-history-'));
  try {
    const repository = new JsonAiAnalysisRepository(new JsonFileStore(root));
    const f = fixture();
    const good = new TicketAiAnalysisService({ async getAuthorizedTicket() { return ticket; } }, f.classifier, f.summarizer, repository);
    const analysis = await good.analyze({ tenant, ticketId: ticket.id, categories });
    const { orchestration: _metadata, ...legacy } = analysis;
    const { affectedFunctionality: _newSummaryField, ...legacySummary } = legacy.summary;
    await repository.save(tenant, { ...legacy, id: 'legacy-analysis', summary: legacySummary as TicketAiAnalysis['summary'] });
    const bad = fixture('invalid-classification');
    const service = new TicketAiAnalysisService({ async getAuthorizedTicket() { return ticket; } }, bad.classifier, bad.summarizer, repository);
    await assert.rejects(service.analyze({ tenant, ticketId: ticket.id, categories }), error => error instanceof AiExecutionError && error.code === 'INVALID_OUTPUT');
    const runs = await repository.listWorkflowRuns(tenant, ticket.id);
    assert.deepEqual(runs.map(run => run.status), ['completed', 'invalid_analysis']);
    const savedAnalyses = await repository.listForTicket(tenant, ticket.id);
    assert.equal(savedAnalyses.length, 2);
    assert.equal(savedAnalyses.find(row => row.id === 'legacy-analysis')?.summary.affectedFunctionality, null);
    assert.equal((await repository.listWorkflowRuns({ ...tenant, organisationId: 'foreign' }, ticket.id)).length, 0);
    assert.equal((await readFile(join(root, 'ai-workflow-runs.json'), 'utf8')).includes(ticket.description), false);
    await assert.rejects(repository.saveWorkflowRun({ ...tenant, organisationId: 'foreign' }, runs[0]!));
  } finally {
    assert.equal(dirname(root), resolve(tmpdir()));
    await rm(root, { recursive: true, force: true });
  }
});
