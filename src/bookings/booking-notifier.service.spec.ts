import type { EmailService } from '../email/email.service.js';
import type { PrismaService } from '../prisma/prisma.service.js';
import type { SettingsStore } from '../settings/settings-store.service.js';
import type { SlotSettingsService } from '../slots/slot-settings.service.js';
import { BookingNotifier } from './booking-notifier.service.js';

const row = (contactEmail: string | null) => ({
  id: 'b-1', bookingNumber: 'CT-AAAAA', contactName: 'Rakib', contactEmail, contactPhone: '+8801711000000', total: 6500,
  paymentStatus: 'unpaid', dueNote: null, payments: [],
  ground: { id: 'g-1', name: 'Arena', address: null },
  slot: { date: new Date('2026-10-29T00:00:00Z'), startHour: 18, durationMinutes: 60 },
});

function setup(contactEmail: string | null) {
  const prisma = {
    booking: { findUniqueOrThrow: vi.fn(async () => row(contactEmail)) },
    bookingEvent: { create: vi.fn(async () => ({})) },
    user: { findMany: vi.fn(async () => []) },
  };
  const email = { send: vi.fn(async () => true) };
  const settings = { get: vi.fn(async () => ({ notifyAdminOnBooking: true })) };
  const store = { get: vi.fn(async () => ({ staffRecipients: ['staff@x.test'], refundIssued: true })) };
  const notifier = new BookingNotifier(
    prisma as unknown as PrismaService, email as unknown as EmailService,
    settings as unknown as SlotSettingsService, store as unknown as SettingsStore,
  );
  return { notifier, prisma, email };
}

describe('BookingNotifier', () => {
  it('sends a customer email and logs it as a booking event', async () => {
    const { notifier, prisma, email } = setup('r@x.test');
    await expect(notifier.confirmed('b-1')).resolves.toBe(true);
    expect(email.send).toHaveBeenCalledWith(expect.objectContaining({ to: 'r@x.test', kind: 'booking_confirmed' }));
    expect(prisma.bookingEvent.create).toHaveBeenCalledTimes(1);
  });

  it('with no contact email sends and logs nothing to the customer', async () => {
    const { notifier, prisma, email } = setup(null);
    await expect(notifier.confirmed('b-1')).resolves.toBe(false);
    await expect(notifier.received('b-1')).resolves.toBe(false);
    await expect(notifier.cancelled('b-1', { refunded: 6500 })).resolves.toBe(false);
    await expect(notifier.paymentRefunded('b-1', 6500)).resolves.toBe(false);
    await expect(notifier.paymentDue('b-1', 6500)).resolves.toBe(false);
    expect(email.send).not.toHaveBeenCalled();
    expect(prisma.bookingEvent.create).not.toHaveBeenCalled();
  });

  it('still emails staff about a booking with no contact email', async () => {
    const { notifier, email } = setup(null);
    await notifier.newBookingToAdmins('b-1');
    expect(email.send).toHaveBeenCalledWith(expect.objectContaining({ to: 'staff@x.test', kind: 'staff_new_booking' }));
  });
});
