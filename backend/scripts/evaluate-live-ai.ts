import { readFile, mkdir, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { createLiveTicketAiRuntime, liveTicketAiConfigurationFromEnvironment } from '../src/modules/ai/live-ticket-ai-runtime.js';
import { evaluationDataset, runQualityEvaluation } from '../src/modules/ai/quality-evaluation.js';
import { AiOperationsStore } from '../src/modules/ai/operations-store.js';
import { JsonFileStore } from '../src/infrastructure/persistence/json/json-file-store.js';

// Explicit live test: only checked-in synthetic evaluation cases leave this process.
// Isolated output; no ticket source, identity changes, policy activation or automatic worker.
const rounds = Number(process.argv[2] ?? 2);
if (!Number.isInteger(rounds) || rounds < 1 || rounds > 3) throw new Error('Choose 1..3 evaluation rounds.');
const configuration = liveTicketAiConfigurationFromEnvironment(process.env);
if (!configuration) throw new Error('This explicit test needs configured live ticket AI.');
configuration.timeoutMs = Math.min(configuration.timeoutMs, 15000);
configuration.inceptionMaxRetries = Math.min(configuration.inceptionMaxRetries, 1);
configuration.inceptionBackoffBaseMs = Math.min(configuration.inceptionBackoffBaseMs, 1000);
configuration.inceptionBackoffMaxMs = Math.min(configuration.inceptionBackoffMaxMs, 2000);
const dataset: unknown = JSON.parse(await readFile('data/evaluation/triage-v2.json', 'utf8'));
if (!dataset || typeof dataset !== 'object' || !Array.isArray((dataset as { cases?: unknown }).cases)) throw new Error('Invalid dataset.');
const cases = (dataset as { cases: unknown[] }).cases;
const parsed = cases.map(item => evaluationDataset.shape.cases.element.parse(item));
if (parsed.some(item => item.expectedCategory && !configuration.categories.some(category => category.id === item.expectedCategory))) throw new Error('Dataset labels must match the configured taxonomy.');
const root = resolve('.local-data', `reliability-${new Date().toISOString().replace(/[:.]/g, '-')}`);
await mkdir(root, { recursive: true });
const store = new AiOperationsStore(new JsonFileStore(root));
const runtime = createLiveTicketAiRuntime({ async getAuthorizedTicket() { return null; } }, configuration);
const tenant = { organisationId: 'synthetic-evaluation', userId: 'synthetic-evaluator', roles: [] };
const runs = [];
for (let round = 1; round <= rounds; round++) {
  for (let start = 0; start < parsed.length; start += 6) {
    const run = await runQualityEvaluation(store, tenant, { version: `support-triage-v2-round-${round}-batch-${start / 6 + 1}`, cases: parsed.slice(start, start + 6) }, configuration.categories, runtime.evaluateSample);
    runs.push(run);
    console.log(JSON.stringify({ round, batch: start / 6 + 1, metrics: (run.data as { metrics: unknown }).metrics }));
  }
}
type Outcome = { caseId: string; status: string; categoryCorrect?: boolean; recoveredValidation?: boolean; prohibitedFactsPresent?: number; errorCode?: string };
const outcomes = runs.flatMap(run => (run.data as { cases: Outcome[] }).cases);
const completed = outcomes.filter(item => item.status === 'completed');
const metrics = { samples: outcomes.length, completed: completed.length, failed: outcomes.length - completed.length,
  completionRate: completed.length / outcomes.length,
  firstPassCompletionRate: completed.filter(item => !item.recoveredValidation).length / outcomes.length,
  recoveredCases: completed.filter(item => item.recoveredValidation).length,
  categoryAccuracyOverAllCases: completed.filter(item => item.categoryCorrect).length / outcomes.length,
  prohibitedPhraseHits: completed.reduce((sum, item) => sum + (item.prohibitedFactsPresent ?? 0), 0) };
const passed = metrics.completionRate === 1 && metrics.firstPassCompletionRate >= 0.9 && metrics.categoryAccuracyOverAllCases >= 0.9 && metrics.prohibitedPhraseHits === 0;
await writeFile(resolve(root, 'summary.json'), JSON.stringify({ passed, fixtureOnly: true, rounds, metrics, outcomes, semanticGroundedness: 'human_review_required', thresholdsStatus: 'engineering_proposal_not_production_approval' }, null, 2));
console.log(JSON.stringify({ passed, metrics, summaryPath: resolve(root, 'summary.json'), semanticGroundedness: 'human_review_required' }));
if (!passed) process.exitCode = 1;
