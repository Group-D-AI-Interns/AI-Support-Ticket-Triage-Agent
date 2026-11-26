export const SLA_EVIDENCE_ACTIONS = {
  acknowledgement: 'ticket.sla.acknowledgement_recorded',
  assessment: 'ticket.sla.assessment_recorded',
  assignment: 'ticket.sla.assignment_recorded',
  resolution: 'ticket.sla.resolution_recorded',
  pauseStarted: 'ticket.sla.pause_started',
  pauseEnded: 'ticket.sla.pause_ended',
  exclusionStarted: 'ticket.sla.exclusion_started',
  exclusionEnded: 'ticket.sla.exclusion_ended',
} as const;

export const SLA_PAUSE_REASON_CODES = [
  'waiting_for_requester_information',
  'waiting_for_customer_authorization',
  'waiting_for_scheduled_maintenance',
  'waiting_for_contractually_eligible_third_party',
] as const;

export type SlaPauseReasonCode = (typeof SLA_PAUSE_REASON_CODES)[number];

export const SLA_EXCLUSION_REASON_CODES = [
  'approved_maintenance_window',
  'outside_agreed_scope',
  'force_majeure',
  'requester_requested_postponement',
  'approved_waiting_period',
] as const;

export type SlaExclusionReasonCode =
  (typeof SLA_EXCLUSION_REASON_CODES)[number];

export type SlaPauseEvidence = {
  reasonCode: SlaPauseReasonCode;
  evidence: string;
  contractReference: string;
};

export type SlaResolutionEvidence = {
  outcome: 'service_restored' | 'agreed_solution';
  note: string;
  customerConfirmation: 'received' | 'not_applicable';
  customerConfirmationEvidence: string;
};

export type SlaEvidenceWrite =
  | {
      type: 'assessment_completed';
      evidence: string;
    }
  | {
      type: 'exclusion_started';
      intervalId: string;
      reasonCode: SlaExclusionReasonCode;
      evidence: string;
      contractReference: string;
    }
  | {
      type: 'exclusion_ended';
      intervalId: string;
    };
