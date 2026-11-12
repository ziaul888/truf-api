import {
  assertSameGroundDate, currentSlots, hasUpcomingSlot, hoursOf, liveSlots, primaryOf, slotRowsOf, sumPrice, windowHasEnded, windowHasStarted, windowOf, windowTimes,
  type BookingSlotRef, type BookingSlotsSource,
} from './booking-slots.js';

const day = (date: string) => new Date(`${date}T00:00:00Z`);
const slotAt = (id: string, startHour: number, startMinute = 0, durationMinutes = 60) => ({
  id, date: day('2026-10-29'), startHour, startMinute, durationMinutes,
});
const row = (id: string, startHour: number, extra: Partial<BookingSlotRef> = {}, startMinute = 0, durationMinutes = 60): BookingSlotRef => ({
  cancelledAt: null, price: 1000, slot: slotAt(id, startHour, startMinute, durationMinutes), ...extra,
});
const booking = (bookingSlots: BookingSlotRef[], extra: Partial<BookingSlotsSource> = {}): BookingSlotsSource => ({
  slot: bookingSlots[0]?.slot ?? slotAt('s-1', 18), amount: 3000, bookingSlots, ...extra,
});

describe('hasUpcomingSlot', () => {
  it('matches the primary slot OR any live BookingSlot still ahead', () => {
    const where = hasUpcomingSlot({ date: '2026-10-28', minutes: 600 });
    expect(where.OR).toHaveLength(2);
    expect(where.OR![1]).toMatchObject({ bookingSlots: { some: { cancelledAt: null, slot: expect.anything() } } });
    expect(where.OR![0]).toHaveProperty('slot');
  });
});

describe('booking slots', () => {
  const three = booking([row('s-3', 21), row('s-1', 18), row('s-2', 19, {}, 0, 90)]);

  it('lists the slots earliest first', () => {
    expect(slotRowsOf(three).map((r) => r.slot.id)).toEqual(['s-1', 's-2', 's-3']);
  });

  it('keeps only the live ones, and the earliest live one is the primary', () => {
    const b = booking([row('s-1', 18, { cancelledAt: new Date() }), row('s-2', 19), row('s-3', 21)]);
    expect(liveSlots(b).map((r) => r.slot.id)).toEqual(['s-2', 's-3']);
    expect(primaryOf(b).slot.id).toBe('s-2');
  });

  it('a cancelled booking has no live slot: its slots still describe it', () => {
    const b = booking([row('s-1', 18, { cancelledAt: new Date() }), row('s-2', 19, { cancelledAt: new Date() })]);
    expect(liveSlots(b)).toEqual([]);
    expect(currentSlots(b)).toHaveLength(2);
    expect(primaryOf(b).slot.id).toBe('s-1');
    expect(windowOf(b)).toEqual({ date: '2026-10-29', startMinutes: 18 * 60, endMinutes: 20 * 60 });
  });

  it('falls back to the single slot for a booking with no BookingSlot rows (older release)', () => {
    const old = booking([], { slot: slotAt('s-9', 20), amount: 1500, cancelledAt: null });
    expect(slotRowsOf(old)).toEqual([{ cancelledAt: null, price: 1500, slot: old.slot }]);
    expect(primaryOf(old).slot.id).toBe('s-9');
    const cancelled = booking([], { slot: slotAt('s-9', 20), cancelledAt: new Date() });
    expect(liveSlots(cancelled)).toEqual([]);
  });

  describe('windowOf', () => {
    it('runs from the earliest live slot start to the last live slot end, gaps included', () => {
      // 18:00-19:00, 19:00-20:30 (90 min), 21:00-22:00
      expect(windowOf(three)).toEqual({ date: '2026-10-29', startMinutes: 1080, endMinutes: 1320 });
      expect(windowTimes(windowOf(three))).toMatchObject({ startTime: '18:00', endTime: '22:00', endHour: 22, endMinute: 0 });
    });

    it('ignores cancelled slots while others are live', () => {
      const b = booking([row('s-1', 18, { cancelledAt: new Date() }), row('s-2', 19)]);
      expect(windowOf(b)).toMatchObject({ startMinutes: 19 * 60, endMinutes: 20 * 60 });
    });

    it('handles half-hour starts and a slot ending at midnight', () => {
      const b = booking([row('s-1', 22, {}, 30, 90)]);
      expect(windowTimes(windowOf(b))).toMatchObject({ startTime: '22:30', endTime: '24:00', endHour: 24 });
    });

    it('tells started and ended from the window (the last slot decides "ended")', () => {
      const w = windowOf(three); // 18:00-22:00 on 2026-10-29
      const at = (hour: number) => ({ date: '2026-10-29', minutes: hour * 60 });
      expect(windowHasStarted(at(17), w)).toBe(false);
      expect(windowHasStarted(at(18), w)).toBe(true);
      expect(windowHasEnded(at(21), w)).toBe(false);
      expect(windowHasEnded(at(22), w)).toBe(true);
    });
  });

  it('adds up hours and prices', () => {
    expect(hoursOf(three)).toBe(3.5);
    expect(sumPrice([{ price: 1000 }, { price: 1500 }, { price: 800 }])).toBe(3300);
    expect(sumPrice([])).toBe(0);
  });

  describe('assertSameGroundDate', () => {
    const s = (groundId: string, date: string) => ({ groundId, date: day(date) });

    it('accepts one ground and date, or nothing', () => {
      expect(() => assertSameGroundDate([s('g-1', '2026-10-29'), s('g-1', '2026-10-29')])).not.toThrow();
      expect(() => assertSameGroundDate([])).not.toThrow();
    });

    it.each([
      ['two dates', [s('g-1', '2026-10-29'), s('g-1', '2026-10-30')]],
      ['two grounds', [s('g-1', '2026-10-29'), s('g-2', '2026-10-29')]],
    ])('refuses %s with 400 SLOTS_MUST_SHARE_GROUND_DATE', (_label, slots) => {
      expect(() => assertSameGroundDate(slots)).toThrowError(expect.objectContaining({ status: 400, code: 'SLOTS_MUST_SHARE_GROUND_DATE' }));
    });
  });
});
