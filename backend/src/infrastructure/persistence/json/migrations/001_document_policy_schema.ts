import type { JsonTenantStore } from '../json-store.js';
import { INITIAL_DOCUMENT_POLICY_SCHEMA } from '../schema.js';

export async function applyDocumentPolicySchema(store: JsonTenantStore): Promise<void> {
  const collectionNames = INITIAL_DOCUMENT_POLICY_SCHEMA.collections;

  for (const collection of collectionNames) {
    await store.writeCollection(collection as never, []);
  }
}
