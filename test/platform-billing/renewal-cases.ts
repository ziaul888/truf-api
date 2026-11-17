import { randomUUID } from 'node:crypto';
import {
  post,
  get,
  setupAgreement,
  receiptInput,
  type GetBilling,
} from './billing-state.js';
const renewal = () => ({ requestId: randomUUID(), dueOn: '2027-01-01' });
export function renewalCases(state: GetBilling) {
  it('requires initial payment and creates only one open renewal invoice', async () => {
    const s = state(),
      a = await setupAgreement(s),
      path = `/subscriptions/${a.sub.id}/renewal-invoice`;
    await post(s, path, renewal()).expect(409);
    await post(
      s,
      `/invoices/${a.invoice.id}/record-payment`,
      receiptInput(),
    ).expect(200);
    const body = renewal(),
      first = await post(s, path, body).expect(201);
    expect(first.body.data).toMatchObject({
      periodIndex: 1,
      periodStart: a.invoice.periodEnd,
      amount: a.sub.amount,
    });
    const replay = await post(s, path, body).expect(201);
    expect(replay.body.data.id).toBe(first.body.data.id);
    await post(s, path, renewal()).expect(409);
    await post(
      s,
      `/invoices/${first.body.data.id}/record-payment`,
      receiptInput(),
    ).expect(200);
    const second = await post(s, path, renewal()).expect(201);
    expect(second.body.data).toMatchObject({
      periodIndex: 2,
      periodStart: first.body.data.periodEnd,
    });
  });
  it('preserves agreed prices after a plan gains a newer version', async () => {
    const s = state(),
      a = await setupAgreement(s);
    await s.db.platformPlanVersion.create({
      data: {
        planId: a.plan.id,
        version: 2,
        monthlyAmount: 999999,
        yearlyAmount: 9999999,
        currency: 'bdt',
      },
    });
    await post(
      s,
      `/invoices/${a.invoice.id}/record-payment`,
      receiptInput(),
    ).expect(200);
    const next = await post(
      s,
      `/subscriptions/${a.sub.id}/renewal-invoice`,
      renewal(),
    ).expect(201);
    expect(next.body.data.amount).toBe(a.plan.monthlyAmount);
    expect(next.body.data.planName).toBe(a.plan.name);
  });
  it('cancels unpaid agreements immediately, voids their invoice and allows a replacement', async () => {
    const s = state(),
      a = await setupAgreement(s),
      body = {
        requestId: randomUUID(),
        reason: 'Owner chose a different plan',
      };
    const cancel = await post(
      s,
      `/subscriptions/${a.sub.id}/cancel`,
      body,
    ).expect(200);
    expect(cancel.body.data).toMatchObject({
      status: 'cancelled',
      canRenew: false,
    });
    const invoice = await get(s, `/invoices/${a.invoice.id}`).expect(200);
    expect(invoice.body.data.status).toBe('void');
    await post(
      s,
      `/invoices/${a.invoice.id}/record-payment`,
      receiptInput(),
    ).expect(409);
    await post(s, `/subscriptions/${a.sub.id}/cancel`, body).expect(200);
    await post(s, `/tenants/${a.turf.id}/subscription`, {
      ...a.input,
      requestId: randomUUID(),
    }).expect(201);
  });
  it('preserves paid-through access and receipts when cancelling renewal', async () => {
    const s = state(),
      a = await setupAgreement(s);
    await post(
      s,
      `/invoices/${a.invoice.id}/record-payment`,
      receiptInput(),
    ).expect(200);
    const next = await post(
      s,
      `/subscriptions/${a.sub.id}/renewal-invoice`,
      renewal(),
    ).expect(201);
    const cancel = await post(s, `/subscriptions/${a.sub.id}/cancel`, {
      requestId: randomUUID(),
      reason: 'Owner requested cancellation',
    }).expect(200);
    expect(cancel.body.data).toMatchObject({
      status: 'active',
      cancelAtPeriodEnd: true,
      paidThrough: a.invoice.periodEnd,
      canRenew: false,
    });
    const invoice = await get(s, `/invoices/${next.body.data.id}`).expect(200);
    expect(invoice.body.data.status).toBe('void');
    const original = await get(s, `/invoices/${a.invoice.id}`).expect(200);
    expect(original.body.data.status).toBe('paid');
    expect(original.body.data.receipt).not.toBeNull();
    await post(
      s,
      `/subscriptions/${a.sub.id}/renewal-invoice`,
      renewal(),
    ).expect(409);
    await post(s, `/tenants/${a.turf.id}/subscription`, {
      ...a.input,
      requestId: randomUUID(),
    }).expect(409);
  });
  it('derives expiry and overdue filters from billing dates without a job', async () => {
    const s = state(),
      a = await setupAgreement(s);
    await s.db.platformInvoice.update({
      where: { id: a.invoice.id },
      data: { dueOn: new Date('2000-01-01') },
    });
    const overdue = await get(
      s,
      `/invoices?status=overdue&tenantId=${a.turf.id}`,
    ).expect(200);
    expect(overdue.body.data.data[0].status).toBe('overdue');
    await post(
      s,
      `/invoices/${a.invoice.id}/record-payment`,
      receiptInput(),
    ).expect(200);
    await s.db.platformSubscription.update({
      where: { id: a.sub.id },
      data: { paidThrough: new Date('2000-02-01') },
    });
    const expired = await get(
      s,
      `/subscriptions?status=past_due&tenantId=${a.turf.id}`,
    ).expect(200);
    expect(expired.body.data.data[0].status).toBe('past_due');
    await s.db.platformSubscription.update({
      where: { id: a.sub.id },
      data: { cancelAtPeriodEnd: true },
    });
    const cancelled = await get(
      s,
      `/subscriptions?status=cancelled&tenantId=${a.turf.id}`,
    ).expect(200);
    expect(cancelled.body.data.data[0].status).toBe('cancelled');
  });
}
