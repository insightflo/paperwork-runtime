/**
 * Timezone-aware next-run computation for 5-field cron expressions.
 *
 * Shared home for the cron next-occurrence logic used by both the agent wakeup
 * scheduler (claimDueSchedules → next_run_at) and schedule-horizon evaluation
 * (mission-schedule-horizon). Pure functions — no db, no metrics.
 */

import { parseCron } from "../cron.js";

/**
 * Compute the next run time for a cron expression.
 *
 * @param cronExpression - 5-field cron expression
 * @param timezone - IANA timezone string (e.g., "America/New_York")
 * @param after - Reference date (defaults to now)
 * @returns Next run Date or null if no match found
 */
export function computeNextRun(
  cronExpression: string,
  timezone: string,
  after: Date = new Date(),
): Date | null {
  try {
    const cron = parseCron(cronExpression);

    const exactUtcAnnual = computeExactUtcAnnualMatch(cron, after);
    if (exactUtcAnnual !== undefined && timezone === "UTC") {
      return exactUtcAnnual;
    }

    // Convert the reference time to the target timezone
    // We'll compute ticks in UTC and check if they match the cron schedule
    // when interpreted in the target timezone
    const cursor = new Date(after.getTime());
    cursor.setUTCSeconds(0, 0);
    cursor.setUTCMilliseconds(0);
    cursor.setUTCMinutes(cursor.getUTCMinutes() + 1);

    // Safety limit: search up to 1 year ahead (rare crons like Feb-29 may return null)
    const MAX_SEARCH_MINUTES = 366 * 24 * 60;

    // Create formatter once outside loop (Intl.DateTimeFormat construction is expensive)
    const formatter = new Intl.DateTimeFormat("en-US", {
      timeZone: timezone,
      hour12: false,
      year: "numeric",
      month: "numeric",
      day: "numeric",
      hour: "numeric",
      minute: "numeric",
      weekday: "short",
    });

    for (let i = 0; i < MAX_SEARCH_MINUTES; i++) {
      // Check if this UTC time matches the cron schedule in the target timezone
      if (matchesCronInTimeZone(cron, cursor, formatter)) {
        return new Date(cursor.getTime());
      }
      cursor.setUTCMinutes(cursor.getUTCMinutes() + 1);
    }

    return null;
  } catch {
    // Invalid cron expression - return null
    return null;
  }
}

function computeExactUtcAnnualMatch(
  cron: ReturnType<typeof parseCron>,
  after: Date,
): Date | null | undefined {
  if (
    cron.minutes.length !== 1
    || cron.hours.length !== 1
    || cron.daysOfMonth.length !== 1
    || cron.months.length !== 1
  ) {
    return undefined;
  }

  const minute = cron.minutes[0]!;
  const hour = cron.hours[0]!;
  const day = cron.daysOfMonth[0]!;
  const month = cron.months[0]!;

  for (let year = after.getUTCFullYear(); year <= after.getUTCFullYear() + 8; year += 1) {
    const candidate = new Date(Date.UTC(year, month - 1, day, hour, minute, 0, 0));
    if (
      candidate.getUTCFullYear() !== year
      || candidate.getUTCMonth() !== month - 1
      || candidate.getUTCDate() !== day
    ) {
      continue;
    }
    if (!cron.daysOfWeek.includes(candidate.getUTCDay())) {
      continue;
    }
    if (candidate.getTime() > after.getTime()) {
      return candidate;
    }
  }

  return null;
}

/**
 * Check if a given UTC date matches the cron schedule when interpreted
 * in the target timezone.
 */
function matchesCronInTimeZone(
  cron: ReturnType<typeof parseCron>,
  utcDate: Date,
  formatter: Intl.DateTimeFormat,
): boolean {
  try {
    const parts = formatter.formatToParts(utcDate);
    const map = Object.fromEntries(parts.map((p) => [p.type, p.value]));

    const weekdayIndex: Record<string, number> = {
      Sun: 0,
      Mon: 1,
      Tue: 2,
      Wed: 3,
      Thu: 4,
      Fri: 5,
      Sat: 6,
    };

    const minute = Number(map.minute);
    const hour = Number(map.hour);
    const day = Number(map.day);
    const month = Number(map.month);
    const weekday = weekdayIndex[map.weekday ?? ""] ?? 0;

    return (
      cron.minutes.includes(minute) &&
      cron.hours.includes(hour) &&
      cron.daysOfMonth.includes(day) &&
      cron.months.includes(month) &&
      cron.daysOfWeek.includes(weekday)
    );
  } catch {
    return false;
  }
}
