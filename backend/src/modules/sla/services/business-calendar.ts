import type { SlaCalendar, Weekday } from '../domain/sla-policy.js';

const millisecondsPerMinute = 60_000;
const millisecondsPerDay = 86_400_000;
const weekdays: Weekday[] = [
  'sunday',
  'monday',
  'tuesday',
  'wednesday',
  'thursday',
  'friday',
  'saturday',
];
const formatters = new Map<string, Intl.DateTimeFormat>();

type PauseInterval = {
  start: number;
  end: number;
};

export function addBusinessMinutes(
  startAt: string,
  minutes: number,
  calendar: SlaCalendar,
  pauses: PauseInterval[] = [],
): string {
  const start = parseTimestamp(startAt);
  if (!Number.isSafeInteger(minutes) || minutes < 0) {
    throw new RangeError('Business minutes must be a non-negative integer.');
  }
  if (minutes === 0) {
    return new Date(start).toISOString();
  }

  let remaining = minutes;
  for (const day of localDates(start, start + millisecondsPerDay * 3660, calendar.timeZone)) {
    if (calendar.holidays.includes(day.key)) {
      continue;
    }
    const dayOfWeek = weekdays[new Date(day.utc).getUTCDay()];
    if (!dayOfWeek) {
      continue;
    }
    for (const interval of calendar.weeklySchedule[dayOfWeek] ?? []) {
      const intervalStart = localMinuteToTimestamp(
        day.key,
        interval.startMinute,
        calendar.timeZone,
        'start',
      );
      const intervalEnd = localMinuteToTimestamp(
        day.key,
        interval.endMinute,
        calendar.timeZone,
        'end',
      );
      const workSegments = subtractPauses(
        Math.max(intervalStart, start),
        intervalEnd,
        pauses,
      );
      for (const [segmentStart, segmentEnd] of workSegments) {
        const available = Math.floor(
          (segmentEnd - segmentStart) / millisecondsPerMinute,
        );
        if (available <= 0) {
          continue;
        }
        if (remaining <= available) {
          return new Date(
            segmentStart + remaining * millisecondsPerMinute,
          ).toISOString();
        }
        remaining -= available;
      }
    }
  }
  throw new RangeError('Could not find enough working time within ten years.');
}

export function businessMinutesBetween(
  startAt: string,
  endAt: string,
  calendar: SlaCalendar,
  pauses: PauseInterval[] = [],
): number {
  const start = parseTimestamp(startAt);
  const end = parseTimestamp(endAt);
  if (end <= start) {
    return 0;
  }
  let total = 0;
  for (const day of localDates(start, end, calendar.timeZone)) {
    if (calendar.holidays.includes(day.key)) {
      continue;
    }
    const dayOfWeek = weekdays[new Date(day.utc).getUTCDay()];
    if (!dayOfWeek) {
      continue;
    }
    for (const interval of calendar.weeklySchedule[dayOfWeek] ?? []) {
      const intervalStart = localMinuteToTimestamp(
        day.key,
        interval.startMinute,
        calendar.timeZone,
        'start',
      );
      const intervalEnd = localMinuteToTimestamp(
        day.key,
        interval.endMinute,
        calendar.timeZone,
        'end',
      );
      for (const [segmentStart, segmentEnd] of subtractPauses(
        Math.max(intervalStart, start),
        Math.min(intervalEnd, end),
        pauses,
      )) {
        total += (segmentEnd - segmentStart) / millisecondsPerMinute;
      }
    }
  }
  return Math.floor(total);
}

function subtractPauses(
  start: number,
  end: number,
  pauses: PauseInterval[],
): Array<[number, number]> {
  if (end <= start) {
    return [];
  }
  let segments: Array<[number, number]> = [[start, end]];
  const orderedPauses = [...pauses]
    .map((pause) => ({
      start: Number.isFinite(pause.start) ? pause.start : start,
      end: Number.isFinite(pause.end) ? pause.end : end,
    }))
    .sort((left, right) => left.start - right.start);
  const mergedPauses: PauseInterval[] = [];
  for (const pause of orderedPauses) {
    const previous = mergedPauses[mergedPauses.length - 1];
    if (previous && pause.start <= previous.end) {
      previous.end = Math.max(previous.end, pause.end);
    } else {
      mergedPauses.push({ ...pause });
    }
  }
  for (const pause of mergedPauses) {
    const next: Array<[number, number]> = [];
    for (const [segmentStart, segmentEnd] of segments) {
      const overlapStart = Math.max(segmentStart, pause.start);
      const overlapEnd = Math.min(segmentEnd, pause.end);
      if (overlapEnd <= overlapStart) {
        next.push([segmentStart, segmentEnd]);
      } else {
        if (segmentStart < overlapStart) {
          next.push([segmentStart, overlapStart]);
        }
        if (overlapEnd < segmentEnd) {
          next.push([overlapEnd, segmentEnd]);
        }
      }
    }
    segments = next;
  }
  return segments;
}

