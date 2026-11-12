import { env } from '../config/env.js';
import type { PrismaService } from '../prisma/prisma.service.js';
import { bookingSlotLimit } from './booking-limits.js';
import { requestedStarts } from './checkout-slots.js';
import { loadStaffSlots } from './staff-booking-slots.js';

vi.mock('../config/env.js', () => ({ env: { MULTI_SLOT_BOOKINGS_ENABLED: false } }));

describe('multi-slot rollout gate', () => {
  beforeEach(() => { env.MULTI_SLOT_BOOKINGS_ENABLED = false; });

  it('advertises only one slot until the operator enables multi-slot bookings', () => {
    expect(bookingSlotLimit()).toBe(1);
    env.MULTI_SLOT_BOOKINGS_ENABLED = true;
    expect(bookingSlotLimit()).toBe(4);
  });

  it('keeps both legacy and new single-slot portal inputs working while disabled', () => {
    expect(requestedStarts({ startHour: 19, startMinute: 30 })).toEqual([{ startHour: 19, startMinute: 30 }]);
    expect(requestedStarts({ slots: [{ startHour: 19, startMinute: 30 }], startMinute: 0 })).toEqual([{ startHour: 19, startMinute: 30 }]);
  });

  it('rejects multiple portal slots while disabled', () => {
    expect(() => requestedStarts({ slots: [{ startHour: 18, startMinute: 0 }, { startHour: 19, startMinute: 0 }], startMinute: 0 }))
      .toThrowError(expect.objectContaining({ status: 400, code: 'TOO_MANY_SLOTS' }));
  });

  it('rejects multiple staff slots before querying or claiming any inventory', async () => {
    const findMany = vi.fn();
    const db = { slot: { findMany } } as unknown as Pick<PrismaService, 'slot'>;
    await expect(loadStaffSlots(db, ['s1', 's2'])).rejects.toMatchObject({ status: 400, code: 'TOO_MANY_SLOTS' });
    expect(findMany).not.toHaveBeenCalled();
  });

  it('accepts multiple portal slots after the operator enables them', () => {
    env.MULTI_SLOT_BOOKINGS_ENABLED = true;
    expect(requestedStarts({ slots: [{ startHour: 19, startMinute: 30 }, { startHour: 18, startMinute: 0 }], startMinute: 0 }))
      .toEqual([{ startHour: 18, startMinute: 0 }, { startHour: 19, startMinute: 30 }]);
  });
});
