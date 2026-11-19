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
    const records =
      await this.store.readCollection<SlaEvaluationRecord>('slaEvaluations');
    if (records.some((record) => record.id === evaluation.id)) {
      throw new Error(`SLA evaluation ${evaluation.id} already exists.`);
    }
    records.push(evaluation);
    await this.store.writeCollection('slaEvaluations', records);
  }

  async list(
    tenant: TenantContext,
    ticketId?: string,
  ): Promise<SlaEvaluationRecord[]> {
    const records =
      await this.store.readCollection<SlaEvaluationRecord>('slaEvaluations');
    return records.filter(
      (record) =>
        record.organisationId === tenant.organisationId &&
        (ticketId === undefined || record.ticketId === ticketId),
    );
  }
}
