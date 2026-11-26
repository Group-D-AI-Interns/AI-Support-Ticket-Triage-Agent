import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { JsonFileStore } from '../src/infrastructure/persistence/json/json-file-store.js';
import { createLocalDemoTicketAiRuntime } from '../src/modules/ai/local-demo-runtime.js';
import { AiOperationsStore } from '../src/modules/ai/operations-store.js';
import { runQualityEvaluation } from '../src/modules/ai/quality-evaluation.js';

const dataset = JSON.parse(await readFile('data/evaluation/triage-v1.json', 'utf8')) as unknown;
const categories = [
  { id: 'ACCOUNT_ACCESS', name: 'Account access' },
  { id: 'BILLING', name: 'Billing' },
];
const tenant = { organisationId: 'synthetic-evaluation', userId: 'synthetic-evaluator', roles: [] };
const directory = await mkdtemp(join(tmpdir(), 'support-ai-eval-'));

try {
  const store = new AiOperationsStore(new JsonFileStore(directory));
  const runtime = createLocalDemoTicketAiRuntime({ async getAuthorizedTicket() { return null; } });
  const run = await runQualityEvaluation(store, tenant, dataset, categories, runtime.evaluateSample);
  const data = run.data as {
    datasetVersion: string;
    metrics: Record<string, unknown>;
    cases: Array<{ caseId: string; status: string; categoryCorrect?: boolean; matchedFacts?: number; requiredFacts?: number; prohibitedFactsPresent?: number; errorCode?: string }>;
  };
  // Emit aggregate metrics and opaque case IDs only; never print ticket text or provider output.
  console.log(JSON.stringify({ evaluation: 'local-demo-only', datasetVersion: data.datasetVersion, metrics: data.metrics,
    cases: data.cases.map(({ caseId, status, categoryCorrect, matchedFacts, requiredFacts, prohibitedFactsPresent, errorCode }) =>
      ({ caseId, status, categoryCorrect, matchedFacts, requiredFacts, prohibitedFactsPresent, errorCode })),
    limitations: ['Deterministic local heuristic, not a live model evaluation.', 'Summary coverage is a lexical proxy.', 'Retrieval, priority, routing, resolution quality and semantic groundedness are not scored.'] }));
} finally {
  await rm(directory, { recursive: true, force: true });
}
