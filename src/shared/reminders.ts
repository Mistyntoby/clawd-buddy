/** Reminder parsing and types. Pure, so it is shared and unit-tested. */

export interface Reminder {
  id: string;
  text: string;
  /** When it is due, epoch ms. */
  dueAt: number;
  createdAt: number;
  /** pending → fired (shown, waiting to be dismissed) → dismissed */
  status: "pending" | "fired" | "dismissed";
}

export const MAX_REMINDERS = 100;
export const MAX_REMINDER_TEXT = 200;
/** Furthest ahead a reminder can be set: one year. */
export const MAX_REMINDER_AHEAD_MS = 366 * 24 * 3600_000;

const UNIT_MS: Record<string, number> = {
  s: 1000,
  sec: 1000,
  secs: 1000,
  second: 1000,
  seconds: 1000,
  m: 60_000,
  min: 60_000,
  mins: 60_000,
  minute: 60_000,
  minutes: 60_000,
  h: 3600_000,
  hr: 3600_000,
  hrs: 3600_000,
  hour: 3600_000,
  hours: 3600_000,
  d: 86_400_000,
  day: 86_400_000,
  days: 86_400_000,
};

export type ParsedReminder = { ok: true; dueAt: number; text: string } | { ok: false; error: string };

export const REMINDER_HELP = 'Try "10m stretch", "1h30m check the oven", "in 2 hours call back", or "at 15:30 standup".';

/**
 * Parses "<when> <what>". Supported: durations ("10m", "1h30m", "90s",
 * "2 hours", "in 15 minutes", a bare number = minutes) and clock times
 * ("at 15:30", "at 9am", "7:05pm"; today, or tomorrow if already past).
 */
export function parseReminder(input: string, now: number): ParsedReminder {
  // eslint-disable-next-line no-control-regex -- deliberately stripping control characters
  const raw = input.replace(/[\u0000-\u001f]/g, " ").trim();
  if (!raw) return { ok: false, error: `What should I remind you about? ${REMINDER_HELP}` };
  let rest = raw.replace(/^(in|after)\s+/i, "");
  let dueAt: number;

  const clock = /^(?:at\s+)?(\d{1,2})(?::(\d{2}))?\s*(am|pm)?(?=\s|$)/i.exec(rest);
  const hasClockMarker = /^at\s+/i.test(rest) || /^\d{1,2}:\d{2}/.test(rest) || /^\d{1,2}\s*(am|pm)\b/i.test(rest);
  if (clock && hasClockMarker) {
    let hour = Number(clock[1]);
    const minute = Number(clock[2] ?? 0);
    const ampm = clock[3]?.toLowerCase();
    if (ampm === "pm" && hour < 12) hour += 12;
    if (ampm === "am" && hour === 12) hour = 0;
    if (hour > 23 || minute > 59) return { ok: false, error: "That time doesn't look right." };
    const d = new Date(now);
    d.setHours(hour, minute, 0, 0);
    if (d.getTime() <= now) d.setDate(d.getDate() + 1);
    dueAt = d.getTime();
    rest = rest.slice(clock[0].length);
  } else {
    let total = 0;
    let matched = false;
    const part = /^(\d+(?:\.\d+)?)\s*([a-z]+)?\s*/i;
    for (;;) {
      const m = part.exec(rest);
      if (!m) break;
      const unit = m[2]?.toLowerCase();
      const ms = unit === undefined ? 60_000 : UNIT_MS[unit];
      if (ms === undefined) {
        // "15 to drink water": a bare leading number means minutes; the word belongs to the text.
        if (!matched) {
          total += Number(m[1]) * 60_000;
          matched = true;
          rest = rest.slice((m[1] as string).length).trimStart();
        }
        break;
      }
      total += Number(m[1]) * ms;
      matched = true;
      rest = rest.slice(m[0].length);
      if (unit === undefined) break;
    }
    if (!matched) return { ok: false, error: `When should I remind you? ${REMINDER_HELP}` };
    if (total < 1000) return { ok: false, error: "That's a bit soon! Use at least a few seconds." };
    dueAt = now + Math.round(total);
  }

  const text = rest.replace(/^(to|that|about)\s+/i, "").trim().slice(0, MAX_REMINDER_TEXT);
  if (!text) return { ok: false, error: `What should I remind you about? ${REMINDER_HELP}` };
  if (dueAt - now > MAX_REMINDER_AHEAD_MS) return { ok: false, error: "That's more than a year away. Try something sooner." };
  return { ok: true, dueAt, text };
}

/** Agenda heading for the day a reminder falls on: "Today", "Tomorrow", or a weekday and date. */
export function dayLabel(dueAt: number, now: number): string {
  const d = new Date(dueAt);
  const today = new Date(now);
  if (d.toDateString() === today.toDateString()) return "Today";
  const tomorrow = new Date(now);
  tomorrow.setDate(tomorrow.getDate() + 1);
  if (d.toDateString() === tomorrow.toDateString()) return "Tomorrow";
  if (dueAt < now) return "Earlier";
  return d.toLocaleDateString(undefined, { weekday: "long", month: "short", day: "numeric" });
}

/** "in 5 min", "in 2 h 10 min", "at 15:30 tomorrow"-style label for when a reminder is due. */
export function describeDue(dueAt: number, now: number): string {
  const diff = dueAt - now;
  if (diff <= 0) return "now";
  if (diff < 60_000) return `in ${Math.ceil(diff / 1000)} s`;
  if (diff < 3600_000) return `in ${Math.round(diff / 60_000)} min`;
  const d = new Date(dueAt);
  const time = `${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;
  const today = new Date(now);
  const sameDay = d.toDateString() === today.toDateString();
  const tomorrow = new Date(now + 86_400_000).toDateString() === d.toDateString();
  return sameDay ? `at ${time}` : tomorrow ? `tomorrow at ${time}` : `${d.toLocaleDateString()} ${time}`;
}
