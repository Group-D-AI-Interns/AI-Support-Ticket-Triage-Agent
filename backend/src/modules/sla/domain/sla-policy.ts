export type SlaInterval = {
  startMinute: number;
  endMinute: number;
};

export type SlaCalendar = {
  timeZone: string;
  weeklySchedule: Partial<Record<Weekday, SlaInterval[]>>;
  holidays: string[];
};

export type Weekday =
  | 'sunday'
  | 'monday'
  | 'tuesday'
  | 'wednesday'
  | 'thursday'
  | 'friday'
  | 'saturday';

export type SlaTargets = {
  firstResponseMinutes: number;
  resolutionMinutes: number;
};

export type SlaPolicy = {
  id: string;
  versionId: string;
  version: number;
  organisationId: string;
  teamIds?: string[];
  effectiveFrom: string;
  effectiveTo: string | null;
  calendar: SlaCalendar;
  /** Optional priority-specific calendars; legacy policies continue to use `calendar`. */
  calendarByPriority?: Record<string, SlaCalendar>;
  targetsByPriority: Record<string, SlaTargets>;
  pausedStatuses: string[];
  resolvedStatuses: string[];
  riskAtPercent: number;
};

export class SlaPolicyValidationError extends Error {
  constructor(
    readonly field: string,
    message: string,
  ) {
    super(message);
  }
}

const weekdays: Weekday[] = [
  'sunday',
  'monday',
  'tuesday',
  'wednesday',
  'thursday',
  'friday',
  'saturday',
];

export function parseSlaPolicy(
  value: unknown,
  source: Pick<
    SlaPolicy,
    'id' | 'versionId' | 'version' | 'organisationId' | 'effectiveFrom' | 'effectiveTo'
  >,
): SlaPolicy {
  if (!isRecord(value)) {
    throw new SlaPolicyValidationError('payload', 'SLA policy must be an object.');
  }

  const targetsByPriority = parseTargets(value.targetsByPriority);
  const calendarByPriority = parseCalendarsByPriority(value.calendarByPriority, targetsByPriority);
  const calendar = value.calendar === undefined
    ? calendarByPriority?.[Object.keys(targetsByPriority)[0]!]
    : parseCalendar(value.calendar);
  if (!calendar) {
    throw new SlaPolicyValidationError('calendar', 'A shared calendar or a calendar for each configured priority is required.');
  }
  const pausedStatuses = parseStatuses(value.pausedStatuses, 'pausedStatuses');
  const resolvedStatuses = parseStatuses(
    value.resolvedStatuses,
    'resolvedStatuses',
  );
  const teamIds = parseOptionalIds(value.teamIds, 'teamIds');
  const riskAtPercent = value.riskAtPercent;
  if (
    typeof riskAtPercent !== 'number' ||
    !Number.isFinite(riskAtPercent) ||
    riskAtPercent <= 0 ||
    riskAtPercent >= 100
  ) {
    throw new SlaPolicyValidationError(
      'riskAtPercent',
      'Risk threshold must be greater than 0 and less than 100.',
    );
  }
  if (!isValidTimestamp(source.effectiveFrom)) {
    throw new SlaPolicyValidationError(
      'effectiveFrom',
      'Effective-from must be an ISO timestamp.',
    );
  }
  if (source.effectiveTo !== null && !isValidTimestamp(source.effectiveTo)) {
    throw new SlaPolicyValidationError(
      'effectiveTo',
      'Effective-to must be an ISO timestamp or null.',
    );
  }
  if (
    source.effectiveTo !== null &&
    Date.parse(source.effectiveTo) <= Date.parse(source.effectiveFrom)
  ) {
    throw new SlaPolicyValidationError(
      'effectiveTo',
      'Effective-to must be later than effective-from.',
    );
  }
  if (!Number.isInteger(source.version) || source.version < 1) {
    throw new SlaPolicyValidationError(
      'version',
      'Policy version must be a positive integer.',
    );
  }

  return {
    ...source,
    ...(teamIds === undefined ? {} : { teamIds }),
    calendar,
    ...(calendarByPriority === undefined ? {} : { calendarByPriority }),
    targetsByPriority,
    pausedStatuses,
    resolvedStatuses,
    riskAtPercent,
  };
}

function parseCalendarsByPriority(
  value: unknown,
  targetsByPriority: Record<string, SlaTargets>,
): Record<string, SlaCalendar> | undefined {
  if (value === undefined) return undefined;
  if (!isRecord(value)) {
    throw new SlaPolicyValidationError('calendarByPriority', 'Priority calendars must be an object.');
  }
  const priorities = Object.keys(targetsByPriority);
  if (Object.keys(value).length !== priorities.length || priorities.some(priority => !Object.hasOwn(value, priority))) {
    throw new SlaPolicyValidationError('calendarByPriority', 'A calendar is required for every configured priority and no others.');
  }
  return Object.fromEntries(priorities.map(priority => [priority, parseCalendar(value[priority])]));
}

function parseOptionalIds(value: unknown, field: string): string[] | undefined {
  if (value === undefined) {
    return undefined;
  }
  if (
    !Array.isArray(value) ||
    value.length === 0 ||
    value.some((id) => typeof id !== 'string' || !id.trim()) ||
    new Set(value).size !== value.length
  ) {
    throw new SlaPolicyValidationError(
      field,
      'When supplied, scope IDs must be a non-empty list of unique strings.',
    );
  }
  return value as string[];
}

