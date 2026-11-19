import { mkdir, readFile, unlink, writeFile } from 'node:fs/promises';
import { join, relative, resolve, sep } from 'node:path';
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
  deleteDocument(tenant: TenantContext, storageKey: string): Promise<void>;
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
      const filePath = resolveStoragePath(rootDir, tenant, storageKey);
      if (!filePath) {
        return null;
      }

      try {
        return await readFile(filePath);
      } catch (error) {
        if (isNodeError(error) && error.code === 'ENOENT') {
          return null;
        }
        throw error;
      }
    },
    async deleteDocument(tenant, storageKey) {
      const filePath = resolveStoragePath(rootDir, tenant, storageKey);
      if (!filePath) {
        throw new Error('Storage key is outside the tenant private storage directory.');
      }
      try {
        await unlink(filePath);
      } catch (error) {
        if (!isNodeError(error) || error.code !== 'ENOENT') {
          throw error;
        }
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

function resolveStoragePath(
  rootDir: string,
  tenant: TenantContext,
  storageKey: string,
): string | null {
  const tenantDirectory = resolve(rootDir, 'private', tenant.organisationId);
  const filePath = resolve(rootDir, storageKey);
  const fromTenantDirectory = relative(tenantDirectory, filePath);
  if (
    !storageKey.startsWith(`private/${tenant.organisationId}/`) ||
    !fromTenantDirectory ||
    fromTenantDirectory === '..' ||
    fromTenantDirectory.startsWith(`..${sep}`) ||
    resolve(tenantDirectory, fromTenantDirectory) !== filePath
  ) {
    return null;
  }
  return filePath;
}

async function hashBuffer(buffer: Buffer): Promise<string> {
  const { createHash } = await import('node:crypto');
  return createHash('sha256').update(buffer).digest('hex');
}

function isNodeError(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error && 'code' in error;
}
