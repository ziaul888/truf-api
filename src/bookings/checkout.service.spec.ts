import type { PrismaService } from '../prisma/prisma.service.js';
import type { StripeService } from '../payments/stripe.service.js';
import { DEFAULT_SLOT_SETTINGS, type SlotSettingsService } from '../slots/slot-settings.service.js';
import type { BookingCancellationService } from './booking-cancellation.service.js';
import type { BookingNotifier } from './booking-notifier.service.js';
import { bookingToken } from './booking-rules.js';
import { CheckoutService } from './checkout.service.js';

// 04:00 UTC = 10:00 in Dhaka, Wed 28 Oct 2026.
const NOW = new Date('2026-10-28T04:00:00Z');

const slotRow = (overrides: object = {}) => ({ id: 's-1', groundId: 'g-1', startHour: 18, price: 1500, status: 'available', ...overrides });
const input = {
  groundId: 'g-1', date: '2026-10-29', startHour: 18, customerName: 'Rakib', customerEmail: 'r@x.test', customerPhone: '+8801711000000',
  paymentMethod: 'card' as 'card' | 'cash',
};

function setup({ slot = slotRow() as object | null, ground = { id: 'g-1', name: 'Arena' } as object | null, held = 1, cash = true, existing = null as object | null } = {}) {
  const tx = {
    slot: { updateMany: vi.fn(async (_args: { data: object }) => ({ count: held })) },
    customer: { findUnique: vi.fn(async () => null), create: vi.fn(async () => ({ id: 'c-1' })) },
    booking: { create: vi.fn(async (_args: { data: Record<string, unknown> }) => ({})) },
  };
  const prisma = {
    ground: { findFirst: vi.fn(async () => ground) },
    slot: { findUnique: vi.fn(async () => slot) },
    booking: { update: vi.fn(async () => ({})), findFirst: vi.fn(async () => existing), findUnique: vi.fn(async () => existing) },
    $transaction: vi.fn(async (fn: (t: typeof tx) => unknown) => fn(tx)),
  };
  const stripe = {
    createCheckoutSession: vi.fn(async (_args: object) => ({ id: 'cs_1', url: 'https://stripe.test/cs_1' })),
    openSessionUrl: vi.fn(async () => 'https://stripe.test/open'),
  };
  const cancellation = { cancel: vi.fn(async () => undefined) };
  const settings = { get: vi.fn(async () => ({ ...DEFAULT_SLOT_SETTINGS, portalCashEnabled: cash })) };
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
  ])('refuses %s', async (_label, options, code) => {
    const date = 'slot' in options && options.slot && (options.slot as { startHour: number }).startHour < 18 ? '2026-10-28' : input.date;
    await expect(setup(options as never).service.start({ ...input, date })).rejects.toMatchObject({ code });
  });

  it('books a signed-in customer on their verified phone, not the one typed in', async () => {
    const { service, tx } = setup();
    await service.start({ ...input, customerPhone: '+8801700000000' }, '+8801711999999');

    expect(tx.customer.create).toHaveBeenCalledWith({ data: expect.objectContaining({ phone: '+8801711999999', name: 'Rakib' }) });
    expect(tx.booking.create.mock.calls[0]![0].data).toMatchObject({ contactPhone: '+8801711999999' });
  });

  it('refuses dates past the booking window', async () => {
    await expect(setup().service.start({ ...input, date: '2026-12-31' })).rejects.toMatchObject({ code: 'OUTSIDE_BOOKING_WINDOW' });
  });

  it('books the slot for pay-at-venue without Stripe, pending until staff confirm', async () => {
    const { service, tx, stripe, notifier } = setup();
    const result = await service.start({ ...input, paymentMethod: 'cash' });

    expect(result).toMatchObject({ paymentMethod: 'cash', checkoutUrl: null, confirmationUrl: expect.stringContaining(`/confirmation/${result.bookingId}?token=`) });
    expect(tx.slot.updateMany.mock.calls[0]![0].data).toEqual({ status: 'booked' });
    expect(tx.booking.create.mock.calls[0]![0].data).toMatchObject({ payAtVenue: true, total: 6500 });
    expect(stripe.createCheckoutSession).not.toHaveBeenCalled();
    expect(notifier.received).toHaveBeenCalledWith(result.bookingId);
  });

  it('refuses pay-at-venue when the setting is off', async () => {
    const { service, tx } = setup({ cash: false });
    await expect(service.start({ ...input, paymentMethod: 'cash' })).rejects.toMatchObject({ status: 400, code: 'CASH_NOT_AVAILABLE' });
    expect(tx.slot.updateMany).not.toHaveBeenCalled();
  });

  it('tells the portal whether cash is offered and the fee', async () => {
    await expect(setup({ cash: false }).service.options()).resolves.toEqual({ cashEnabled: false, serviceFee: 5000, currency: 'bdt', holdMinutes: 15 });
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
