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

const slotRow = (overrides: object = {}) => ({
  id: 's-1', groundId: 'g-1', date: new Date('2026-10-29T00:00:00Z'), startHour: 18, startMinute: 0, durationMinutes: 60, price: 1500, status: 'available', ...overrides,
});
const input = {
  groundId: 'g-1', date: '2026-10-29', startHour: 18, startMinute: 0 as 0 | 30, customerName: 'Rakib', customerEmail: 'r@x.test', customerPhone: '+8801711000000',
  paymentMethod: 'card' as 'card' | 'cash' | 'bkash' | 'nagad',
};
/** Cash, bKash and Nagad need a signed-in customer: their verified phone. */
const SIGNED_IN = input.customerPhone;

function setup({
  slot = slotRow() as object | null, slots = null as object[] | null, ground = { id: 'g-1', name: 'Arena', availableDays: 'everyday', customDays: [] } as object | null,
  held = 1, cash = true, existing = null as object | null, bkashNumber = null as string | null, openUnpaid = 0, switches = {},
} = {}) {
  const tx = {
    slot: { updateMany: vi.fn(async (_args: { data: object }) => ({ count: held })) },
    customer: {
      findUnique: vi.fn(async (): Promise<object | null> => null), create: vi.fn(async () => ({ id: 'c-1' })), update: vi.fn(async () => ({})),
    },
    booking: { create: vi.fn(async (_args: { data: Record<string, unknown> }) => ({})) },
    bookingSlot: { updateMany: vi.fn(async (_args: { where: object; data: object }) => ({ count: 0 })) },
  };
  const prisma = {
    ground: { findFirst: vi.fn(async () => ground) },
    slot: { findMany: vi.fn(async (_args: object) => slots ?? (slot ? [slot] : [])) },
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
  return { service, tx, stripe, cancellation, notifier, prisma };
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
    expect(hold).toMatchObject({ where: { id: { in: ['s-1'] }, status: 'available' }, data: { status: 'held', heldByBookingId: result.bookingId } });
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
    expect(stripe.createCheckoutSession).toHaveBeenCalledWith(expect.objectContaining({ description: 'Arena, 2026-10-28 12:30–14:00' }));
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
    await expect(setup({ cash: false }).service.options()).resolves.toEqual({
      cardEnabled: true, cashEnabled: false, wallets: [], serviceFee: 5000, currency: 'bdt', holdMinutes: 15, maxSlotsPerBooking: 4,
    });
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

  describe('several slots in one booking', () => {
    const at = (startHour: number, price = 1500) => slotRow({ id: `s-${startHour}`, startHour, price });
    const { startHour: _single, ...multi } = input;
    const two = { ...multi, slots: [{ startHour: 19, startMinute: 0 as const }, { startHour: 18, startMinute: 0 as const }] };
    const four = { ...multi, slots: [18, 19, 20, 21].map((startHour) => ({ startHour, startMinute: 0 as const })) };

    it('holds all of them with ONE conditional update, charges the fee once and sends the combined total to Stripe', async () => {
      const { service, tx, stripe } = setup({ slots: [at(19, 1500), at(18, 1000)], held: 2 });
      const result = await service.start(two);

      expect(tx.slot.updateMany).toHaveBeenCalledTimes(1);
      const hold = tx.slot.updateMany.mock.calls[0]![0];
      expect(hold).toMatchObject({
        where: { id: { in: ['s-18', 's-19'] }, status: 'available' }, data: { status: 'held', heldByBookingId: result.bookingId },
      });
      const data = tx.booking.create.mock.calls[0]![0].data;
      expect(data).toMatchObject({ slotId: 's-18', liveSlotId: 's-18', amount: 2500, serviceFee: 5000, total: 7500 });
      expect(data.bookingSlots).toEqual({
        create: [{ slotId: 's-18', liveSlotId: 's-18', price: 1000 }, { slotId: 's-19', liveSlotId: 's-19', price: 1500 }],
      });
      expect(stripe.createCheckoutSession).toHaveBeenCalledWith(expect.objectContaining({ total: 7500, description: 'Arena, 2026-10-29 18:00–20:00' }));
    });

    it('books four slots at once for cash, with one wallet-sized payment for wallets', async () => {
      const slots = [18, 19, 20, 21].map((h) => at(h));
      const cash = setup({ slots, held: 4 });
      await cash.service.start({ ...four, paymentMethod: 'cash' }, SIGNED_IN);
      expect(cash.tx.slot.updateMany.mock.calls[0]![0]).toMatchObject({ where: { id: { in: ['s-18', 's-19', 's-20', 's-21'] } }, data: { status: 'booked' } });
      expect(cash.tx.booking.create.mock.calls[0]![0].data).toMatchObject({ amount: 6000, total: 11000, payAtVenue: true });

      const wallet = setup({ slots, held: 4, bkashNumber: '+8801700000000' });
      await wallet.service.start({ ...four, paymentMethod: 'bkash', reference: 'ABC123XYZ', payerNumber: '+8801811000000' }, SIGNED_IN);
      expect(wallet.tx.booking.create.mock.calls[0]![0].data.payments).toMatchObject({ create: { amount: 11000, status: 'pending' } });
    });

    it('first frees stale live BookingSlot rows of cancelled bookings (left by an older release) on these slots', async () => {
      const { service, tx } = setup({ slots: [at(18), at(19)], held: 2 });
      await service.start(two);
      expect(tx.bookingSlot.updateMany).toHaveBeenCalledWith({
        where: { slotId: { in: ['s-18', 's-19'] }, liveSlotId: { not: null }, booking: { status: 'cancelled' } },
        data: { liveSlotId: null, cancelledAt: expect.any(Date) },
      });
      expect(tx.bookingSlot.updateMany.mock.invocationCallOrder[0]!).toBeLessThan(tx.booking.create.mock.invocationCallOrder[0]!);
    });

    it('refuses more than 4 slots before reading any', async () => {
      const { service, prisma, tx } = setup();
      const five = { ...multi, slots: [17, 18, 19, 20, 21].map((startHour) => ({ startHour, startMinute: 0 as const })) };
      await expect(service.start(five)).rejects.toMatchObject({ status: 400, code: 'TOO_MANY_SLOTS' });
      expect(prisma.slot.findMany).not.toHaveBeenCalled();
      expect(tx.slot.updateMany).not.toHaveBeenCalled();
    });

    it('is SLOT_NOT_AVAILABLE, claiming nothing, when one of the slots does not exist', async () => {
      const { service, tx } = setup({ slots: [at(18)] });
      await expect(service.start(two)).rejects.toMatchObject({ status: 409, code: 'SLOT_NOT_AVAILABLE' });
      expect(tx.slot.updateMany).not.toHaveBeenCalled();
      expect(tx.booking.create).not.toHaveBeenCalled();
    });

    it('is SLOT_NOT_AVAILABLE and creates no booking when only some were claimed (the transaction rolls back)', async () => {
      const { service, tx, stripe } = setup({ slots: [at(18), at(19)], held: 1 });
      await expect(service.start(two)).rejects.toMatchObject({ status: 409, code: 'SLOT_NOT_AVAILABLE' });
      expect(tx.booking.create).not.toHaveBeenCalled();
      expect(stripe.createCheckoutSession).not.toHaveBeenCalled();
    });

    it('maps a clash on a BookingSlot live index to SLOT_NOT_AVAILABLE', async () => {
      const { service, tx } = setup({ slots: [at(18), at(19)], held: 2 });
      tx.booking.create.mockRejectedValueOnce(Object.assign(new Error('unique'), {
        code: 'P2002', meta: { driverAdapterError: { cause: { constraint: { index: 'BookingSlot_liveSlotId_key' } } } },
      }));
      await expect(service.start(two)).rejects.toMatchObject({ status: 409, code: 'SLOT_NOT_AVAILABLE' });
    });

    it('refuses if any one slot is blocked or inside the cutoff', async () => {
      await expect(setup({ slots: [at(18), slotRow({ id: 's-19', startHour: 19, status: 'blocked' })] }).service.start(two))
        .rejects.toMatchObject({ code: 'SLOT_NOT_AVAILABLE' });
      const today = { ...two, date: '2026-10-28', slots: [{ startHour: 11, startMinute: 0 as const }, { startHour: 18, startMinute: 0 as const }] };
      await expect(setup({ slots: [at(11), at(18)] }).service.start(today)).rejects.toMatchObject({ code: 'OUTSIDE_BOOKING_WINDOW' });
    });

    it('gives every slot back if Stripe fails (the cancellation releases the whole booking)', async () => {
      const { service, stripe, cancellation } = setup({ slots: [at(18), at(19)], held: 2 });
      stripe.createCheckoutSession.mockRejectedValueOnce(new Error('down'));
      await expect(service.start(two)).rejects.toThrow('down');
      expect(cancellation.cancel).toHaveBeenCalledTimes(1);
    });
  });

  it('gives the slot back if Stripe fails', async () => {
    const { service, stripe, cancellation } = setup();
    stripe.createCheckoutSession.mockRejectedValueOnce(new Error('down'));
    await expect(service.start(input)).rejects.toThrow('down');
    expect(cancellation.cancel).toHaveBeenCalledWith(expect.any(String), expect.objectContaining({ refund: false, notify: false }));
  });
});
