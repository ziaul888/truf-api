import { AppError } from '../common/app-error.js';
import { assertRange, planDay, upcomingWhere, type GroundForSlots } from './slot-rules.js';

const ground = (overrides: Partial<GroundForSlots> = {}): GroundForSlots => ({
  id: 'g-1', openingHour: 8, closingHour: 12, slotDurationMinutes: 60, hourlyPrice: 1000,
  peakPrice: null, peakRanges: [], isActive: true, availableDays: 'everyday', customDays: [],
  ...overrides,
});
const morning = { date: '2026-10-28', minutes: 0 };
const hours = (plan: ReturnType<typeof planDay>) => plan.create.map((s) => s.startHour);

describe('planDay', () => {
  it('creates one slot per step with its price, including peak hours', () => {
    const plan = planDay(ground({ slotDurationMinutes: 120, peakPrice: 1500, peakRanges: [{ fromHour: 11, toHour: 12 }] }), '2026-10-29', [], morning);
    expect(plan.create).toEqual([
      expect.objectContaining({ startHour: 8, durationMinutes: 120, price: 2000, date: new Date('2026-10-29T00:00:00Z') }),
      expect.objectContaining({ startHour: 10, price: 2500 }),
    ]);
  });

  it('skips slots that overlap a stored slot, even one of a different length', () => {
    const plan = planDay(ground({ slotDurationMinutes: 120 }), '2026-10-29', [{ startHour: 9, startMinute: 0, durationMinutes: 60 }], morning);
    expect(hours(plan)).toEqual([10]);
    expect(plan.skipped).toBe(1);
  });

  it('skips slots that have already started today', () => {
    const plan = planDay(ground(), '2026-10-28', [], { date: '2026-10-28', minutes: 9 * 60 + 15 });
    expect(hours(plan)).toEqual([10, 11]);
    expect(plan.skipped).toBe(2);
  });

  it('90-minute slots start on the half hour, priced per half hour, with none overrunning closing', () => {
    const g = ground({ openingHour: 15, closingHour: 24, slotDurationMinutes: 90, peakPrice: 1500, peakRanges: [{ fromHour: 18, toHour: 24 }] });
    const plan = planDay(g, '2026-10-29', [], morning);
    expect(plan.create.map((s) => [s.startHour, s.startMinute, s.price])).toEqual([
      [15, 0, 1500], [16, 30, 1500], [18, 0, 2250], [19, 30, 2250], [21, 0, 2250], [22, 30, 2250],
    ]);
    expect(plan.create[0]).toMatchObject({ durationMinutes: 90 });
  });

  it('90-minute slots: overlap and "started" are checked to the minute', () => {
    const g = ground({ openingHour: 15, closingHour: 21, slotDurationMinutes: 90 });
    const times = (plan: ReturnType<typeof planDay>) => plan.create.map((s) => `${s.startHour}:${String(s.startMinute).padStart(2, '0')}`);
    // At 16:29, 15:00 has started but 16:30 hasn't.
    expect(times(planDay(g, '2026-10-28', [], { date: '2026-10-28', minutes: 16 * 60 + 29 }))).toEqual(['16:30', '18:00', '19:30']);
    // A kept 60-minute slot at 17:00 overlaps 16:30–18:00 only.
    const kept = planDay(g, '2026-10-29', [{ startHour: 17, startMinute: 0, durationMinutes: 60 }], morning);
    expect(times(kept)).toEqual(['15:00', '18:00', '19:30']);
    expect(kept.skipped).toBe(1);
  });

  it('plans nothing on closed days or for inactive grounds', () => {
    // 2026-10-28 is a Wednesday.
    expect(planDay(ground({ availableDays: 'weekends' }), '2026-10-28', [], morning).create).toEqual([]);
    expect(planDay(ground({ availableDays: 'custom', customDays: ['wed'] }), '2026-10-28', [], morning).create).toHaveLength(4);
    expect(planDay(ground({ isActive: false }), '2026-10-29', [], morning).create).toEqual([]);
  });
});

describe('upcomingWhere', () => {
  it('counts a slot later this hour as upcoming', () => {
    expect(upcomingWhere({ date: '2026-10-28', minutes: 16 * 60 + 10 }).OR).toEqual([
      { date: { gt: new Date('2026-10-28T00:00:00Z') } },
      { date: new Date('2026-10-28T00:00:00Z'), startHour: { gt: 16 } },
      { date: new Date('2026-10-28T00:00:00Z'), startHour: 16, startMinute: { gt: 10 } },
    ]);
  });
});

describe('assertRange', () => {
  const code = (fn: () => void) => {
    try { fn(); } catch (e) { return (e as AppError).code; }
    return undefined;
  };

  it('rejects reversed and over-long ranges', () => {
    expect(code(() => assertRange('2026-10-28', '2026-10-28', 1))).toBeUndefined();
    expect(code(() => assertRange('2026-10-29', '2026-10-28', 14))).toBe('INVALID_DATE_RANGE');
    expect(code(() => assertRange('2026-10-01', '2026-10-15', 14))).toBe('INVALID_DATE_RANGE');
  });
});
