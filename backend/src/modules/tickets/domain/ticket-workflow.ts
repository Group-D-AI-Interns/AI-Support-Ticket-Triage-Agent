export type TicketWorkflowPermissions = {
  directStatusChangeRoles: string[];
  closedReopenRoles: string[];
  reopenRequestRoles: string[];
  reopenApprovalRoles: string[];
  administratorOverrideRoles: string[];
};

export type TicketWorkflowConfig = {
  sourceReference: string;
  initialStatus: string;
  reopenStatus: string;
  statuses: string[];
  transitions: Record<string, string[]>;
  requestableReopenFrom: string[];
  restrictedReopenFrom: string[];
  permissions: TicketWorkflowPermissions;
};

export type TicketWorkflowRecord = {
  id: string;
  organisationId: string;
  config: TicketWorkflowConfig;
  status: 'draft' | 'active' | 'archived';
  createdBy: string;
  createdAt: string;
  updatedAt: string;
  approvedBy?: string;
  approvedAt?: string;
};

export type TicketReopenRequest = {
  id: string;
  requestedBy: string;
  fromStatus: string;
  toStatus: string;
  reason: string;
  status: 'pending' | 'approved';
  createdAt: string;
  reviewedBy?: string;
  reviewedAt?: string;
};
