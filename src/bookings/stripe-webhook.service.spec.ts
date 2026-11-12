import type { PrismaService } from '../prisma/prisma.service.js';
import type { StripeService } from '../payments/stripe.service.js';
import type { BookingCancellationService } from './booking-cancellation.service.js';
import type { BookingNotifier } from './booking-notifier.service.js';
import type { SystemStateService } from '../settings/system-state.service.js';
import { StripeWebhookService } from './stripe-webhook.service.js';

function setup({
  existingPayment = null as object | null, booking = { id: 'b-1', status: 'pending', slotId: 's-1', total: 6000, payments: [] } as object | null,
  rows = [] as { id: string; slotId: string }[], booked = 1,
} = {}) {
  const tx = {
    slot: { updateMany: vi.fn(async (_args: { where: object }) => ({ count: booked })) },
    bookingSlot: { update: vi.fn(async (_args: { where: object; data: object }) => ({})), updateMany: vi.fn(async (_args: { where: object; data: object }) => ({ count: 1 })) },
    payment: { create: vi.fn(async (_args: { data: object }) => ({})) },
    booking: { update: vi.fn(async (_args: { data: object }) => ({})) },
    bookingEvent: { createMany: vi.fn(async (_args: { data: { type: string }[] }) => ({})) },
  };
  const prisma = {
    payment: { findUnique: vi.fn(async () => existingPayment), create: vi.fn((args: object) => args) },
    booking: { findUnique: vi.fn(async () => booking), updateMany: vi.fn(async (_args: object) => ({ count: 1 })) },
    bookingSlot: { findMany: vi.fn(async () => rows) },
    bookingEvent: { createMany: vi.fn((args: object) => args) },
    $transaction: vi.fn(async (arg: unknown) => (typeof arg === 'function' ? arg(tx) : arg)),
  };
  const stripe = { parseWebhook: vi.fn(), cardLast4: vi.fn(async () => '4242'), refund: vi.fn(async (id: string) => `re_${id}`) };
  const notifier = { confirmed: vi.fn(), newBookingToAdmins: vi.fn(), paymentRefunded: vi.fn(), cancelled: vi.fn() };
  const cancellation = { cancel: vi.fn(async () => undefined) };
  const service = new StripeWebhookService(
    prisma as unknown as PrismaService, stripe as unknown as StripeService,
    cancellation as unknown as BookingCancellationService, notifier as unknown as BookingNotifier,
    { set: vi.fn(async () => undefined) } as unknown as SystemStateService,
  );
  const send = (event: object) => {
    stripe.parseWebhook.mockReturnValueOnce(event);
    return service.handle(Buffer.from('{}'), 'sig');
  };
  return { send, prisma, cancellation, tx, stripe, notifier };
}

const paid = { type: 'checkout.session.completed', data: { object: { metadata: { bookingId: 'b-1' }, payment_intent: 'pi_1', payment_status: 'paid' } } };

