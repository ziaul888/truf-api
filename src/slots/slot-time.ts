// A slot's place in the day: it starts at startHour:startMinute (minute 0 or 30) and runs durationMinutes.

/** When a slot starts. */
export interface SlotStart {
  startHour: number;
  startMinute: number;
}

/** When a slot starts and how long it runs. */
export interface SlotClock extends SlotStart {
  durationMinutes: number;
}

/** The start and end every slot and booking response carries. `endHour` is the hour part (24:00 → 24). */
export interface SlotTimes {
  startHour: number;
  startMinute: number;
  endHour: number;
  endMinute: number;
  /** "HH:MM" */
  startTime: string;
  /** "HH:MM"; a slot ending at midnight ends at "24:00". */
  endTime: string;
}

/** Minutes since venue-local midnight that the slot starts. */
export const startMinutesOf = (s: SlotStart) => s.startHour * 60 + (s.startMinute ?? 0);

export const endMinutesOf = (s: SlotClock) => startMinutesOf(s) + s.durationMinutes;

/**
 * The start as a fractional hour (18:30 → 18.5), for the venue-time helpers
 * (`minutesUntil`, `hasStarted`, `hasEnded`), which work in minutes underneath.
 */
export const slotHour = (s: SlotStart) => startMinutesOf(s) / 60;

const pad = (n: number) => String(n).padStart(2, '0');

/** Minutes since midnight → "HH:MM" (1440 → "24:00"). */
export const hhmm = (minutes: number) => `${pad(Math.floor(minutes / 60))}:${pad(minutes % 60)}`;

export function slotTimes(s: SlotClock): SlotTimes {
  const start = startMinutesOf(s);
  const end = endMinutesOf(s);
  return {
    startHour: s.startHour, startMinute: s.startMinute ?? 0, endHour: Math.floor(end / 60), endMinute: end % 60,
    startTime: hhmm(start), endTime: hhmm(end),
  };
}
