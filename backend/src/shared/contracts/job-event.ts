/** Versioned envelope required for messages crossing API, worker, or module boundaries. */
export type JobEnvelope<TPayload> = {
  contractVersion: 1;
  jobId: string;
  jobType: string;
  organisationId: string;
  requestedBy: string;
  requestId: string;
  createdAt: string;
  payload: TPayload;
};

export type DomainEvent<TPayload> = {
  contractVersion: 1;
  eventId: string;
  eventType: string;
  organisationId: string;
  actorId: string;
  requestId: string;
  occurredAt: string;
  payload: TPayload;
};
