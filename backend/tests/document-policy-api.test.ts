import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createServer, type Server } from 'node:http';

import { createJsonTenantStore } from '../src/infrastructure/persistence/json/json-store.js';
import { createLocalPrivateStorageAdapter } from '../src/modules/documents/storage/document-storage.js';
import { createDocumentPolicyApi } from '../src/modules/documents/document-policy-api.js';

const principal = {
  bearerToken: 'x'.repeat(32),
  organisationId: 'org-1',
  userId: 'admin-1',
  roles: new Set(['organisation_admin'] as const),
};

test('document/policy API supports upload, processing, and candidate review', async () => {
  const root = mkdtempSync(join(tmpdir(), 'doc-policy-api-'));
  let server: Server | undefined;

  try {
    const store = createJsonTenantStore(root);
    const base = await startApi(store, root);
    server = base.server;

    const unauthenticated = await fetch(`${base.url}/api/v1/documents`);
    assert.equal(unauthenticated.status, 401);

    const headers = {
      Authorization: `Bearer ${principal.bearerToken}`,
      'Content-Type': 'application/json',
    };

    const policyResponse = await fetch(`${base.url}/api/v1/policies`, {
      method: 'POST',
      headers,
      body: JSON.stringify({ policyType: 'sla', version: 1, description: 'Response policy' }),
    });
    assert.equal(policyResponse.status, 201);
    const policyEnvelope = await policyResponse.json() as any;

    const versionResponse = await fetch(`${base.url}/api/v1/policies/${policyEnvelope.data.id}/versions`, {
      method: 'POST',
      headers,
      body: JSON.stringify({
        version: 1,
        effectiveFrom: null,
        effectiveTo: null,
        payload: { responseHours: 2 },
      }),
    });
    assert.equal(versionResponse.status, 201);
    const versionEnvelope = await versionResponse.json() as any;

    const uploadResponse = await fetch(`${base.url}/api/v1/documents`, {
      method: 'POST',
      headers,
      body: JSON.stringify({
        title: 'Response policy',
        fileName: 'response.txt',
        mimeType: 'text/plain',
        content: Buffer.from('Respond within two hours.').toString('base64'),
      }),
    });
    assert.equal(uploadResponse.status, 201);
    const uploadEnvelope = await uploadResponse.json() as any;

    const processResponse = await fetch(
      `${base.url}/api/v1/documents/${uploadEnvelope.data.document.id}/process`,
      {
        method: 'POST',
        headers,
        body: JSON.stringify({
          policyId: policyEnvelope.data.id,
          policyVersionId: versionEnvelope.data.id,
          maxAttempts: 3,
        }),
      },
    );
    assert.equal(processResponse.status, 202);

    await store.writeCollection('extractedRules', [{
      id: 'candidate-api-1',
      organisationId: principal.organisationId,
      policyVersionId: versionEnvelope.data.id,
      documentId: uploadEnvelope.data.document.id,
      documentVersionId: uploadEnvelope.data.version.id,
      ruleType: 'response_time',
      payload: { targetHours: 2 },
      evidence: [{
        sourceType: 'document',
        sourceId: uploadEnvelope.data.document.id,
        versionId: uploadEnvelope.data.version.id,
      }],
      confidence: 0.91,
      ambiguous: false,
      createdAt: new Date().toISOString(),
      requiresHumanReview: false,
      warnings: [],
      reviewStatus: 'pending_review',
    }]);

    const reviewResponse = await fetch(
      `${base.url}/api/v1/extracted-rules/candidate-api-1/approve`,
      {
        method: 'POST',
        headers,
        body: JSON.stringify({ reason: 'Verified against the source policy.' }),
      },
    );
    assert.equal(reviewResponse.status, 200);
  } finally {
    if (server) {
      await new Promise<void>((resolve, reject) => server?.close((error) => error ? reject(error) : resolve()));
    }
    rmSync(root, { recursive: true, force: true });
  }
});

async function startApi(
  store: ReturnType<typeof createJsonTenantStore>,
  root: string,
): Promise<{ server: Server; url: string }> {
  const server = createServer(createDocumentPolicyApi({
    store,
    storage: createLocalPrivateStorageAdapter(root),
    developmentPrincipal: principal,
  }));

  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  if (!address || typeof address === 'string') {
    throw new Error('API test server did not start.');
  }

  return { server, url: `http://127.0.0.1:${address.port}` };
}
