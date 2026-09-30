const HOUR_MS = 3_600_000;
const DAY_MS = 24 * HOUR_MS;
const SHANGHAI_OFFSET_MS = 8 * HOUR_MS;

// Stored hours are inclusive: 22..5 means [22:00, next day 06:00).
export function validWorkHours(startHour: number, endHour: number) {
  return Number.isInteger(startHour) && Number.isInteger(endHour)
    && startHour >= 0 && startHour <= 23 && endHour >= 0 && endHour <= 23;
}

function nextWorkWindow(now: number, startHour: number, endHour: number) {
  if (!validWorkHours(startHour, endHour)) throw new Error("work hours must be integer hours between 0 and 23");
  const anchor = startHour * HOUR_MS - SHANGHAI_OFFSET_MS;
  let start = Math.floor((now - anchor) / DAY_MS) * DAY_MS + anchor;
  const duration = ((endHour - startHour + 24) % 24 + 1) * HOUR_MS;
  if (now >= start + duration) start += DAY_MS;
  return { start, end: start + duration };
}

export function isShanghaiWorkTime(now: number, startHour: number, endHour: number) {
  const window = nextWorkWindow(now, startHour, endHour);
  return now >= window.start && now < window.end;
}

export function addShanghaiWorkMinutes(now: number, minutes: number, startHour: number, endHour: number): string {
  let cursor = now;
  let remaining = Math.max(0, minutes) * 60_000;
  while (true) {
    const window = nextWorkWindow(cursor, startHour, endHour);
    cursor = Math.max(cursor, window.start);
    const available = window.end - cursor;
    if (remaining < available) return new Date(cursor + remaining).toISOString();
    // An exact closing-time deadline waits until the next opening, too.
    remaining -= available;
    cursor = window.end;
  }
}

export function remainingShanghaiWorkMilliseconds(now: number, due: number, startHour: number, endHour: number) {
  let cursor = now;
  let total = 0;
  while (cursor < due) {
    const window = nextWorkWindow(cursor, startHour, endHour);
    const from = Math.max(cursor, window.start);
    total += Math.max(0, Math.min(due, window.end) - from);
    cursor = window.end;
  }
  return total;
}
