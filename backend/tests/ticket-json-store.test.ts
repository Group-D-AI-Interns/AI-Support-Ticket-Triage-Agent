import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  TicketConflictError,
  TicketJsonStore,
} from '../src/modules/tickets/ticket-json-store.js';

function createDirectory(): string {
  return mkdtempSync(join(tmpdir(), 'ticket-store-'));
}

test('creates tenant-scoped tickets and preserves the versioned JSON envelope', async () => {
  const directory = createDirectory();
  try {
    const store = new TicketJsonStore(directory);
    const created = await store.createTicket({
      organisationId: 'org-a',
      requesterId: 'user-a',
      title: 'Unable to sign in',
      description: 'The account is locked.',
      status: 'new',
    }, 'user-a');

    assert.equal(created.organisationId, 'org-a');
    assert.equal((await store.findTicket('org-b', created.id)), null);
    assert.equal((await store.listTickets('org-a')).length, 1);
    assert.equal((await store.listTickets('org-b')).length, 0);

    const saved = JSON.parse(readFileSync(join(directory, 'tickets.json'), 'utf8'));
    assert.equal(saved.schemaVersion, 1);
    assert.equal(saved.records[0].id, created.id);
    assert.equal(saved.records[0].history[0].action, 'ticket.created');
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test('updates and comments preserve history in the same record file', async () => {
  const directory = createDirectory();
  try {
    const store = new TicketJsonStore(directory);
    const ticket = await store.createTicket({
      organisationId: 'org-a',
      requesterId: 'user-a',
      title: 'Initial title',
      description: 'Details',
      status: 'new',
    }, 'user-a');

    const updated = await store.updateTicket(
      'org-a',
      ticket.id,
      { title: 'Updated title' },
      'agent-a',
    );
    const comment = await store.addComment(
      'org-a',
      ticket.id,
      { authorId: 'agent-a', body: 'Investigating.', visibility: 'public' },
      'agent-a',
    );

    assert.equal(updated?.title, 'Updated title');
    assert.equal(comment?.comment.body, 'Investigating.');
    assert.deepEqual(
      comment?.ticket.history?.map((event) => event.action),
      ['ticket.created', 'ticket.updated', 'ticket.comment_added'],
    );
    assert.equal(await store.updateTicket('org-b', ticket.id, { title: 'Cross-tenant' }, 'agent-b'), null);
    assert.equal(await store.addComment(
      'org-b',
      ticket.id,
      { authorId: 'agent-b', body: 'Forbidden.', visibility: 'internal' },
      'agent-b',
    ), null);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test('Jira ingestion is idempotent and rejects issue-key collisions', async () => {
  const directory = createDirectory();
  try {
    const store = new TicketJsonStore(directory);
    const input = {
      organisationId: 'org-a',
      requesterId: 'user-a',
      title: 'Imported issue',
      description: { type: 'doc', content: [] },
      source: {
        system: 'jira' as const,
        issueId: '1001',
        issueKey: 'SUP-1',
        projectKey: 'SUP',
        status: 'Open',
      },
    };

    const created = await store.upsertJiraTicket(input);
    const duplicate = await store.upsertJiraTicket(input);
    assert.equal(created.outcome, 'created');
    assert.equal(duplicate.outcome, 'duplicate');
    assert.equal(created.ticket.id, duplicate.ticket.id);

    await assert.rejects(
      store.upsertJiraTicket({
        ...input,
        source: { ...input.source, issueId: '1002' },
      }),
      TicketConflictError,
    );
    assert.equal((await store.listTickets('org-a')).length, 1);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test('malformed storage is reported without replacing the original file', async () => {
  const directory = createDirectory();
  const malformed = '{"schemaVersion":1,"records":';
  const filePath = join(directory, 'tickets.json');
  writeFileSync(filePath, malformed, 'utf8');

  try {
    const store = new TicketJsonStore(directory);
    await assert.rejects(store.listTickets('org-a'), /valid JSON/);
    assert.equal(readFileSync(filePath, 'utf8'), malformed);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test('reads legacy records with null comments and history', async () => {
  const directory = createDirectory();
  const record = {
    id: 'ticket_legacy',
    organisationId: 'org-a',
    requesterId: 'user-a',
    title: 'Legacy ticket',
    description: null,
    comments: null,
    history: null,
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
  };
  writeFileSync(
    join(directory, 'tickets.json'),
    JSON.stringify({ schemaVersion: 1, records: [record] }),
    'utf8',
  );

  try {
    const store = new TicketJsonStore(directory);
    assert.deepEqual(await store.listTickets('org-a'), [record]);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test('serializes concurrent writes in the single process', async () => {
  const directory = createDirectory();
  try {
    const store = new TicketJsonStore(directory);
    const secondStore = new TicketJsonStore(directory);
    await Promise.all([
      ...Array.from({ length: 10 }, (_, index) => store.createTicket({
        organisationId: 'org-a',
        requesterId: `user-${index}`,
        title: `Ticket ${index}`,
        description: 'Concurrent write.',
        status: 'new',
      }, `user-${index}`)),
      ...Array.from({ length: 10 }, (_, index) => secondStore.createTicket({
        organisationId: 'org-b',
        requesterId: `other-${index}`,
        title: `Other ticket ${index}`,
        description: 'Concurrent write from another store instance.',
        status: 'new',
      }, `other-${index}`)),
    ]);

    assert.equal((await store.listTickets('org-a')).length, 10);
    assert.equal((await secondStore.listTickets('org-b')).length, 10);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});
