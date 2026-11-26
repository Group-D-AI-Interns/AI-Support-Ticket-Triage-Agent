import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import type { TenantContext } from '../src/shared/tenant.js';
import { JsonTicketReadService } from '../src/modules/tickets/application/ticket-read.service.js';
import { JsonTicketStore } from '../src/modules/tickets/repositories/json-ticket.store.js';

const tenantA: TenantContext = {
  organisationId: 'org-a',
  userId: 'user-a',
  roles: ['support_agent'],
};
const tenantB: TenantContext = {
  organisationId: 'org-b',
  userId: 'user-b',
  roles: ['support_agent'],
};

test('ticket read service returns stable tenant-scoped ticket data only', async () => {
  const root = await mkdtemp(join(tmpdir(), 'ticket-read-'));
  try {
    const store = new JsonTicketStore(root);
    const ticket = await store.createTicket(
      {
        organisationId: tenantA.organisationId,
        requesterId: 'requester-a',
        title: 'Billing portal error',
        description: { message: 'Unexpected error' },
        status: 'new',
      },
      tenantA,
    );
    await store.addComment(tenantA, ticket.id, {
      authorId: tenantA.userId,
      body: 'Internal note',
      visibility: 'internal',
    });
    await store.addAttachment(tenantA, ticket.id, {
      id: 'attachment-a',
      fileName: 'evidence.png',
      mimeType: 'image/png',
      storageKey: 'private/org-a/attachment-a/evidence.png',
      checksumSha256: 'abc123',
      fileSizeBytes: 123,
      uploadedBy: tenantA.userId,
    });

    const readService = new JsonTicketReadService(store);
    const readTicket = await readService.getTicket(tenantA, ticket.id);
    const listedTickets = await readService.listTickets(tenantA);

    assert.equal(readTicket?.id, ticket.id);
    assert.equal(readTicket?.organisationId, tenantA.organisationId);
    assert.equal(readTicket?.title, 'Billing portal error');
    assert.equal('comments' in (readTicket ?? {}), false);
    assert.equal('attachments' in (readTicket ?? {}), false);
    assert.equal(listedTickets.length, 1);
    assert.equal(await readService.getTicket(tenantB, ticket.id), null);
    assert.deepEqual(await readService.listTickets(tenantB), []);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