function parseCalendar(value: unknown): SlaCalendar {
  if (!isRecord(value)) {
    throw new SlaPolicyValidationError('calendar', 'Calendar must be an object.');
  }
  const { timeZone, weeklySchedule, holidays } = value;
  if (typeof timeZone !== 'string' || !timeZone.trim()) {
    throw new SlaPolicyValidationError(
      'calendar.timeZone',
      'A timezone is required.',
    );
  }
  try {
    new Intl.DateTimeFormat('en', { timeZone }).format(0);
  } catch {
    throw new SlaPolicyValidationError(
      'calendar.timeZone',
      'Timezone must be a valid IANA timezone.',
    );
  }
  if (!isRecord(weeklySchedule)) {
    throw new SlaPolicyValidationError(
      'calendar.weeklySchedule',
      'Weekly schedule must be an object.',
    );
  }

  const parsedSchedule: SlaCalendar['weeklySchedule'] = {};
  for (const [day, rawIntervals] of Object.entries(weeklySchedule)) {
    if (!weekdays.includes(day as Weekday) || !Array.isArray(rawIntervals)) {
      throw new SlaPolicyValidationError(
        `calendar.weeklySchedule.${day}`,
        'Each schedule entry must use a weekday and contain an interval array.',
      );
    }
    const intervals = rawIntervals.map((raw, index) => {
      if (!isRecord(raw)) {
        throw new SlaPolicyValidationError(
          `calendar.weeklySchedule.${day}[${index}]`,
          'Working interval must be an object.',
        );
      }
      const { startMinute, endMinute } = raw;
      if (
        !Number.isInteger(startMinute) ||
        !Number.isInteger(endMinute) ||
        (startMinute as number) < 0 ||
        (endMinute as number) > 1440 ||
        (startMinute as number) >= (endMinute as number)
      ) {
        throw new SlaPolicyValidationError(
          `calendar.weeklySchedule.${day}[${index}]`,
          'Working interval must be a non-empty range of minutes within one day.',
        );
      }
      return {
        startMinute: startMinute as number,
        endMinute: endMinute as number,
      };
    });
    intervals.sort((left, right) => left.startMinute - right.startMinute);
    for (let index = 1; index < intervals.length; index += 1) {
      const previous = intervals[index - 1];
      const current = intervals[index];
      if (previous && current && current.startMinute < previous.endMinute) {
        throw new SlaPolicyValidationError(
          `calendar.weeklySchedule.${day}`,
          'Working intervals must not overlap.',
        );
      }
    }
    parsedSchedule[day as Weekday] = intervals;
  }
  if (!Object.values(parsedSchedule).some((intervals) => intervals?.length)) {
    throw new SlaPolicyValidationError(
      'calendar.weeklySchedule',
      'At least one working interval is required.',
    );
  }

  if (
    !Array.isArray(holidays) ||
    holidays.some((holiday) => !isDateOnly(holiday))
  ) {
    throw new SlaPolicyValidationError(
      'calendar.holidays',
      'Holidays must be an array of valid YYYY-MM-DD dates.',
    );
  }
  return {
    timeZone,
    weeklySchedule: parsedSchedule,
    holidays: [...new Set(holidays as string[])],
  };
}

function parseTargets(value: unknown): Record<string, SlaTargets> {
  if (!isRecord(value) || Object.keys(value).length === 0) {
    throw new SlaPolicyValidationError(
      'targetsByPriority',
      'At least one priority target is required.',
    );
  }
  const result: Record<string, SlaTargets> = {};
  for (const [priority, rawTargets] of Object.entries(value)) {
    if (!priority.trim() || !isRecord(rawTargets)) {
      throw new SlaPolicyValidationError(
        `targetsByPriority.${priority}`,
        'Each priority must have a target object.',
      );
    }
    const { firstResponseMinutes, resolutionMinutes } = rawTargets;
    if (
      !isPositiveInteger(firstResponseMinutes) ||
      !isPositiveInteger(resolutionMinutes)
    ) {
      throw new SlaPolicyValidationError(
        `targetsByPriority.${priority}`,
        'First-response and resolution targets must be positive whole minutes.',
      );
    }
    result[priority] = { firstResponseMinutes, resolutionMinutes };
  }
  return result;
}

function parseStatuses(value: unknown, field: string): string[] {
  if (
    !Array.isArray(value) ||
    value.length === 0 ||
    value.some((status) => typeof status !== 'string' || !status.trim())
  ) {
    throw new SlaPolicyValidationError(
      field,
      'At least one non-empty status is required.',
    );
  }
  const statuses = value as string[];
  if (new Set(statuses).size !== statuses.length) {
    throw new SlaPolicyValidationError(field, 'Statuses must be unique.');
  }
  return statuses;
}

function isPositiveInteger(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value > 0;
}

function isValidTimestamp(value: string): boolean {
  return Number.isFinite(Date.parse(value)) && /^\d{4}-\d\d-\d\dT/.test(value);
}

function isDateOnly(value: unknown): value is string {
  if (typeof value !== 'string' || !/^\d{4}-\d\d-\d\d$/.test(value)) {
    return false;
  }
  const date = new Date(`${value}T00:00:00.000Z`);
  return date.toISOString().slice(0, 10) === value;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}
