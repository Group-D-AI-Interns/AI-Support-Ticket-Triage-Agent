import type {
  TicketWorkflowConfig,
  TicketWorkflowPermissions,
} from '../domain/ticket-workflow.js';

const workflowRoles = new Set([
  'requester',
  'support_agent',
  'support_lead',
  'organisation_admin',
]);

export class TicketWorkflowValidationError extends Error {
  constructor(
    readonly field: string,
    message: string,
  ) {
    super(message);
  }
}

export function parseTicketWorkflowConfig(
  value: unknown,
): TicketWorkflowConfig {
  if (!isRecord(value)) {
    throw new TicketWorkflowValidationError(
      'body',
      'The workflow configuration must be an object.',
    );
  }

  const sourceReference = requiredText(value.sourceReference, 'sourceReference');
  const initialStatus = requiredStatus(value.initialStatus, 'initialStatus');
  const reopenStatus = requiredStatus(value.reopenStatus, 'reopenStatus');
  if (!Array.isArray(value.statuses) || value.statuses.length === 0) {
    throw new TicketWorkflowValidationError(
      'statuses',
      'At least one status is required.',
    );
  }
  const statuses = value.statuses.map((status, index) =>
    requiredStatus(status, `statuses[${index}]`),
  );
  if (new Set(statuses).size !== statuses.length) {
    throw new TicketWorkflowValidationError(
      'statuses',
      'Status values must be unique.',
    );
  }
  if (!statuses.includes(initialStatus)) {
    throw new TicketWorkflowValidationError(
      'initialStatus',
      'The initial status must be listed in statuses.',
    );
  }
  if (!statuses.includes(reopenStatus)) {
    throw new TicketWorkflowValidationError(
      'reopenStatus',
      'The reopen status must be listed in statuses.',
    );
  }
  if (!isRecord(value.transitions)) {
    throw new TicketWorkflowValidationError(
      'transitions',
      'Transitions must be an object keyed by current status.',
    );
  }

  const statusSet = new Set(statuses);
  if (
    Object.keys(value.transitions).length !== statuses.length ||
    statuses.some(
      (status) =>
        !Object.prototype.hasOwnProperty.call(value.transitions, status),
    )
  ) {
    throw new TicketWorkflowValidationError(
      'transitions',
      'Every status must have exactly one transition entry, even if it has no allowed next status.',
    );
  }
  const transitions: Record<string, string[]> = {};
  for (const [fromStatus, rawTargets] of Object.entries(value.transitions)) {
    if (!Array.isArray(rawTargets)) {
      throw new TicketWorkflowValidationError(
        `transitions.${fromStatus}`,
        'Allowed next statuses must be an array.',
      );
    }
    const targets = rawTargets.map((target, index) =>
      requiredStatus(target, `transitions.${fromStatus}[${index}]`),
    );
    if (
      targets.some(
        (target) => !statusSet.has(target) || target === fromStatus,
      ) ||
      new Set(targets).size !== targets.length
    ) {
      throw new TicketWorkflowValidationError(
        `transitions.${fromStatus}`,
        'Transitions must target unique, listed statuses other than the current status.',
      );
    }
    transitions[fromStatus] = targets;
  }

  if (!Array.isArray(value.requestableReopenFrom)) {
    throw new TicketWorkflowValidationError(
      'requestableReopenFrom',
      'Requestable reopen states must be an array.',
    );
  }
  const requestableReopenFrom = value.requestableReopenFrom.map(
    (status, index) =>
      requiredStatus(status, `requestableReopenFrom[${index}]`),
  );
  if (
    requestableReopenFrom.some((status) => !statusSet.has(status)) ||
    new Set(requestableReopenFrom).size !== requestableReopenFrom.length
  ) {
    throw new TicketWorkflowValidationError(
      'requestableReopenFrom',
      'Requestable reopen states must be unique statuses in the workflow.',
    );
  }
  if (!Array.isArray(value.restrictedReopenFrom)) {
    throw new TicketWorkflowValidationError(
      'restrictedReopenFrom',
      'Restricted reopen states must be an array.',
    );
  }
  const restrictedReopenFrom = value.restrictedReopenFrom.map(
    (status, index) =>
      requiredStatus(status, `restrictedReopenFrom[${index}]`),
  );
  if (
    restrictedReopenFrom.some((status) => !statusSet.has(status)) ||
    new Set(restrictedReopenFrom).size !== restrictedReopenFrom.length
  ) {
    throw new TicketWorkflowValidationError(
      'restrictedReopenFrom',
      'Restricted reopen states must be unique statuses in the workflow.',
    );
  }
  for (const status of [...requestableReopenFrom, ...restrictedReopenFrom]) {
    if (!transitions[status]?.includes(reopenStatus)) {
      throw new TicketWorkflowValidationError(
        'transitions',
        `The transition from ${status} to ${reopenStatus} is required by the reopen rules.`,
      );
    }
  }

  const permissions = parsePermissions(value.permissions);
  return {
    sourceReference,
    initialStatus,
    reopenStatus,
    statuses,
    transitions,
    requestableReopenFrom,
    restrictedReopenFrom,
    permissions,
  };
}

function parsePermissions(value: unknown): TicketWorkflowPermissions {
  if (!isRecord(value)) {
    throw new TicketWorkflowValidationError(
      'permissions',
      'Role permissions are required.',
    );
  }
  return {
    directStatusChangeRoles: roleList(
      value.directStatusChangeRoles,
      'permissions.directStatusChangeRoles',
    ),
    closedReopenRoles: roleList(
      value.closedReopenRoles,
      'permissions.closedReopenRoles',
    ),
    reopenRequestRoles: roleList(
      value.reopenRequestRoles,
      'permissions.reopenRequestRoles',
    ),
    reopenApprovalRoles: roleList(
      value.reopenApprovalRoles,
      'permissions.reopenApprovalRoles',
    ),
    administratorOverrideRoles: roleList(
      value.administratorOverrideRoles,
      'permissions.administratorOverrideRoles',
    ),
  };
}

function roleList(value: unknown, field: string): string[] {
  if (
    !Array.isArray(value) ||
    value.length === 0 ||
    value.some(
      (role) => typeof role !== 'string' || !workflowRoles.has(role),
    )
  ) {
    throw new TicketWorkflowValidationError(
      field,
      'Select one or more supported roles.',
    );
  }
  if (new Set(value).size !== value.length) {
    throw new TicketWorkflowValidationError(
      field,
      'Roles must not contain duplicates.',
    );
  }
  return value;
}

function requiredStatus(value: unknown, field: string): string {
  if (typeof value !== 'string' || !/^[A-Z][A-Z0-9_]*$/.test(value)) {
    throw new TicketWorkflowValidationError(
      field,
      'Status values must use uppercase letters, digits, or underscores and start with a letter.',
    );
  }
  return value;
}

function requiredText(value: unknown, field: string): string {
  if (typeof value !== 'string' || !value.trim() || value.length > 200) {
    throw new TicketWorkflowValidationError(
      field,
      'This field must be a non-empty string of at most 200 characters.',
    );
  }
  return value.trim();
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}
