import type { PrismaService } from '../prisma/prisma.service.js';
import type { StripeService } from '../payments/stripe.service.js';
import type { BookingCancellationService } from './booking-cancellation.service.js';
import type { BookingNotifier } from './booking-notifier.service.js';
import { StripeWebhookService } from './stripe-webhook.service.js';

function setup({ existingPayment = null as object | null, booking = { id: 'b-1', status: 'pending', slotId: 's-1', total: 6000, payments: [] } as object | null } = {}) {
  const tx = {
    payment: { create: vi.fn(async (_args: { data: object }) => ({})) },
    booking: { update: vi.fn(async (_args: { data: object }) => ({})) },
    bookingEvent: { createMany: vi.fn(async (_args: { data: { type: string }[] }) => ({})) },
  };
  const prisma = {
    payment: { findUnique: vi.fn(async () => existingPayment), create: vi.fn((args: object) => args) },
    booking: { findUnique: vi.fn(async () => booking), updateMany: vi.fn(async (_args: object) => ({ count: 1 })) },
    bookingEvent: { createMany: vi.fn((args: object) => args) },
    $transaction: vi.fn(async (arg: unknown) => (typeof arg === 'function' ? arg(tx) : arg)),
  };
  const stripe = { parseWebhook: vi.fn(), cardLast4: vi.fn(async () => '4242'), refund: vi.fn(async (id: string) => `re_${id}`) };
  const notifier = { confirmed: vi.fn(), newBookingToAdmins: vi.fn(), paymentRefunded: vi.fn() };
  const cancellation = { cancel: vi.fn(async () => undefined) };
  const service = new StripeWebhookService(
    prisma as unknown as PrismaService, stripe as unknown as StripeService,
    cancellation as unknown as BookingCancellationService, notifier as unknown as BookingNotifier,
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
