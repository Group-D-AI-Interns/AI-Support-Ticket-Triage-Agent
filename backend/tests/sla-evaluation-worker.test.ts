import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import type { TenantContext } from '../src/shared/auth/authentication.js';
import { JsonTicketStore } from '../src/modules/tickets/repositories/json-ticket.store.js';
import type { SlaEvaluationService } from '../src/modules/sla/services/sla-evaluation.service.js';
import { SlaEvaluationWorker } from '../src/modules/sla/services/sla-evaluation-worker.js';

const tenant: TenantContext = {
  organisationId: 'org-a',
  userId: 'user-a',
  roles: ['support_agent'],
};

test('ticket-store SLA triggers cover relevant writes and exclude unrelated comments and attachments', async () => {
  const root = await mkdtemp(join(tmpdir(), 'sla-worker-store-'));
  try {
    const store = new JsonTicketStore(root);
    const changes: Array<{ organisationId: string; ticketId: string }> = [];
    store.subscribeToTicketChanges((change) => changes.push(change));
    const ticket = await store.createTicket(
      {
        organisationId: tenant.organisationId,
        requesterId: 'requester-a',
        title: 'Billing portal error',
        description: 'The billing portal is unavailable.',
        status: 'new',
      },
      tenant,
    );
    await store.updateTicket(tenant, ticket.id, { priority: 'P2' });
    await store.addComment(tenant, ticket.id, {
      authorId: tenant.userId,
      body: 'Internal note',
      visibility: 'internal',
    });
    await store.addComment(
      tenant,
      ticket.id,
      {
        authorId: tenant.userId,
        body: 'We are investigating this issue.',
        visibility: 'public',
      },
      true,
    );
    await store.addAttachment(tenant, ticket.id, {
      id: 'attachment-a',
      fileName: 'evidence.png',
      mimeType: 'image/png',
      storageKey: 'private/org-a/attachment-a/evidence.png',
      checksumSha256: 'abc123',
      fileSizeBytes: 123,
      uploadedBy: tenant.userId,
    });

    assert.deepEqual(changes, [
      { organisationId: tenant.organisationId, ticketId: ticket.id },
      { organisationId: tenant.organisationId, ticketId: ticket.id },
      { organisationId: tenant.organisationId, ticketId: ticket.id },
    ]);

    await store.changeStatus(
      tenant,
      ticket.id,
      'new',
      'in_progress',
      undefined,
      'workflow-a',
    );
    assert.equal(changes.length, 4);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('persisted ticket changes enqueue an event-triggered evaluation', async () => {
  const root = await mkdtemp(join(tmpdir(), 'sla-worker-event-'));
  const tickets = new JsonTicketStore(root);
  let resolveEvaluation:
    | ((result: { tenant: TenantContext; ticketId: string }) => void)
    | undefined;
  const evaluation = new Promise<{
    tenant: TenantContext;
    ticketId: string;
  }>((resolve) => {
    resolveEvaluation = resolve;
  });
  const service: Pick<SlaEvaluationService, 'evaluateTicket'> = {
    evaluateTicket: async (evaluationTenant, ticketId) => {
      resolveEvaluation?.({ tenant: evaluationTenant, ticketId });
      return null;
    },
  };
  const worker = new SlaEvaluationWorker(service, tickets, {
    intervalMs: 60000,
    listOrganisationIds: async () => [],
    logger: { error: () => {} },
  });
  const unsubscribe = tickets.subscribeToTicketChanges((change) => {
    worker.enqueue(change.organisationId, change.ticketId);
  });

  try {
    const ticket = await tickets.createTicket(
      {
        organisationId: tenant.organisationId,
        requesterId: 'requester-a',
        title: 'Billing portal error',
        description: 'The billing portal is unavailable.',
        status: 'new',
      },
      tenant,
    );
    let timeout: NodeJS.Timeout | undefined;
    try {
      const observed = await Promise.race([
        evaluation,
        new Promise<never>((_resolve, reject) => {
          timeout = setTimeout(
            () => reject(new Error('Ticket change did not enqueue evaluation.')),
            1000,
          );
        }),
      ]);
      assert.deepEqual(observed, {
        tenant: {
          organisationId: tenant.organisationId,
          userId: 'sla-evaluation-worker',
          roles: [],
        },
        ticketId: ticket.id,
      });
    } finally {
      if (timeout) clearTimeout(timeout);
    }
  } finally {
    unsubscribe();
    worker.stop();
    await rm(root, { recursive: true, force: true });
  }
});

test('worker deduplicates queued ticket events and polls on its configured interval', async () => {
  const root = await mkdtemp(join(tmpdir(), 'sla-worker-poll-'));
  try {
    const tickets = new JsonTicketStore(root);
    const ticketData = {
      organisationId: 'org-a',
      requesterId: 'requester-a',
      title: 'Billing portal error',
      description: 'The billing portal is unavailable.',
      status: 'new',
    };
    const invalidTicket = await tickets.createTicket(ticketData, tenant);
    const validTicket = await tickets.createTicket(
      { ...ticketData, title: 'Login failure' },
      tenant,
    );
    const evaluations: Array<{ tenant: TenantContext; ticketId: string }> = [];
    let validEvaluations = 0;
    let resolveThirdValidEvaluation: (() => void) | undefined;
    const thirdValidEvaluation = new Promise<void>((resolve) => {
      resolveThirdValidEvaluation = resolve;
    });
    const loggedErrors: string[] = [];
    const service: Pick<SlaEvaluationService, 'evaluateTicket'> = {
      evaluateTicket: async (evaluationTenant, ticketId) => {
        evaluations.push({ tenant: evaluationTenant, ticketId });
        if (ticketId === invalidTicket.id) {
          throw new Error('Invalid ticket evidence.');
        }
        if (ticketId === validTicket.id) {
          validEvaluations += 1;
          if (validEvaluations >= 3) resolveThirdValidEvaluation?.();
        }
        return null;
      },
    };
    const worker = new SlaEvaluationWorker(service, tickets, {
      intervalMs: 20,
      listOrganisationIds: async () => ['org-a'],
      logger: {
        error: (message) => loggedErrors.push(message),
      },
    });

    worker.enqueue('org-a', validTicket.id);
    worker.enqueue('org-a', validTicket.id);
    await new Promise<void>((resolve) => setImmediate(resolve));
    assert.equal(
      evaluations.filter(({ ticketId }) => ticketId === validTicket.id).length,
      1,
    );
    assert.deepEqual(evaluations[0], {
      tenant: {
        organisationId: 'org-a',
        userId: 'sla-evaluation-worker',
        roles: [],
      },
      ticketId: validTicket.id,
    });

    let timeout: NodeJS.Timeout | undefined;
    worker.start();
    try {
      await Promise.race([
        thirdValidEvaluation,
        new Promise<never>((_resolve, reject) => {
          timeout = setTimeout(
            () => reject(new Error('Scheduled SLA evaluation did not run.')),
            1000,
          );
        }),
      ]);
      assert.ok(validEvaluations >= 3);
      assert.ok(loggedErrors.length >= 2);
    } finally {
      if (timeout) clearTimeout(timeout);
      worker.stop();
    }
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
