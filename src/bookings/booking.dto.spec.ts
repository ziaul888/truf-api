import { toBookingDto, toPublicBookingDto, type BookingRow } from './booking.dto.js';

const day = (date: string) => new Date(`${date}T00:00:00Z`);
const slotAt = (id: string, startHour: number) => ({ id, date: day('2026-10-29'), startHour, startMinute: 0, durationMinutes: 60 });

const row = (overrides: object = {}) => ({
  id: 'b-1', bookingNumber: 'CT-AAAAA', source: 'portal', status: 'confirmed', paymentStatus: 'unpaid', payAtVenue: false, cancelRequestedAt: null, seriesId: null,
  ground: { id: 'g-1', name: 'Arena', sport: 'football', format: null, address: null, photos: [] },
  customer: { id: 'c-1', name: 'Rakib', phone: '+8801711000000', email: null },
  contactName: 'Rakib', contactEmail: null, contactPhone: '+8801711000000',
  amount: 2500, serviceFee: 5000, total: 7500, dueDate: null, dueNote: null, notes: null, createdBy: null,
  confirmedAt: null, cancelledAt: null, cancelReason: null, createdAt: new Date(0), updatedAt: new Date(0), payments: [],
  slot: slotAt('s-1', 18), bookingSlots: [],
  ...overrides,
}) as unknown as BookingRow;

describe('booking DTOs with several slots', () => {
  const multi = row({
    bookingSlots: [
      { price: 1500, cancelledAt: null, slot: slotAt('s-2', 19) },
      { price: 1000, cancelledAt: null, slot: slotAt('s-1', 18) },
    ],
  });

  it('keeps `slot` as the earliest and adds `slots` (earliest first, with price and status) and `slotCount`', () => {
    const dto = toBookingDto(multi);
    expect(dto.slot).toMatchObject({ id: 's-1', startTime: '18:00', endTime: '19:00' });
    expect(dto.slotCount).toBe(2);
    expect(dto.slots).toEqual([
      expect.objectContaining({ id: 's-1', startTime: '18:00', price: 1000, status: 'active', cancelledAt: null }),
      expect.objectContaining({ id: 's-2', startTime: '19:00', price: 1500, status: 'active', cancelledAt: null }),
    ]);
    expect(dto).toMatchObject({ amount: 2500, serviceFee: 5000, total: 7500 });
  });

  it('marks a cancelled slot', () => {
    const when = new Date('2026-10-28T05:00:00Z');
    const dto = toBookingDto(row({ status: 'cancelled', bookingSlots: [{ price: 1000, cancelledAt: when, slot: slotAt('s-1', 18) }] }));
    expect(dto.slots[0]).toMatchObject({ status: 'cancelled', cancelledAt: when });
  });

  it('shows every slot of a cancelled booking as cancelled, even if an older release left the row without cancelledAt', () => {
    const dto = toBookingDto({ ...multi, status: 'cancelled' } as BookingRow);
    expect(dto.slots.map((s) => s.status)).toEqual(['cancelled', 'cancelled']);
  });

  it('falls back to the single slot for a booking written without BookingSlot rows', () => {
    const dto = toBookingDto(row({ amount: 1500, total: 6500 }));
    expect(dto.slotCount).toBe(1);
    expect(dto.slots).toEqual([expect.objectContaining({ id: 's-1', price: 1500, status: 'active' })]);
  });

  it('the public DTO has the same `slots` without slot ids', () => {
    const dto = toPublicBookingDto(multi, true, false);
    expect(dto.slot).not.toHaveProperty('id');
    expect(dto.slotCount).toBe(2);
    expect(dto.slots.map((s) => s.startTime)).toEqual(['18:00', '19:00']);
    expect(dto.slots[0]).not.toHaveProperty('id');
    expect(dto.slots[0]).toMatchObject({ price: 1000, status: 'active' });
  });
});
