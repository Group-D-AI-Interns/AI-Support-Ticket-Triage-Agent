export const INITIAL_DOCUMENT_POLICY_SCHEMA = {
  schemaVersion: 1,
  collections: [
    'documents',
    'documentVersions',
    'policies',
    'policyVersions',
    'extractedRules',
    'policyApprovals',
    'auditLogs',
  ],
  indexes: [
    'organisationId + status + createdAt for documents',
    'documentId + version for documentVersions',
    'organisationId + policyType + status for policies',
    'policyId + version for policyVersions',
    'organisationId + targetType + targetId + createdAt for auditLogs',
  ],
} as const;

export const DOCUMENT_POLICY_MIGRATIONS = [
  {
    version: 1,
    name: 'initial_document_policy_schema',
    description: 'Initial JSON persistence for documents, policy versions, extracted rules and audit records.',
  },
] as const;
