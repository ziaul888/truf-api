import type { PrismaService } from '../prisma/prisma.service.js';
import { slotLimitOf } from './booking-limits.js';
import { requestedStarts } from './checkout-slots.js';
import { loadStaffSlots } from './staff-booking-slots.js';

const two = [
  { startHour: 18, startMinute: 0 as const },
  { startHour: 19, startMinute: 30 as const },
];

describe('slotLimitOf', () => {
  it.each([2, 3, 4])(
    'is 1 while multi-slot is off, whatever the saved maximum (%i)',
    (max) => {
      expect(
        slotLimitOf({ multiSlotEnabled: false, maxSlotsPerBooking: max }),
      ).toBe(1);
    },
  );

  it.each([2, 3, 4])('is the saved maximum (%i) while on', (max) => {
    expect(
      slotLimitOf({ multiSlotEnabled: true, maxSlotsPerBooking: max }),
    ).toBe(max);
  });

  it('clamps a stored value outside 1..4', () => {
    expect(slotLimitOf({ multiSlotEnabled: true, maxSlotsPerBooking: 9 })).toBe(
      4,
    );
    expect(slotLimitOf({ multiSlotEnabled: true, maxSlotsPerBooking: 0 })).toBe(
      1,
    );
  });
});

describe('multi-slot limit on new bookings', () => {
  it('keeps both legacy and new single-slot portal inputs working at a limit of 1', () => {
    expect(requestedStarts({ startHour: 19, startMinute: 30 }, 1)).toEqual([
      { startHour: 19, startMinute: 30 },
    ]);
    expect(
      requestedStarts(
        { slots: [{ startHour: 19, startMinute: 30 }], startMinute: 0 },
        1,
      ),
    ).toEqual([{ startHour: 19, startMinute: 30 }]);
  });

  it('rejects multiple portal slots at a limit of 1', () => {
    expect(() =>
      requestedStarts({ slots: two, startMinute: 0 }, 1),
    ).toThrowError(
      expect.objectContaining({ status: 400, code: 'TOO_MANY_SLOTS' }),
    );
  });

  it('accepts two portal slots at a limit of 2, earliest first', () => {
    expect(
      requestedStarts({ slots: [two[1]!, two[0]!], startMinute: 0 }, 2),
    ).toEqual(two);
  });

  it('rejects multiple staff slots before querying or claiming any inventory', async () => {
    const findMany = vi.fn();
    const db = { slot: { findMany } } as unknown as Pick<PrismaService, 'slot'>;
    await expect(loadStaffSlots(db, ['s1', 's2'], 1)).rejects.toMatchObject({
      status: 400,
      code: 'TOO_MANY_SLOTS',
    });
    expect(findMany).not.toHaveBeenCalled();
  });
});
