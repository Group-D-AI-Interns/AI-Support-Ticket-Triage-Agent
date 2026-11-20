import { Router, type Request } from 'express';
import * as z from 'zod';
import type { TenantContext } from '../../shared/tenant.js';
import type { Permission } from '../../shared/auth/authorization.js';
import { AiOperationsError, type AiOperationsService } from './operations-service.js';
import type { TriageJobs } from './triage-jobs.js';
import { runQualityEvaluation, type SampleEvaluator } from './quality-evaluation.js';

/** HTTP adapter: actor, tenant and capabilities always come from server authentication. */
export function operationsApi(operations: AiOperationsService, jobs: TriageJobs,
  authenticate: (request: Request, permissions: Permission[]) => TenantContext, evaluate?: SampleEvaluator) {
  const router = Router();
  const ai: Permission[] = ['tickets.ai.review', 'tickets.resolution.review'];
  const reason = z.strictObject({ reason: z.string().trim().min(1).max(2000) });
  const empty = z.strictObject({});
  const param = (request: Request, key: string) => z.string().min(1).parse(request.params[key]);
  const send = (response: import('express').Response, data: unknown, status = 200) => {
    response.setHeader('Cache-Control', 'no-store');
    response.status(status).json({ data, requestId: response.getHeader('x-request-id') });
  };
  router.get('/ai/routing-rules', async (req, res) => {
    const tenant = authenticate(req, ['configuration.manage']);
    send(res, await operations.store.list(tenant.organisationId, 'routing'));
  });
  router.post('/ai/routing-rules', async (req, res) => send(res,
    await operations.createRouting(authenticate(req, ['configuration.manage']), req.body), 201));
  for (const action of ['approve', 'disable'] as const) router.post(`/ai/routing-rules/:id/${action}`, async (req, res) => {
    const tenant = authenticate(req, ['configuration.manage']);
    send(res, await operations.decideRouting(tenant, param(req, 'id'), action, reason.parse(req.body).reason));
  });
  router.post('/tickets/:ticketId/verified-resolution', async (req, res) => send(res,
    await operations.verifyResolution(authenticate(req, [...ai, 'tickets.approve']), param(req, 'ticketId'), req.body), 201));
  router.post('/ai/verified-resolutions/:id/revoke', async (req, res) => {
    const tenant = authenticate(req, [...ai, 'tickets.approve']);
    await operations.revokeResolution(tenant, param(req, 'id'), reason.parse(req.body).reason);
    send(res, { revoked: true });
  });
  router.get('/tickets/:ticketId/triages', async (req, res) => send(res,
    await operations.reports(authenticate(req, ai), param(req, 'ticketId'))));
  router.post('/tickets/:ticketId/triages/:id/reviews', async (req, res) => send(res,
    await operations.review(authenticate(req, [...ai, 'tickets.approve']), param(req, 'ticketId'), param(req, 'id'), req.body), 201));
  router.post('/tickets/:ticketId/triage-jobs', async (req, res) => {
    const tenant = authenticate(req, ai); empty.parse(req.body ?? {});
    send(res, await jobs.enqueue(tenant, param(req, 'ticketId')), 202);
  });
  router.get('/ai/triage-jobs/:id', async (req, res) => send(res, await jobs.get(authenticate(req, ai), param(req, 'id'))));
  router.post('/ai/triage-jobs/:id/process', async (req, res) => {
    const tenant = authenticate(req, ai); empty.parse(req.body ?? {});
    await jobs.get(tenant, param(req, 'id')); // Enforce ownership before any work.
    await jobs.process(param(req, 'id'));
    send(res, await jobs.get(tenant, param(req, 'id')));
  });
  router.post('/ai/evaluations', async (req, res) => {
    const tenant = authenticate(req, ['configuration.manage', ...ai]);
    if (!evaluate) throw new AiOperationsError(503, 'TICKET_AI_NOT_CONFIGURED', 'Ticket AI is not enabled.');
    send(res, await runQualityEvaluation(operations.store, tenant, req.body, operations.deps.categories(), evaluate), 201);
  });
  router.get('/ai/evaluations', async (req, res) => {
    const tenant = authenticate(req, ['configuration.manage']);
    send(res, await operations.store.list(tenant.organisationId, 'evaluation'));
  });
  router.get('/ai/quality-summary', async (req, res) => {
    const tenant = authenticate(req, ['configuration.manage']);
    const reports = await operations.store.list(tenant.organisationId, 'report');
    const visible = new Set<string>();
    for (const ticketId of new Set(reports.map(row => row.data.ticketId))) {
      try { for (const row of await operations.reports(tenant, ticketId)) if (!row.redacted) visible.add(row.id); }
      catch (error) { if (!(error instanceof AiOperationsError && error.status === 404)) throw error; }
    }
    const labels = (await operations.store.list(tenant.organisationId, 'review')).filter(row => visible.has(row.data.reportId)).flatMap(row => row.data.quality ? [row.data.quality] : []);
    send(res, { reviewedSamples: labels.length, classificationAccuracy: labels.length ? labels.filter(row => row.classificationCorrect).length / labels.length : null,
      grounded: labels.filter(row => row.groundedness === 'grounded').length,
      partiallyGrounded: labels.filter(row => row.groundedness === 'partially_grounded').length,
      unsupported: labels.filter(row => row.groundedness === 'unsupported').length, method: 'human_reviewer_labels' });
  });
  router.use((error: unknown, _req: Request, res: import('express').Response, next: import('express').NextFunction) => {
    if (error instanceof z.ZodError || error instanceof AiOperationsError) {
      res.status(error instanceof AiOperationsError ? error.status : 400).json({ error: {
        code: error instanceof AiOperationsError ? error.code : 'VALIDATION_ERROR',
        message: error instanceof AiOperationsError ? error.message : 'The request body is invalid.', requestId: res.getHeader('x-request-id'),
      } }); return;
    }
    next(error);
  });
  return router;
}
