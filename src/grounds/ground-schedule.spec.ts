import { isOpenOn, isPeakSlot, slotPrice, slotStarts, type GroundSchedule } from './ground-schedule.js';

const base: GroundSchedule = {
  openingHour: 6,
  closingHour: 23,
  slotDurationMinutes: 60,
  hourlyPrice: 1000,
  peakPrice: null,
  peakRanges: [],
};

const times = (schedule: GroundSchedule) =>
  slotStarts(schedule).map(({ startHour, startMinute }) => `${startHour}:${String(startMinute).padStart(2, '0')}`);

describe('slotStarts', () => {
  it('makes one slot per hour by default', () => {
    expect(times({ ...base, openingHour: 8, closingHour: 12 })).toEqual(['8:00', '9:00', '10:00', '11:00']);
  });

  it('steps by two hours and drops a slot that would overrun closing', () => {
    expect(slotStarts({ ...base, slotDurationMinutes: 120 }).map((s) => s.startHour)).toEqual([6, 8, 10, 12, 14, 16, 18, 20]);
  });

  it('steps by 90 minutes, on the half hour, with the last slot ending by closing', () => {
    expect(times({ ...base, openingHour: 15, closingHour: 24, slotDurationMinutes: 90 }))
      .toEqual(['15:00', '16:30', '18:00', '19:30', '21:00', '22:30']);
    // 6–23: 11 slots, the last 21:00–22:30; one at 22:30 would run past closing.
    const day = times({ ...base, slotDurationMinutes: 90 });
    expect(day).toHaveLength(11);
    expect(day.at(-1)).toBe('21:00');
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

  it('prices 90 minutes as one and a half hours, per half hour across a peak edge', () => {
    const ninety = { ...peak, slotDurationMinutes: 90, peakRanges: [{ fromHour: 18, toHour: 22 }] };
    expect(slotPrice(ninety, 15)).toBe(1500);
    expect(slotPrice(ninety, 16, 30)).toBe(1500);
    // 17:30–18:00 off-peak (500) + 18:00–19:00 peak (1500)
    expect(slotPrice(ninety, 17, 30)).toBe(2000);
    expect(slotPrice(ninety, 18)).toBe(2250);
    expect(slotPrice(ninety, 21, 30)).toBe(1750); // 21:30–22 peak (750), 22–23 off-peak (1000)
  });

  it('rounds an odd price over 90 minutes to the nearest unit', () => {
    expect(slotPrice({ ...base, hourlyPrice: 1001, slotDurationMinutes: 90 }, 8)).toBe(1502);
  });

  it('flags a slot as peak when any half hour is peak', () => {
    const ninety = { ...peak, slotDurationMinutes: 90, peakRanges: [{ fromHour: 18, toHour: 22 }] };
    expect(isPeakSlot(ninety, 16, 30)).toBe(false);
    expect(isPeakSlot(ninety, 17, 30)).toBe(true);
    expect(isPeakSlot(peak, 16)).toBe(false);
    expect(isPeakSlot({ ...peak, slotDurationMinutes: 120 }, 16)).toBe(true);
  });
});

describe('isOpenOn', () => {
  const days = (availableDays: 'everyday' | 'weekdays' | 'weekends' | 'custom', customDays: ('mon' | 'sat')[] = []) =>
    ({ isActive: true, availableDays, customDays });

  it('treats Fri–Sat as the weekend and Sun–Thu as weekdays', () => {
    expect(isOpenOn(days('weekends'), 'fri')).toBe(true);
    expect(isOpenOn(days('weekends'), 'sat')).toBe(true);
    expect(isOpenOn(days('weekends'), 'sun')).toBe(false);
    expect(isOpenOn(days('weekends'), 'thu')).toBe(false);
    expect(isOpenOn(days('weekdays'), 'sun')).toBe(true);
    expect(isOpenOn(days('weekdays'), 'thu')).toBe(true);
    expect(isOpenOn(days('weekdays'), 'fri')).toBe(false);
    expect(isOpenOn(days('weekdays'), 'sat')).toBe(false);
    expect(isOpenOn(days('custom', ['mon']), 'mon')).toBe(true);
    expect(isOpenOn({ ...days('everyday'), isActive: false }, 'mon')).toBe(false);
  });
});
