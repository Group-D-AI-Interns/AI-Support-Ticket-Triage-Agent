import type { PolicyRepository } from '../../policies/repositories/policy.repository.js';
import type { TenantContext } from '../../../shared/tenant.js';
import { parseSlaPolicy, type SlaPolicy } from '../domain/sla-policy.js';

export class SlaPolicyResolutionError extends Error {}

export class RepositorySlaPolicyResolver {
  constructor(private readonly policies: PolicyRepository) {}

  async resolve(
    tenant: TenantContext,
    ticket: {
      priority: string;
      createdAt: string;
      teamId?: string | null;
    },
  ): Promise<SlaPolicy | null> {
    const createdAt = Date.parse(ticket.createdAt);
    if (!Number.isFinite(createdAt)) {
      throw new SlaPolicyResolutionError(
        'Ticket creation time must be a valid date-time.',
      );
    }

    const candidates: Array<{ policy: SlaPolicy; scoped: boolean }> = [];
    for (const record of await this.policies.listPolicies(tenant)) {
      if (record.policyType !== 'sla') {
        continue;
      }
      const versions = await this.policies.listVersionsForPolicy(
        tenant,
        record.id,
      );
      for (const version of versions) {
        if (
          !(
            version.status === 'active' ||
            (version.status === 'archived' &&
              version.effectiveTo !== null)
          ) ||
          version.effectiveFrom === null ||
          Date.parse(version.effectiveFrom) > createdAt ||
          (version.effectiveTo !== null &&
            Date.parse(version.effectiveTo) <= createdAt)
        ) {
          continue;
        }
        const policy = parseSlaPolicy(version.payload, {
          id: record.id,
          versionId: version.id,
          version: version.version,
          organisationId: version.organisationId,
          effectiveFrom: version.effectiveFrom,
          effectiveTo: version.effectiveTo,
        });
        if (!policy.targetsByPriority[ticket.priority]) {
          continue;
        }
        const scoped = policy.teamIds !== undefined;
        if (
          scoped &&
          (ticket.teamId == null || !policy.teamIds?.includes(ticket.teamId))
        ) {
          continue;
        }
        candidates.push({ policy, scoped });
      }
    }

    if (candidates.length === 0) {
      return null;
    }
    const highestSpecificity = candidates.some((candidate) => candidate.scoped);
    const selected = candidates.filter(
      (candidate) => candidate.scoped === highestSpecificity,
    );
    if (selected.length !== 1) {
      throw new SlaPolicyResolutionError(
        'Multiple active SLA policies match this ticket and effective date.',
      );
    }
    return selected[0]!.policy;
  }
}
