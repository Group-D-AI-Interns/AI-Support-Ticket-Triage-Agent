import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { createHash } from 'node:crypto';
import { validatePriorityCandidate, type PriorityCandidate } from './components/priority-matrix.js';
import type { AiExecutionRunner } from './ai-execution-runner.js';

export type PriorityPreviewConfiguration = {
  candidate: PriorityCandidate;
  minimumConfidence: number;
  /** Injection for isolated tests; normal runtime uses its existing provider runner. */
  runner?: AiExecutionRunner;
};
export function priorityPreviewFromEnvironment(environment: NodeJS.ProcessEnv = process.env): PriorityPreviewConfiguration | null {
  const enabled = environment.TICKET_PRIORITY_PREVIEW_ENABLED;
  if (enabled === undefined || enabled === 'false') return null;
  if (enabled !== 'true' || environment.APP_ENV !== 'development') {
    throw new Error('Priority draft previews require explicit development opt-in.');
  }
  const raw = environment.TICKET_PRIORITY_MIN_CONFIDENCE;
  const minimumConfidence = Number(raw);
  if (!raw?.trim() || !Number.isFinite(minimumConfidence) || minimumConfidence < 0 || minimumConfidence > 1) {
    throw new Error('TICKET_PRIORITY_MIN_CONFIDENCE must explicitly specify a number between 0 and 1.');
  }
  const root = resolve('data/reference');
  const candidate = validatePriorityCandidate(JSON.parse(readFileSync(resolve(root, 'candidates/priority-policy.json'), 'utf8')));
  // This loader reads the checked-in reference only, never a client-supplied path.
  if (candidate.source.path !== 'policies/priority-policy.md' ||
    createHash('sha256').update(readFileSync(resolve(root, candidate.source.path))).digest('hex') !== candidate.source.sha256) {
    throw new Error('Priority draft source checksum mismatch; review the reference version.');
  }
  return { candidate, minimumConfidence };
}
