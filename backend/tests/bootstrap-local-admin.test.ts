import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, readdir, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { bootstrapLocalAdmin } from '../scripts/bootstrap-local-admin.js';
import { IdentityService } from '../src/modules/identity/service.js';
import { JsonIdentityRepository } from '../src/modules/identity/repositories.js';
import { JsonFileStore } from '../src/infrastructure/persistence/json/json-file-store.js';

const input = { userId: 'synthetic-keycloak-subject', email: 'admin@example.test', displayName: 'Test Administrator', organisationName: 'Test Support' };

test('local bootstrap creates resolvable identity and safely repeats without duplicates', async () => {
  const root = await mkdtemp(join(tmpdir(), 'local-admin-'));
  try {
    const environment = { NODE_ENV: 'development', DATA_DIRECTORY: root };
    const result = await bootstrapLocalAdmin(input, environment);
    const identity = new IdentityService(new JsonIdentityRepository(new JsonFileStore(root)));
    const context = await identity.resolve(input.userId, result.organisationId);
    assert.deepEqual(context?.roles, ['organisation_admin']);
    assert.equal((await identity.currentUser(input.userId)).organisations[0]?.organisationId, result.organisationId);
    const before = await readFile(join(root, 'memberships.json'), 'utf8');
    const repeat = await bootstrapLocalAdmin(input, environment);
    assert.equal(repeat.alreadyConfigured, true);
    assert.equal(repeat.organisationId, result.organisationId);
    assert.equal(await readFile(join(root, 'memberships.json'), 'utf8'), before);
    await assert.rejects(bootstrapLocalAdmin({ ...input, userId: 'another-subject' }, environment), /Existing identity setup/);
    assert.equal(await readFile(join(root, 'memberships.json'), 'utf8'), before);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('local bootstrap rejects production and invalid input without creating records', async () => {
  const root = await mkdtemp(join(tmpdir(), 'local-admin-'));
  try {
    await assert.rejects(bootstrapLocalAdmin(input, { NODE_ENV: 'production', DATA_DIRECTORY: root }), /development/);
    await assert.rejects(bootstrapLocalAdmin({ ...input, email: '' }, { NODE_ENV: 'development', DATA_DIRECTORY: root }), /Provide/);
    assert.deepEqual(await readdir(root), []);
  } finally { await rm(root, { recursive: true, force: true }); }
});
