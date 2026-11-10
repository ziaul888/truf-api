import { env } from '../config/env.js';
import type { PrismaService } from '../prisma/prisma.service.js';
import type { StripeService } from '../payments/stripe.service.js';
import { DEFAULT_SLOT_SETTINGS, type SlotSettingsService } from '../slots/slot-settings.service.js';
import type { BookingCancellationService } from './booking-cancellation.service.js';
import type { BookingNotifier } from './booking-notifier.service.js';
import { bookingToken } from './booking-rules.js';
import { CheckoutSchema } from './bookings.schemas.js';
import { CheckoutService } from './checkout.service.js';

// 04:00 UTC = 10:00 in Dhaka, Wed 28 Oct 2026.
const NOW = new Date('2026-10-28T04:00:00Z');

const slotRow = (overrides: object = {}) => ({ id: 's-1', groundId: 'g-1', startHour: 18, startMinute: 0, price: 1500, status: 'available', ...overrides });
const input = {
  groundId: 'g-1', date: '2026-10-29', startHour: 18, startMinute: 0 as 0 | 30, customerName: 'Rakib', customerEmail: 'r@x.test', customerPhone: '+8801711000000',
  paymentMethod: 'card' as 'card' | 'cash' | 'bkash' | 'nagad',
};
/** Cash, bKash and Nagad need a signed-in customer: their verified phone. */
const SIGNED_IN = input.customerPhone;

function setup({
  slot = slotRow() as object | null, ground = { id: 'g-1', name: 'Arena', availableDays: 'everyday', customDays: [] } as object | null,
  held = 1, cash = true, existing = null as object | null, bkashNumber = null as string | null, openUnpaid = 0, switches = {},
} = {}) {
  const tx = {
    slot: { updateMany: vi.fn(async (_args: { data: object }) => ({ count: held })) },
    customer: {
      findUnique: vi.fn(async (): Promise<object | null> => null), create: vi.fn(async () => ({ id: 'c-1' })), update: vi.fn(async () => ({})),
    },
    booking: { create: vi.fn(async (_args: { data: Record<string, unknown> }) => ({})) },
  };
  const prisma = {
    ground: { findFirst: vi.fn(async () => ground) },
    slot: { findUnique: vi.fn(async () => slot) },
    booking: {
      update: vi.fn(async () => ({})), findFirst: vi.fn(async () => existing), findUnique: vi.fn(async () => existing),
      count: vi.fn(async () => openUnpaid),
    },
    $transaction: vi.fn(async (fn: (t: typeof tx) => unknown) => fn(tx)),
  };
  const stripe = {
    createCheckoutSession: vi.fn(async (_args: object) => ({ id: 'cs_1', url: 'https://stripe.test/cs_1' })),
    openSessionUrl: vi.fn(async () => 'https://stripe.test/open'),
  };
  const cancellation = { cancel: vi.fn(async () => undefined) };
  const settings = { get: vi.fn(async () => ({ ...DEFAULT_SLOT_SETTINGS, portalCashEnabled: cash, bkashNumber, ...switches })) };
  const notifier = { received: vi.fn(async () => true), newBookingToAdmins: vi.fn(async () => undefined) };
  const service = new CheckoutService(
    prisma as unknown as PrismaService, stripe as unknown as StripeService,
    settings as unknown as SlotSettingsService, cancellation as unknown as BookingCancellationService,
    notifier as unknown as BookingNotifier,
  );
  return { service, tx, stripe, cancellation, notifier };
}

beforeEach(() => vi.useFakeTimers({ now: NOW, toFake: ['Date'] }));
afterEach(() => vi.useRealTimers());