describe('StripeWebhookService', () => {
  it('ignores a payment it has already recorded (Stripe retries)', async () => {
    const { send, prisma } = setup({ existingPayment: { id: 'p-1' } });
    await expect(send(paid)).resolves.toEqual({ received: true });
    expect(prisma.$transaction).not.toHaveBeenCalled();
  });

  it('ignores sessions that are not paid yet', async () => {
    const { send, prisma } = setup();
    await send({ ...paid, data: { object: { ...paid.data.object, payment_status: 'unpaid' } } });
    expect(prisma.payment.findUnique).not.toHaveBeenCalled();
  });

  it('cancels the pending booking when its session expires, without a refund', async () => {
    const { send, cancellation } = setup();
    await send({ type: 'checkout.session.expired', data: { object: { metadata: { bookingId: 'b-1' } } } });
    expect(cancellation.cancel).toHaveBeenCalledWith('b-1', expect.objectContaining({ refund: false, notify: false }));
  });

  it('leaves non-pending bookings alone when a session expires', async () => {
    const { send, cancellation } = setup({ booking: { id: 'b-1', status: 'confirmed' } });
    await send({ type: 'checkout.session.expired', data: { object: { metadata: { bookingId: 'b-1' } } } });
    expect(cancellation.cancel).not.toHaveBeenCalled();
  });

  it('marks a failed payment but keeps the hold, so the customer can retry', async () => {
    const { send, prisma } = setup();
    await send({ type: 'payment_intent.payment_failed', data: { object: { metadata: { bookingId: 'b-1' } } } });
    expect(prisma.booking.updateMany).toHaveBeenCalledWith({ where: { id: 'b-1', status: 'pending' }, data: { paymentStatus: 'failed' } });
  });

  it('confirms a late payment on a day the ground has since closed, with no automatic refund', async () => {
    // Deliberately no ground in the mocks: confirming an existing booking must not depend on the ground's days.
    const { send, tx, stripe, cancellation, notifier } = setup({ booking: { id: 'b-1', status: 'cancelled', slotId: 's-1', total: 6000, payments: [] } });
    await send(paid);

    expect(tx.slot.updateMany.mock.calls[0]![0].where).toEqual({ id: { in: ['s-1'] }, OR: [{ status: 'held', heldByBookingId: 'b-1' }, { status: 'available' }] });
    expect(tx.payment.create).toHaveBeenCalledWith({ data: expect.objectContaining({ status: 'succeeded', stripePaymentIntentId: 'pi_1' }) });
    expect(tx.booking.update.mock.calls[0]![0].data).toMatchObject({ status: 'confirmed', paymentStatus: 'paid', liveSlotId: 's-1' });
    expect(stripe.refund).not.toHaveBeenCalled();
    expect(cancellation.cancel).not.toHaveBeenCalled();
    expect(notifier.confirmed).toHaveBeenCalledWith('b-1');
  });

  describe('a booking with several slots', () => {
    const rows = [{ id: 'bs-1', slotId: 's-1' }, { id: 'bs-2', slotId: 's-2' }];
    const multi = { id: 'b-1', status: 'pending', slotId: 's-1', total: 6000, payments: [] };
    const uniqueViolation = (index: string) => ({ code: 'P2002', meta: { driverAdapterError: { cause: { constraint: { index } } } } });

    it('books all of them, sets every live index and confirms', async () => {
      const { send, tx, stripe, notifier } = setup({ booking: multi, rows, booked: 2 });
      await send(paid);
      expect(tx.slot.updateMany.mock.calls[0]![0].where).toEqual({
        id: { in: ['s-1', 's-2'] }, OR: [{ status: 'held', heldByBookingId: 'b-1' }, { status: 'available' }],
      });
      expect(tx.bookingSlot.update).toHaveBeenCalledWith({ where: { id: 'bs-1' }, data: { liveSlotId: 's-1', cancelledAt: null } });
      expect(tx.bookingSlot.update).toHaveBeenCalledWith({ where: { id: 'bs-2' }, data: { liveSlotId: 's-2', cancelledAt: null } });
      expect(tx.booking.update.mock.calls[0]![0].data).toMatchObject({ status: 'confirmed', liveSlotId: 's-1' });
      expect(stripe.refund).not.toHaveBeenCalled();
      expect(notifier.confirmed).toHaveBeenCalledWith('b-1');
    });

    it('rolls the whole transaction back when only some could be booked (0 < count < N), then refunds', async () => {
      const { send, prisma, tx, stripe, notifier } = setup({ booking: multi, rows, booked: 1 });
      await send(paid);
      // The transaction callback threw, so a real database undoes the slot it did book.
      await expect(prisma.$transaction.mock.results[0]!.value).rejects.toThrow();
      expect(tx.payment.create).toHaveBeenCalledTimes(1);
      expect(tx.payment.create).toHaveBeenCalledWith({ data: expect.objectContaining({ status: 'refunded' }) });
      expect(tx.bookingSlot.update).not.toHaveBeenCalled();
      expect(stripe.refund).toHaveBeenCalledWith('pi_1');
      expect(notifier.confirmed).not.toHaveBeenCalled();
      expect(notifier.newBookingToAdmins).not.toHaveBeenCalled();
    });

    it('refunds when none could be booked, and frees the BookingSlot live indexes and any slot still held', async () => {
      const { send, tx, stripe } = setup({ booking: multi, rows, booked: 0 });
      await send(paid);
      expect(stripe.refund).toHaveBeenCalledWith('pi_1');
      expect(tx.bookingSlot.updateMany).toHaveBeenCalledWith({
        where: { bookingId: 'b-1', cancelledAt: null }, data: { liveSlotId: null, cancelledAt: expect.any(Date) },
      });
      expect(tx.slot.updateMany).toHaveBeenLastCalledWith({
        where: { status: 'held', heldByBookingId: 'b-1' }, data: { status: 'available', heldUntil: null, heldByBookingId: null },
      });
    });

    it.each(['Booking_liveSlotId_key', 'BookingSlot_liveSlotId_key'])('refunds on a unique violation of %s', async (index) => {
      const { send, tx, stripe, notifier } = setup({ booking: multi, rows, booked: 2 });
      tx.payment.create.mockRejectedValueOnce(uniqueViolation(index));
      await send(paid);
      expect(stripe.refund).toHaveBeenCalledWith('pi_1');
      expect(notifier.confirmed).not.toHaveBeenCalled();
    });

    it('rethrows any other unique violation', async () => {
      const { send, tx } = setup({ booking: multi, rows, booked: 2 });
      tx.payment.create.mockRejectedValueOnce(uniqueViolation('Payment_stripePaymentIntentId_key'));
      await expect(send(paid)).rejects.toMatchObject({ code: 'P2002' });
    });
  });

  const duePaid = (amount: number) => ({
    type: 'checkout.session.completed',
    data: { object: { metadata: { bookingId: 'b-1', purpose: 'due' }, payment_intent: 'pi_due', payment_status: 'paid', amount_total: amount } },
  });

  it('records a "Pay now" payment and confirms a pending booking now paid in full', async () => {
    const { send, tx, notifier } = setup();
    await send(duePaid(6000));
    expect(tx.payment.create).toHaveBeenCalledWith({ data: expect.objectContaining({ amount: 6000, method: 'card', status: 'succeeded' }) });
    expect(tx.booking.update.mock.calls[0]![0].data).toMatchObject({ paymentStatus: 'paid', status: 'confirmed' });
    expect(notifier.confirmed).toHaveBeenCalledWith('b-1');
  });

  it('a partial "Pay now" on a confirmed booking only updates the payment status', async () => {
    const { send, tx, notifier } = setup({ booking: { id: 'b-1', status: 'confirmed', total: 6000, payments: [] } });
    await send(duePaid(2000));
    expect(tx.booking.update.mock.calls[0]![0].data).toEqual({ paymentStatus: 'partial' });
    expect(notifier.confirmed).not.toHaveBeenCalled();
  });

  it('refunds a "Pay now" payment when nothing is due any more', async () => {
    const { send, stripe, notifier, tx } = setup({ booking: { id: 'b-1', status: 'confirmed', total: 6000, payments: [{ amount: 6000, status: 'succeeded' }] } });
    await send(duePaid(6000));
    expect(stripe.refund).toHaveBeenCalledWith('pi_due');
    expect(tx.payment.create).not.toHaveBeenCalled();
    expect(notifier.paymentRefunded).toHaveBeenCalledWith('b-1', 6000);
  });

  it('never cancels a booking when a "Pay now" session expires', async () => {
    const { send, cancellation } = setup();
    await send({ type: 'checkout.session.expired', data: { object: { metadata: { bookingId: 'b-1', purpose: 'due' } } } });
    expect(cancellation.cancel).not.toHaveBeenCalled();
  });

  it('ignores events it does not handle', async () => {
    await expect(setup().send({ type: 'customer.created', data: { object: {} } })).resolves.toEqual({ received: true });
  });
});