function localDates(
  start: number,
  end: number,
  timeZone: string,
): Array<{ key: string; utc: number }> {
  const firstKey = localDateKey(start, timeZone);
  const lastKey = localDateKey(end, timeZone);
  const first = Date.parse(`${firstKey}T00:00:00.000Z`) - millisecondsPerDay;
  const last = Date.parse(`${lastKey}T00:00:00.000Z`) + millisecondsPerDay;
  const result: Array<{ key: string; utc: number }> = [];
  for (let utc = first; utc <= last; utc += millisecondsPerDay) {
    result.push({ key: new Date(utc).toISOString().slice(0, 10), utc });
  }
  return result;
}

function localMinuteToTimestamp(
  dateKey: string,
  minute: number,
  timeZone: string,
  edge: 'start' | 'end',
): number {
  const dayOffset = Math.floor(minute / 1440);
  const minuteOfDay = minute % 1440;
  const date = new Date(
    Date.parse(`${dateKey}T00:00:00.000Z`) + dayOffset * millisecondsPerDay,
  );
  const targetKey = date.toISOString().slice(0, 10);
  const hour = Math.floor(minuteOfDay / 60);
  const targetMinute = minuteOfDay % 60;
  const targetWallTime =
    Date.parse(`${targetKey}T00:00:00.000Z`) +
    minuteOfDay * millisecondsPerMinute;
  const offsets = new Set<number>();
  for (let offset = -36; offset <= 36; offset += 6) {
    offsets.add(timeZoneOffset(targetWallTime + offset * 3_600_000, timeZone));
  }

  const candidates = [...offsets]
    .map((offset) => targetWallTime - offset)
    .filter((timestamp) => {
      const parts = localParts(timestamp, timeZone);
      return (
        parts.year === date.getUTCFullYear() &&
        parts.month === date.getUTCMonth() + 1 &&
        parts.day === date.getUTCDate() &&
        parts.hour === hour &&
        parts.minute === targetMinute
      );
    })
    .sort((left, right) => left - right);

  if (candidates.length > 0) {
    return edge === 'start'
      ? candidates[0]!
      : candidates[candidates.length - 1]!;
  }

  const approximate = targetWallTime - timeZoneOffset(targetWallTime, timeZone);
  for (let timestamp = approximate - 3_600_000; timestamp <= approximate + 3_600_000; timestamp += millisecondsPerMinute) {
    const parts = localParts(timestamp, timeZone);
    const localDate = `${parts.year.toString().padStart(4, '0')}-${parts.month
      .toString()
      .padStart(2, '0')}-${parts.day.toString().padStart(2, '0')}`;
    const localMinute = parts.hour * 60 + parts.minute;
    if (localDate === targetKey && localMinute >= minuteOfDay) {
      return timestamp;
    }
  }
  throw new RangeError(
    `Could not resolve local calendar time ${targetKey} ${hour}:${targetMinute}.`,
  );
}

function timeZoneOffset(timestamp: number, timeZone: string): number {
  const parts = localParts(timestamp, timeZone);
  const localAsUtc = Date.UTC(
    parts.year,
    parts.month - 1,
    parts.day,
    parts.hour,
    parts.minute,
    parts.second,
  );
  return localAsUtc - Math.floor(timestamp / 1000) * 1000;
}

function localDateKey(timestamp: number, timeZone: string): string {
  const parts = localParts(timestamp, timeZone);
  return `${parts.year.toString().padStart(4, '0')}-${parts.month
    .toString()
    .padStart(2, '0')}-${parts.day.toString().padStart(2, '0')}`;
}

function localParts(timestamp: number, timeZone: string) {
  let formatter = formatters.get(timeZone);
  if (!formatter) {
    formatter = new Intl.DateTimeFormat('en-GB', {
      timeZone,
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
      hourCycle: 'h23',
    });
    formatters.set(timeZone, formatter);
  }
  const values = formatter
    .formatToParts(new Date(timestamp))
    .reduce<Record<string, number>>((result, part) => {
      if (part.type !== 'literal') {
        result[part.type] = Number(part.value);
      }
      return result;
    }, {});
  return {
    year: values.year ?? 0,
    month: values.month ?? 0,
    day: values.day ?? 0,
    hour: values.hour ?? 0,
    minute: values.minute ?? 0,
    second: values.second ?? 0,
  };
}

function parseTimestamp(value: string): number {
  const timestamp = Date.parse(value);
  if (!Number.isFinite(timestamp)) {
    throw new RangeError('Timestamp must be a valid ISO date-time.');
  }
  return timestamp;
}
