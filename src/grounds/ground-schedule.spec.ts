import { isOpenOn, slotPrice, slotStartHours, type GroundSchedule } from './ground-schedule.js';

const base: GroundSchedule = {
  openingHour: 6,
  closingHour: 23,
  slotDurationMinutes: 60,
  hourlyPrice: 1000,
  peakPrice: null,
  peakRanges: [],
};

describe('slotStartHours', () => {
  it('makes one slot per hour by default', () => {
    expect(slotStartHours({ ...base, openingHour: 8, closingHour: 12 })).toEqual([8, 9, 10, 11]);
  });

  it('steps by two hours and drops a slot that would overrun closing', () => {
    expect(slotStartHours({ ...base, slotDurationMinutes: 120 })).toEqual([6, 8, 10, 12, 14, 16, 18, 20]);
  });
});

describe('slotPrice', () => {
  const peak = { ...base, peakPrice: 1500, peakRanges: [{ fromHour: 17, toHour: 22 }] };

  it('uses the hourly price without peak pricing', () => {
    expect(slotPrice(base, 18)).toBe(1000);
  });

  it('uses the peak price inside a range and the off-peak price outside it', () => {
    expect(slotPrice(peak, 16)).toBe(1000);
    expect(slotPrice(peak, 17)).toBe(1500);
    expect(slotPrice(peak, 22)).toBe(1000); // ranges end exclusive
  });

  it('prices a 2-hour slot hour by hour, even across a range edge', () => {
    const twoHour = { ...peak, slotDurationMinutes: 120 };
    expect(slotPrice(twoHour, 14)).toBe(2000);
    expect(slotPrice(twoHour, 16)).toBe(2500);
    expect(slotPrice(twoHour, 18)).toBe(3000);
  });
});

describe('isOpenOn', () => {
  const days = (availableDays: 'everyday' | 'weekdays' | 'weekends' | 'custom', customDays: ('mon' | 'sat')[] = []) =>
    ({ isActive: true, availableDays, customDays });

  it('treats Sat–Sun as the weekend', () => {
    expect(isOpenOn(days('weekends'), 'sat')).toBe(true);
    expect(isOpenOn(days('weekends'), 'fri')).toBe(false);
    expect(isOpenOn(days('weekdays'), 'fri')).toBe(true);
    expect(isOpenOn(days('custom', ['mon']), 'mon')).toBe(true);
    expect(isOpenOn({ ...days('everyday'), isActive: false }, 'mon')).toBe(false);
  });
});
