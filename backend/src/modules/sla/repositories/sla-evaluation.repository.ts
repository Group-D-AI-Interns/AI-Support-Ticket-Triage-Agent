import type { JsonTenantStore } from '../../../infrastructure/persistence/json/json-store.js';
import type { TenantContext } from '../../../shared/tenant.js';
import type { SlaEvaluationRecord } from '../domain/sla-evaluation.js';

export interface SlaEvaluationRepository {
  append(
    tenant: TenantContext,
    evaluation: SlaEvaluationRecord,
  ): Promise<void>;
  list(
    tenant: TenantContext,
    ticketId?: string,
  ): Promise<SlaEvaluationRecord[]>;
}

export class JsonSlaEvaluationRepository implements SlaEvaluationRepository {
  constructor(private readonly store: JsonTenantStore) {}

  async append(
    tenant: TenantContext,
    evaluation: SlaEvaluationRecord,
  ): Promise<void> {
    if (evaluation.organisationId !== tenant.organisationId) {
      throw new Error('SLA evaluation organisation does not match tenant.');
    }
    await this.store.updateTenantCollection<SlaEvaluationRecord, void>('slaEvaluations', tenant.organisationId, (records) => {
      if (records.some((record) => record.id === evaluation.id)) {
        throw new Error(`SLA evaluation ${evaluation.id} already exists.`);
      }
      records.push(evaluation);
    });
  }

  async list(
    tenant: TenantContext,
    ticketId?: string,
  ): Promise<SlaEvaluationRecord[]> {
    return this.store.queryCollection<SlaEvaluationRecord>('slaEvaluations', {
      organisationId: tenant.organisationId,
      ...(ticketId === undefined ? {} : { ticketId }),
    });
  }
}
