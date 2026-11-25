import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { JsonIdentityRepository } from './repositories.ts';
import { AppError } from '../../shared/errors/app-error.ts';
import type { JsonFileStorePort } from '../../infrastructure/persistence/json/json-file-store.ts';

describe('identity repository persistence conflicts', () => {
  it('maps a MongoDB unique email conflict to the existing user conflict response', async () => {
    const store = {
      rootDir: '.',
      update: async () => { throw Object.assign(new Error('MongoDB operation failed.'), { cause: Object.assign(new Error('duplicate key'), { code: 11000 }) }); },
    } as unknown as JsonFileStorePort;
    const repository = new JsonIdentityRepository(store);

    await assert.rejects(repository.createProvisionedUser('user-1', 'agent@example.test', 'Agent'),
      (error: unknown) => error instanceof AppError && error.statusCode === 409 && error.code === 'USER_ALREADY_EXISTS');
  });
});
