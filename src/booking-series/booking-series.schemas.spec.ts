import { addDays, venueNow } from '../slots/venue-time.js';
import { PreviewSeriesSchema } from './booking-series.schemas.js';

const today = venueNow().date;
const base = { groundId: '00000000-0000-4000-8000-000000000001', startHour: 21, weekdays: ['mon'], fromDate: today };
const issues = (input: object) => {
  const parsed = PreviewSeriesSchema.safeParse(input);
  return parsed.success ? [] : parsed.error.issues.map((i) => i.path.join('.'));
};

describe('booking series schemas', () => {
  it('accepts an ongoing series (untilDate null or left out) and a 31-day fixed one', () => {
    expect(PreviewSeriesSchema.parse(base).untilDate).toBeNull();
    expect(issues({ ...base, untilDate: null })).toEqual([]);
    expect(issues({ ...base, untilDate: addDays(today, 30) })).toEqual([]);
  });

  it('refuses a start in the past, an end before the start or past 31 days, and no or repeated days', () => {
    expect(issues({ ...base, fromDate: addDays(today, -1) })).toEqual(['fromDate']);
    expect(issues({ ...base, untilDate: addDays(today, -1) })).toEqual(['untilDate']);
    expect(issues({ ...base, untilDate: addDays(today, 31) })).toEqual(['untilDate']);
    expect(issues({ ...base, weekdays: [] })).toEqual(['weekdays']);
    expect(issues({ ...base, weekdays: ['mon', 'mon'] })).toEqual(['weekdays']);
    expect(issues({ ...base, startHour: 24 })).toEqual(['startHour']);
  });
});