describe('CheckoutService', () => {
  describe.each([
    ['the Stripe key', 'STRIPE_SECRET_KEY'],
    ['the webhook secret', 'STRIPE_WEBHOOK_SECRET'],
  ] as const)('without %s', (_name, key) => {
    const value = env[key];
    beforeEach(() => { env[key] = undefined; });
    afterEach(() => { env[key] = value; });

    it('offers no card and refuses a card checkout before touching the slot', async () => {
      const { service, tx, stripe } = setup();
      await expect(service.options()).resolves.toMatchObject({ cardEnabled: false, cashEnabled: true });
      await expect(service.start(input)).rejects.toMatchObject({ status: 400, code: 'CARD_NOT_AVAILABLE' });
      expect(tx.slot.updateMany).not.toHaveBeenCalled();
      expect(stripe.createCheckoutSession).not.toHaveBeenCalled();
    });

    it('refuses "Pay now" and "Complete payment" before reading the booking', async () => {
      const { service, stripe } = setup({ existing: { id: 'b-1' } });
      await expect(service.payDue('b-1', bookingToken('b-1'))).rejects.toMatchObject({ status: 400, code: 'CARD_NOT_AVAILABLE' });
      await expect(service.resume('b-1', bookingToken('b-1'))).rejects.toMatchObject({ status: 400, code: 'CARD_NOT_AVAILABLE' });
      expect(stripe.createCheckoutSession).not.toHaveBeenCalled();
    });

    it('still takes pay-at-venue bookings', async () => {
      const { service, tx } = setup();
      await service.start({ ...input, paymentMethod: 'cash' }, SIGNED_IN);
      expect(tx.booking.create).toHaveBeenCalled();
    });
  });

  it('holds the slot for holdMinutes, adds the service fee and opens a Stripe session', async () => {
    const { service, tx, stripe } = setup();
    const result = await service.start(input);

    expect(result.checkoutUrl).toBe('https://stripe.test/cs_1');
    const hold = tx.slot.updateMany.mock.calls[0]![0];
    expect(hold).toMatchObject({ where: { id: 's-1', status: 'available' }, data: { status: 'held', heldByBookingId: result.bookingId } });
    expect((hold.data as { heldUntil: Date }).heldUntil).toEqual(new Date(NOW.getTime() + 15 * 60_000));
    expect(tx.booking.create.mock.calls[0]![0].data).toMatchObject({ source: 'portal', amount: 1500, serviceFee: 5000, total: 6500, liveSlotId: 's-1' });
    expect(stripe.createCheckoutSession).toHaveBeenCalledWith(expect.objectContaining({ total: 6500, bookingId: result.bookingId }));
  });

  it.each([
    ['a hidden ground', { ground: null }, 'GROUND_NOT_FOUND'],
    ['a missing slot', { slot: null }, 'SLOT_NOT_AVAILABLE'],
    ['a blocked slot', { slot: slotRow({ status: 'blocked' }) }, 'SLOT_NOT_AVAILABLE'],
    ['a slot taken a moment ago', { held: 0 }, 'SLOT_NOT_AVAILABLE'],
    ['a slot inside the cutoff', { slot: slotRow({ startHour: 11 }) }, 'OUTSIDE_BOOKING_WINDOW'],
    ['a started slot', { slot: slotRow({ startHour: 9 }) }, 'SLOT_IN_PAST'],
    ['a free slot on a day the ground is closed', { ground: { id: 'g-1', name: 'Arena', availableDays: 'weekends', customDays: [] } }, 'GROUND_CLOSED'],
  ])('refuses %s', async (_label, options, code) => {
    const date = 'slot' in options && options.slot && (options.slot as { startHour: number }).startHour < 18 ? '2026-10-28' : input.date;
    await expect(setup(options as never).service.start({ ...input, date })).rejects.toMatchObject({ code });
  });

  it('checks the start and the cutoff to the minute for a :30 slot', async () => {
    // 10:00 now, cutoff 2 hours. Read as whole hours, 10:30 would have started and 12:30 would be inside the cutoff.
    const today = { ...input, date: '2026-10-28', startMinute: 30 as const };
    await expect(setup({ slot: slotRow({ startHour: 9, startMinute: 30 }) }).service.start({ ...today, startHour: 9 }))
      .rejects.toMatchObject({ code: 'SLOT_IN_PAST' });
    await expect(setup({ slot: slotRow({ startHour: 10, startMinute: 30 }) }).service.start({ ...today, startHour: 10 }))
      .rejects.toMatchObject({ code: 'OUTSIDE_BOOKING_WINDOW' });
    const { service, stripe } = setup({ slot: slotRow({ startHour: 12, startMinute: 30, durationMinutes: 90 }) });
    await expect(service.start({ ...today, startHour: 12 })).resolves.toMatchObject({ paymentMethod: 'card' });
    expect(stripe.createCheckoutSession).toHaveBeenCalledWith(expect.objectContaining({ description: 'Arena, 2026-10-28 12:30' }));
  });

  it.each(['card', 'cash'] as const)('takes nothing for a %s checkout on a closed day', async (paymentMethod) => {
    const { service, tx, stripe } = setup({ ground: { id: 'g-1', name: 'Arena', availableDays: 'custom', customDays: ['fri'] } });
    await expect(service.start({ ...input, paymentMethod }, SIGNED_IN)).rejects.toMatchObject({ status: 400, code: 'GROUND_CLOSED' });
    expect(tx.slot.updateMany).not.toHaveBeenCalled();
    expect(stripe.createCheckoutSession).not.toHaveBeenCalled();
  });

  it('books a signed-in customer on their verified phone, not the one typed in', async () => {
    const { service, tx } = setup();
    await service.start({ ...input, customerPhone: '+8801700000000' }, '+8801711999999');

    expect(tx.customer.create).toHaveBeenCalledWith({ data: expect.objectContaining({ phone: '+8801711999999', name: 'Rakib' }) });
    expect(tx.booking.create.mock.calls[0]![0].data).toMatchObject({ contactPhone: '+8801711999999' });
  });

  it('a guest card checkout without an email is 400 EMAIL_REQUIRED, before touching the slot', async () => {
    const { service, tx } = setup();
    await expect(service.start({ ...input, customerEmail: null })).rejects.toMatchObject({ status: 400, code: 'EMAIL_REQUIRED' });
    expect(tx.slot.updateMany).not.toHaveBeenCalled();
  });

  it('signed in without an email: keeps and uses the stored one, else books with none', async () => {
    const { service, tx, stripe } = setup();
    tx.customer.findUnique.mockResolvedValue({ id: 'c-9', email: 'stored@x.test', deletedAt: null });
    await service.start({ ...input, customerEmail: null }, SIGNED_IN);
    expect(tx.customer.update).toHaveBeenCalledWith({ where: { id: 'c-9' }, data: { name: 'Rakib', deletedAt: null } });
    expect(tx.booking.create.mock.calls[0]![0].data).toMatchObject({ customerId: 'c-9', contactEmail: 'stored@x.test' });
    expect(stripe.createCheckoutSession).toHaveBeenCalledWith(expect.objectContaining({ customerEmail: null }));

    const fresh = setup();
    await fresh.service.start({ ...input, customerEmail: undefined, paymentMethod: 'cash' }, SIGNED_IN);
    expect(fresh.tx.customer.create).toHaveBeenCalledWith({ data: expect.objectContaining({ email: null }) });
    expect(fresh.tx.booking.create.mock.calls[0]![0].data).toMatchObject({ contactEmail: null });
  });

  it('refuses dates past the booking window', async () => {
    await expect(setup().service.start({ ...input, date: '2026-12-31' })).rejects.toMatchObject({ code: 'OUTSIDE_BOOKING_WINDOW' });
  });

  it('books the slot for pay-at-venue without Stripe, pending until staff confirm', async () => {
    const { service, tx, stripe, notifier } = setup();
    const result = await service.start({ ...input, paymentMethod: 'cash' }, SIGNED_IN);

    expect(result).toMatchObject({ paymentMethod: 'cash', checkoutUrl: null, confirmationUrl: expect.stringContaining(`/confirmation/${result.bookingId}?token=`) });
    expect(tx.slot.updateMany.mock.calls[0]![0].data).toEqual({ status: 'booked' });
    expect(tx.booking.create.mock.calls[0]![0].data).toMatchObject({ payAtVenue: true, total: 6500 });
    expect(stripe.createCheckoutSession).not.toHaveBeenCalled();
    expect(notifier.received).toHaveBeenCalledWith(result.bookingId);
  });

  it('refuses pay-at-venue when the setting is off', async () => {
    const { service, tx } = setup({ cash: false });
    await expect(service.start({ ...input, paymentMethod: 'cash' }, SIGNED_IN)).rejects.toMatchObject({ status: 400, code: 'CASH_NOT_AVAILABLE' });
    expect(tx.slot.updateMany).not.toHaveBeenCalled();
  });

  it.each(['cash', 'bkash'] as const)('refuses a guest %s checkout before touching the slot', async (paymentMethod) => {
    const { service, tx } = setup({ bkashNumber: '+8801700000000' });
    const body = paymentMethod === 'cash' ? { ...input, paymentMethod } : { ...input, paymentMethod, reference: 'ABC123XYZ', payerNumber: '+8801811000000' };
    await expect(service.start(body)).rejects.toMatchObject({ status: 401, code: 'SIGN_IN_REQUIRED' });
    expect(tx.slot.updateMany).not.toHaveBeenCalled();
  });

  it('refuses a 4th open unpaid booking on the phone, before touching the slot; card is not capped', async () => {
    const { service, tx } = setup({ openUnpaid: 3 });
    await expect(service.start({ ...input, paymentMethod: 'cash' }, SIGNED_IN)).rejects.toMatchObject({ status: 409, code: 'TOO_MANY_OPEN_BOOKINGS' });
    expect(tx.slot.updateMany).not.toHaveBeenCalled();
    await expect(service.start(input, SIGNED_IN)).resolves.toMatchObject({ paymentMethod: 'card' });
  });

  it('tells the portal which payment methods are offered and the fee', async () => {
    await expect(setup({ cash: false }).service.options()).resolves.toEqual({ cardEnabled: true, cashEnabled: false, wallets: [], serviceFee: 5000, currency: 'bdt', holdMinutes: 15 });
  });

  describe('card switched off by the admin (Stripe keys set)', () => {
    const off = { switches: { portalCardEnabled: false } };

    it('offers no card and refuses a card checkout before touching the slot', async () => {
      const { service, tx, stripe } = setup(off);
      await expect(service.options()).resolves.toMatchObject({ cardEnabled: false, cashEnabled: true });
      await expect(service.start(input)).rejects.toMatchObject({ status: 400, code: 'CARD_NOT_AVAILABLE' });
      expect(tx.slot.updateMany).not.toHaveBeenCalled();
      expect(stripe.createCheckoutSession).not.toHaveBeenCalled();
    });

    it('refuses "Pay now", but a checkout already under way can still finish', async () => {
      const { service } = setup({ ...off, existing: { id: 'b-1', status: 'pending', stripeCheckoutSessionId: 'cs_1' } });
      await expect(service.payDue('b-1', bookingToken('b-1'))).rejects.toMatchObject({ status: 400, code: 'CARD_NOT_AVAILABLE' });
      await expect(service.resume('b-1', bookingToken('b-1'))).resolves.toMatchObject({ checkoutUrl: 'https://stripe.test/open' });
    });
  });

  describe('bKash / Nagad', () => {
    const bkash = { ...input, paymentMethod: 'bkash' as const, reference: 'ABC123XYZ', payerNumber: '+8801811000000' };

    it('switched off: not listed and refused before touching the slot, though the number is kept', async () => {
      const { service, tx } = setup({ bkashNumber: '+8801700000000', switches: { portalBkashEnabled: false } });
      await expect(service.options()).resolves.toMatchObject({ wallets: [] });
      await expect(service.start(bkash, SIGNED_IN)).rejects.toMatchObject({ status: 400, code: 'WALLET_NOT_AVAILABLE' });
      expect(tx.slot.updateMany).not.toHaveBeenCalled();
    });

    it('Nagad off leaves bKash on', async () => {
      const { service } = setup({ bkashNumber: '+8801700000000', switches: { nagadNumber: '+8801900000000', portalNagadEnabled: false } });
      await expect(service.options()).resolves.toMatchObject({ wallets: [{ method: 'bkash', number: '+8801700000000' }] });
    });

    it('lists only the wallets with a number set', async () => {
      await expect(setup({ bkashNumber: '+8801700000000' }).service.options())
        .resolves.toMatchObject({ wallets: [{ method: 'bkash', number: '+8801700000000' }] });
    });

    it('books the slot with a pending payment for the total, holding the TrxID and sender', async () => {
      const { service, tx, stripe, notifier } = setup({ bkashNumber: '+8801700000000' });
      const result = await service.start(bkash, SIGNED_IN);
      expect(result).toMatchObject({ paymentMethod: 'bkash', checkoutUrl: null, confirmationUrl: expect.stringContaining('/confirmation/') });
      expect(tx.slot.updateMany.mock.calls[0]![0].data).toEqual({ status: 'booked' });
      const data = tx.booking.create.mock.calls[0]![0].data;
      expect(data).toMatchObject({ source: 'portal', payAtVenue: false, total: 6500, serviceFee: 5000 });
      expect(data.payments).toEqual({
        create: { method: 'bkash', amount: 6500, currency: 'bdt', status: 'pending', reference: 'ABC123XYZ', payerNumber: '+8801811000000' },
      });
      expect(stripe.createCheckoutSession).not.toHaveBeenCalled();
      expect(notifier.received).toHaveBeenCalledWith(result.bookingId);
    });

    it('validates the TrxID and sender: required, trimmed, uppercased, 6–20 letters and digits', () => {
      const body = { ...bkash, groundId: '6f1c2a8e-0b7d-4c3e-9a51-2d4f8e6b7c10', hour: 18, customerPhone: '01711000000' };
      expect(CheckoutSchema.parse({ ...body, reference: '  abc123xyz ', payerNumber: '01811000000' }))
        .toMatchObject({ reference: 'ABC123XYZ', payerNumber: '+8801811000000' });
      for (const reference of ['ABC12', 'ABC-123-XYZ', 'A'.repeat(21)]) {
        expect(CheckoutSchema.safeParse({ ...body, reference }).success).toBe(false);
      }
      for (const paymentMethod of ['card', 'cash']) {
        const dropped = CheckoutSchema.safeParse({ ...body, paymentMethod, reference: 'ABC123XYZ', payerNumber: '01811000000' });
        expect(dropped.error?.issues.map((i) => i.path.join('.')).sort()).toEqual(['payerNumber', 'reference']);
      }
      const missing = CheckoutSchema.safeParse({ ...body, reference: undefined, payerNumber: undefined });
      expect(missing.error?.issues.map((i) => i.path.join('.')).sort()).toEqual(['payerNumber', 'reference']);
    });

    it('refuses a wallet whose number is not set, before touching the slot', async () => {
      const { service, tx } = setup();
      await expect(service.start({ ...bkash, paymentMethod: 'nagad' }, SIGNED_IN)).rejects.toMatchObject({ status: 400, code: 'WALLET_NOT_AVAILABLE' });
      expect(tx.slot.updateMany).not.toHaveBeenCalled();
    });

    it('a duplicate TrxID is 409 REFERENCE_ALREADY_USED', async () => {
      const { service, tx } = setup({ bkashNumber: '+8801700000000' });
      const clash = Object.assign(new Error('unique'), {
        code: 'P2002', meta: { driverAdapterError: { cause: { constraint: { index: 'Payment_method_reference_key' } } } },
      });
      tx.booking.create.mockRejectedValueOnce(clash);
      await expect(service.start(bkash, SIGNED_IN)).rejects.toMatchObject({ status: 409, code: 'REFERENCE_ALREADY_USED' });
    });
  });

  describe('Pay now', () => {
    const owed = (overrides: object = {}) => ({
      id: 'b-1', bookingNumber: 'CT-AAAAA', source: 'portal', payAtVenue: true, status: 'pending', total: 6500,
      contactEmail: 'r@x.test', ground: { name: 'Arena' }, payments: [], ...overrides,
    });

    it('opens a Stripe session for what is still due', async () => {
      const { service, stripe } = setup({ existing: owed({ source: 'staff', payAtVenue: false, status: 'confirmed', payments: [{ amount: 2500, status: 'succeeded' }] }) });
      const result = await service.payDue('b-1', bookingToken('b-1'));
      expect(result).toMatchObject({ checkoutUrl: 'https://stripe.test/cs_1', amount: 4000 });
      expect(stripe.createCheckoutSession).toHaveBeenCalledWith(expect.objectContaining({ purpose: 'due', total: 4000 }));
    });

    it('hands back the open checkout for a card booking still in progress', async () => {
      const { service, stripe } = setup({ existing: owed({ payAtVenue: false, stripeCheckoutSessionId: 'cs_0' }) });
      await expect(service.payDue('b-1', bookingToken('b-1'))).resolves.toMatchObject({ checkoutUrl: 'https://stripe.test/open' });
      expect(stripe.createCheckoutSession).not.toHaveBeenCalled();
    });

    it.each([
      ['paid in full', owed({ payments: [{ amount: 6500, status: 'succeeded' }] })],
      ['cancelled', owed({ status: 'cancelled' })],
    ])('refuses when the booking is %s', async (_label, existing) => {
      await expect(setup({ existing }).service.payDue('b-1', bookingToken('b-1'))).rejects.toMatchObject({ status: 409, code: 'NOTHING_DUE' });
    });

    it('refuses while a bKash / Nagad payment is being verified', async () => {
      const existing = owed({ payAtVenue: false, payments: [{ amount: 6500, status: 'pending', method: 'bkash' }] });
      const { service, stripe } = setup({ existing });
      await expect(service.payDue('b-1', bookingToken('b-1'))).rejects.toMatchObject({ status: 409, code: 'PAYMENT_UNDER_REVIEW' });
      expect(stripe.createCheckoutSession).not.toHaveBeenCalled();
    });

    it('404s without a valid token', async () => {
      await expect(setup({ existing: owed() }).service.payDue('b-1', 'nope')).rejects.toMatchObject({ status: 404 });
    });
  });

  it('gives the slot back if Stripe fails', async () => {
    const { service, stripe, cancellation } = setup();
    stripe.createCheckoutSession.mockRejectedValueOnce(new Error('down'));
    await expect(service.start(input)).rejects.toThrow('down');
    expect(cancellation.cancel).toHaveBeenCalledWith(expect.any(String), expect.objectContaining({ refund: false, notify: false }));
  });
});
