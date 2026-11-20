import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import type { TenantContext } from '../src/shared/auth/authentication.js';
import { JsonTicketStore } from '../src/modules/tickets/repositories/json-ticket.store.js';
import {
  legacySlaPriorityFor,
  normalizeStoredTicketPriority,
  normalizeTicketPriority,
} from '../src/modules/tickets/domain/priority.js';

test('normalizes legacy internal labels to the agreed P1-P4 contract', () => {
  assert.equal(normalizeStoredTicketPriority('high'), 'P2');
  assert.equal(normalizeStoredTicketPriority('medium'), 'P3');
  assert.equal(normalizeStoredTicketPriority('low'), 'P4');
  assert.equal(normalizeTicketPriority('p1'), 'P1');
  assert.equal(normalizeTicketPriority('not-a-priority'), null);
});

test('maps canonical priorities to legacy SLA targets only when labels match', () => {
  assert.equal(legacySlaPriorityFor('P1'), undefined);
  assert.equal(legacySlaPriorityFor('P2'), 'high');
  assert.equal(legacySlaPriorityFor('P3'), 'medium');
  assert.equal(legacySlaPriorityFor('P4'), 'low');
});

test('reads legacy ticket priorities through the canonical P1-P4 mapping', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'ticket-priority-'));
  const tenant: TenantContext = {
    organisationId: 'org-a',
    userId: 'user-a',
    roles: [],
  };
  try {
    await writeFile(
      join(directory, 'tickets.json'),
      JSON.stringify({
        schemaVersion: 1,
        records: [{
          id: 'ticket-a',
          organisationId: 'org-a',
          requesterId: 'user-a',
          title: 'Legacy ticket',
          priority: 'high',
          createdAt: '2026-01-01T00:00:00.000Z',
          updatedAt: '2026-01-01T00:00:00.000Z',
        }],
      }),
    );
    const ticket = await new JsonTicketStore(directory).findTicket(tenant, 'ticket-a');
    assert.equal(ticket?.priority, 'P2');
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
