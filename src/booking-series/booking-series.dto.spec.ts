import { summarise, type SeriesBookingDto } from './booking-series.dto.js';

const booking = (date: string, over: Partial<SeriesBookingDto> = {}): SeriesBookingDto => ({
  id: date, bookingNumber: `CT-${date}`, date, status: 'confirmed', total: 1000, paid: 0, due: 1000, ...over,
});

describe('booking series summary', () => {
  it('sums live bookings per calendar month, in month order, and counts cancelled ones apart', () => {
    const { totals, months } = summarise([
      booking('2026-12-01', { paid: 400, due: 600 }),
      booking('2026-11-24', { paid: 1000, due: 0 }),
      booking('2026-11-26', { status: 'cancelled', paid: 0, due: 0 }),
      booking('2026-11-28'),
    ]);
    expect(months).toEqual([
      { month: '2026-11', bookings: 2, total: 2000, paid: 1000, due: 1000, cancelled: 1 },
      { month: '2026-12', bookings: 1, total: 1000, paid: 400, due: 600, cancelled: 0 },
    ]);
    expect(totals).toEqual({ bookings: 3, total: 3000, paid: 1400, due: 1600 });
  });

  it('is empty with no bookings', () => {
    expect(summarise([])).toEqual({ totals: { bookings: 0, total: 0, paid: 0, due: 0 }, months: [] });
  });
});
