import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import { JsonStorageError } from '../src/infrastructure/persistence/json/json-file-store.js';
import { createJsonTenantStore } from '../src/infrastructure/persistence/json/json-store.js';

test('JSON tenant store preserves malformed storage errors and migrates legacy arrays on update', async () => {
  const root = await mkdtemp(join(tmpdir(), 'json-tenant-store-'));
  try {
    const store = createJsonTenantStore(root);
    await writeFile(join(root, 'documents.json'), '{malformed', 'utf8');
    await assert.rejects(
      store.readCollection('documents'),
      (error: unknown) => error instanceof JsonStorageError && error.code === 'STORAGE_INVALID_JSON',
    );

    await writeFile(join(root, 'documents.json'), JSON.stringify([
      { id: 'document-a', organisationId: 'org-a', title: 'Legacy' },
    ]), 'utf8');
    const legacy = await store.readCollection<{ id: string; title: string }>('documents');
    assert.equal(legacy[0]?.title, 'Legacy');

    await store.updateCollection<{ id: string; organisationId: string; title: string }, void>(
      'documents',
      (records) => { records.push({ id: 'document-b', organisationId: 'org-a', title: 'New' }); },
    );
    const saved = JSON.parse(await readFile(join(root, 'documents.json'), 'utf8')) as {
      schemaVersion: number;
      records: Array<{ id: string }>;
    };
    assert.equal(saved.schemaVersion, 1);
    assert.deepEqual(saved.records.map((record) => record.id), ['document-a', 'document-b']);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('JSON tenant store serializes concurrent collection updates', async () => {
  const root = await mkdtemp(join(tmpdir(), 'json-tenant-store-'));
  try {
    const first = createJsonTenantStore(root);
    const second = createJsonTenantStore(root);
    await Promise.all(Array.from({ length: 20 }, (_, index) => {
      const store = index % 2 === 0 ? first : second;
      return store.updateCollection('extractedRules', (records: Array<{ id: string; organisationId: string }>) => {
        records.push({ id: `rule-${index}`, organisationId: 'org-a' });
      });
    }));

    const records = await first.readCollection<{ id: string }>('extractedRules');
    assert.equal(records.length, 20);
    assert.equal(new Set(records.map((record) => record.id)).size, 20);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
