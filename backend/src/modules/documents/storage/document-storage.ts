import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';

import type { TenantContext } from '../../../shared/tenant.js';

export interface DocumentStorageAdapter {
  storeDocument(
    tenant: TenantContext,
    documentId: string,
    fileName: string,
    buffer: Buffer,
    mimeType: string,
  ): Promise<{ storageKey: string; fileSizeBytes: number; checksumSha256: string }>;
  getDocument(tenant: TenantContext, storageKey: string): Promise<Buffer | null>;
  createDownloadToken(tenant: TenantContext, documentId: string, storageKey: string): Promise<string>;
  validateDownloadToken(tenant: TenantContext, token: string): Promise<{ documentId: string; storageKey: string } | null>;
}

const tokenStore = new Map<string, { tenantId: string; documentId: string; storageKey: string; expiresAt: number }>();

export function createLocalPrivateStorageAdapter(rootDir: string): DocumentStorageAdapter {
  return {
    async storeDocument(tenant, documentId, fileName, buffer, mimeType) {
      const storageDirectory = join(rootDir, 'private', tenant.organisationId, documentId);
      await mkdir(storageDirectory, { recursive: true });

      const safeFileName = fileName.replace(/[^a-zA-Z0-9._-]/g, '_');
      const storageKey = join('private', tenant.organisationId, documentId, safeFileName).replace(/\\/g, '/');
      const filePath = join(storageDirectory, safeFileName);

      await writeFile(filePath, buffer);

      return {
        storageKey,
        fileSizeBytes: buffer.length,
        checksumSha256: await hashBuffer(buffer),
      };
    },
    async getDocument(tenant, storageKey) {
      const expectedPrefix = `private/${tenant.organisationId}/`;
      if (!storageKey.startsWith(expectedPrefix)) {
        return null;
      }

      try {
        return await readFile(join(rootDir, storageKey));
      } catch {
        return null;
      }
    },
    async createDownloadToken(tenant, documentId, storageKey) {
      const token = randomUUID();
      const expiresAt = Date.now() + 5 * 60 * 1000;
      tokenStore.set(token, {
        tenantId: tenant.organisationId,
        documentId,
        storageKey,
        expiresAt,
      });
      return token;
    },
    async validateDownloadToken(tenant, token) {
      const entry = tokenStore.get(token);
      if (!entry) {
        return null;
      }

      if (Date.now() > entry.expiresAt) {
        tokenStore.delete(token);
        return null;
      }

      if (entry.tenantId !== tenant.organisationId) {
        return null;
      }

      return {
        documentId: entry.documentId,
        storageKey: entry.storageKey,
      };
    },
  };
}

async function hashBuffer(buffer: Buffer): Promise<string> {
  const { createHash } = await import('node:crypto');
  return createHash('sha256').update(buffer).digest('hex');
}
