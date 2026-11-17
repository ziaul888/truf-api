import { randomUUID } from 'node:crypto';
import {
  post,
  get,
  setupAgreement,
  receiptInput,
  type GetBilling,
} from './billing-state.js';
export function receiptCases(state: GetBilling) {
  it('records the full verified payment, preserving setup state and booking finances', async () => {
    const s = state(),
      a = await setupAgreement(s),
      body = receiptInput();
    const before = await s.db.payment.count();
    const response = await post(s, `/invoices/${a.invoice.id}/record-payment`, {
      ...body,
      amount: 1,
      currency: 'usd',
      recordedById: s.staffId,
    }).expect(200);
    expect(response.body.data).toMatchObject({
      status: 'paid',
      receipt: {
        amount: a.invoice.amount,
        currency: 'bdt',
        recordedBy: { id: s.adminId },
      },
    });
    const billing = await get(s, `/tenants/${a.turf.id}/billing`).expect(200);
    expect(billing.body.data.subscription).toMatchObject({
      status: 'active',
      paidThrough: a.invoice.periodEnd,
      canRenew: true,
    });
    const turf = await get(s, `/tenants/${a.turf.id}`).expect(200);
    expect(turf.body.data).toMatchObject({
      status: 'draft',
      owner: { isActive: false },
    });
    expect(await s.db.payment.count()).toBe(before);
    const replay = await post(
      s,
      `/invoices/${a.invoice.id}/record-payment`,
      body,
    ).expect(200);
    expect(replay.body.data.receipt.id).toBe(response.body.data.receipt.id);
    expect(
      await s.db.platformReceipt.count({ where: { invoiceId: a.invoice.id } }),
    ).toBe(1);
  });
  it('requires explicit verification, a reference and a nonfuture payment date', async () => {
    const s = state(),
      a = await setupAgreement(s),
      path = `/invoices/${a.invoice.id}/record-payment`;
    for (const extra of [
      { confirmed: false },
      { confirmed: undefined },
      { reference: '' },
      { receivedOn: '2100-01-01' },
      { method: 'cash' },
    ])
      await post(s, path, { ...receiptInput(), ...extra }).expect(400);
    expect(
      await s.db.platformReceipt.count({ where: { invoiceId: a.invoice.id } }),
    ).toBe(0);
  });
  it('allows only one winner for concurrent payment records', async () => {
    const s = state(),
      a = await setupAgreement(s),
      path = `/invoices/${a.invoice.id}/record-payment`;
    const responses = await Promise.all([
      post(s, path, receiptInput()),
      post(s, path, receiptInput()),
    ]);
    expect(responses.map((r) => r.status).sort()).toEqual([200, 409]);
    expect(
      await s.db.platformReceipt.count({ where: { invoiceId: a.invoice.id } }),
    ).toBe(1);
    expect(
      await s.db.platformAuditEvent.count({
        where: { targetId: a.invoice.id, action: 'invoice_paid' },
      }),
    ).toBe(1);
  });
  it('replays concurrent identical payment requests without double receipts', async () => {
    const s = state(),
      a = await setupAgreement(s),
      path = `/invoices/${a.invoice.id}/record-payment`,
      body = receiptInput();
    const responses = await Promise.all([
      post(s, path, body),
      post(s, path, body),
    ]);
    expect(responses.map((r) => r.status)).toEqual([200, 200]);
    expect(responses[0].body.data.receipt.id).toBe(
      responses[1].body.data.receipt.id,
    );
  });
  it('prevents normalized reference reuse across invoices and rolls back the losing payment', async () => {
    const s = state(),
      a = await setupAgreement(s),
      b = await setupAgreement(s),
      ref = 'TRX-' + randomUUID();
    await post(
      s,
      `/invoices/${a.invoice.id}/record-payment`,
      receiptInput(ref),
    ).expect(200);
    await post(
      s,
      `/invoices/${b.invoice.id}/record-payment`,
      receiptInput(' ' + ref.toLowerCase().replaceAll('-', ' - ') + ' '),
    ).expect(409);
    const unpaid = await get(s, `/invoices/${b.invoice.id}`).expect(200);
    expect(unpaid.body.data).toMatchObject({ status: 'issued', receipt: null });
    const pending = await get(s, `/subscriptions/${b.sub.id}`).expect(200);
    expect(pending.body.data.paidThrough).toBeNull();
    await post(s, `/invoices/${b.invoice.id}/record-payment`, {
      ...receiptInput(ref),
      method: 'nagad',
    }).expect(200);
  });
  it('does not permit reuse of a request key against a different resource', async () => {
    const s = state(),
      a = await setupAgreement(s),
      b = await setupAgreement(s),
      body = receiptInput();
    await post(s, `/invoices/${a.invoice.id}/record-payment`, body).expect(200);
    const wrong = await post(
      s,
      `/invoices/${b.invoice.id}/record-payment`,
      body,
    ).expect(409);
    expect(wrong.body.code).toBe('IDEMPOTENCY_CONFLICT');
  });
}
