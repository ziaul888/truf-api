import type { EmailService } from '../email/email.service.js';
import type { PrismaService } from '../prisma/prisma.service.js';
import type { SettingsStore } from '../settings/settings-store.service.js';
import type { SlotSettingsService } from '../slots/slot-settings.service.js';
import { BookingNotifier } from './booking-notifier.service.js';

const row = (contactEmail: string | null) => ({
  id: 'b-1',
  bookingNumber: 'CT-AAAAA',
  contactName: 'Rakib',
  contactEmail,
  contactPhone: '+8801711000000',
  total: 6500,
  paymentStatus: 'unpaid',
  dueNote: null,
  payments: [],
  ground: { id: 'g-1', name: 'Arena', address: null },
  slot: {
    date: new Date('2026-10-29T00:00:00Z'),
    startHour: 18,
    durationMinutes: 60,
  },
  bookingSlots: [] as object[],
});

function setup(
  contactEmail: string | null,
  bookingSlots: object[] = [],
  extra: object = {},
) {
  const prisma = {
    booking: {
      findUniqueOrThrow: vi.fn(async () => ({
        ...row(contactEmail),
        bookingSlots,
        ...extra,
      })),
    },
    bookingEvent: { create: vi.fn(async () => ({})) },
    user: { findMany: vi.fn(async () => []) },
  };
  const email = { send: vi.fn(async (_message: { text: string }) => true) };
  const settings = { get: vi.fn(async () => ({ notifyAdminOnBooking: true })) };
  const store = {
    get: vi.fn(async () => ({
      staffRecipients: ['staff@x.test'],
      refundIssued: true,
    })),
  };
  const notifier = new BookingNotifier(
    prisma as unknown as PrismaService,
    email as unknown as EmailService,
    settings as unknown as SlotSettingsService,
    store as unknown as SettingsStore,
  );
  return { notifier, prisma, email };
}

describe('BookingNotifier', () => {
  it('sends a customer email and logs it as a booking event', async () => {
    const { notifier, prisma, email } = setup('r@x.test');
    await expect(notifier.confirmed('b-1')).resolves.toBe(true);
    expect(email.send).toHaveBeenCalledWith(
      expect.objectContaining({ to: 'r@x.test', kind: 'booking_confirmed' }),
    );
    expect(prisma.bookingEvent.create).toHaveBeenCalledTimes(1);
  });

  it('lists every slot of a multi-slot booking in the email', async () => {
    const slotAt = (id: string, startHour: number) => ({
      price: 1500,
      cancelledAt: null,
      slot: {
        id,
        date: new Date('2026-10-29T00:00:00Z'),
        startHour,
        startMinute: 0,
        durationMinutes: 60,
      },
    });
    const { notifier, email } = setup('r@x.test', [
      slotAt('s-2', 21),
      slotAt('s-1', 18),
    ]);
    await notifier.confirmed('b-1');
    expect(email.send).toHaveBeenCalledWith(
      expect.objectContaining({
        text: expect.stringContaining(
          'When: 2026-10-29, 18:00–19:00, 21:00–22:00',
        ),
      }),
    );
  });

  describe('cash booking with a wallet deposit', () => {
    const payment = (status: 'pending' | 'succeeded') => ({
      id: 'p-1',
      method: 'bkash',
      amount: 1950,
      status,
      reference: 'ABC123XYZ',
      payerNumber: '+8801811000000',
    });

    it('says the deposit is under review and the balance is paid in cash, not the total', async () => {
      const { notifier, email } = setup('r@x.test', [], {
        payAtVenue: true,
        status: 'pending',
        payments: [payment('pending')],
      });
      await notifier.received('b-1');
      const { text } = email.send.mock.calls[0]![0];
      expect(text).toContain('bKash deposit of 19.50 BDT');
      expect(text).toContain('verify it and confirm your booking');
      expect(text).toContain('remaining 45.50 BDT in cash at the venue');
      expect(text).not.toContain('Please pay 65.00 BDT in cash');
    });

    it('keeps the plain bKash wording when the whole total was sent', async () => {
      const { notifier, email } = setup('r@x.test', [], {
        payAtVenue: false,
        payments: [{ ...payment('pending'), amount: 6500 }],
      });
      await notifier.received('b-1');
      const { text } = email.send.mock.calls[0]![0];
      expect(text).toContain('payment details for 65.00 BDT');
      expect(text).not.toContain('in cash');
    });

    it('the confirmation email names the balance once the deposit is verified', async () => {
      const { notifier, email } = setup('r@x.test', [], {
        payAtVenue: true,
        status: 'confirmed',
        payments: [payment('succeeded')],
      });
      await notifier.confirmed('b-1');
      expect(email.send.mock.calls[0]![0].text).toContain(
        'Paid so far: 19.50 BDT. Please pay the remaining 45.50 BDT in cash at the venue.',
      );
    });

    it('the confirmation email of a plain cash booking has no balance line', async () => {
      const { notifier, email } = setup('r@x.test', [], {
        payAtVenue: true,
        status: 'confirmed',
      });
      await notifier.confirmed('b-1');
      expect(email.send.mock.calls[0]![0].text).not.toContain('Paid so far');
    });
  });

  it('with no contact email sends and logs nothing to the customer', async () => {
    const { notifier, prisma, email } = setup(null);
    await expect(notifier.confirmed('b-1')).resolves.toBe(false);
    await expect(notifier.received('b-1')).resolves.toBe(false);
    await expect(notifier.cancelled('b-1', { refunded: 6500 })).resolves.toBe(
      false,
    );
    await expect(notifier.paymentRefunded('b-1', 6500)).resolves.toBe(false);
    await expect(notifier.paymentDue('b-1', 6500)).resolves.toBe(false);
    expect(email.send).not.toHaveBeenCalled();
    expect(prisma.bookingEvent.create).not.toHaveBeenCalled();
  });

  it('still emails staff about a booking with no contact email', async () => {
    const { notifier, email } = setup(null);
    await notifier.newBookingToAdmins('b-1');
    expect(email.send).toHaveBeenCalledWith(
      expect.objectContaining({
        to: 'staff@x.test',
        kind: 'staff_new_booking',
      }),
    );
  });
});
