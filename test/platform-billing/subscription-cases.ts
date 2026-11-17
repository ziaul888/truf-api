import request from 'supertest';
import { randomUUID } from 'node:crypto';
import {
  api,
  post,
  get,
  inputPlan,
  inputTurf,
  setupAgreement,
  type GetBilling,
} from './billing-state.js';
export function subscriptionCases(state: GetBilling) {
  it('protects every billing read from staff-only or anonymous sessions', async () => {
    const s = state();
    for (const path of ['/plans', '/subscriptions', '/invoices']) {
      await request(s.app.getHttpServer())
        .get(api + path)
        .expect(401);
      await request(s.app.getHttpServer())
        .get(api + path)
        .set('Cookie', s.staffCookie)
        .expect(401);
    }
  });
  it('requires positive integer plan prices and stores a BDT price version', async () => {
    const s = state();
    for (const amount of [0, -1, 1.5, 1_000_000_001])
      await post(s, '/plans', { ...inputPlan(), monthlyAmount: amount }).expect(
        400,
      );
    const body = inputPlan();
    const a = await post(s, '/plans', { ...body, currency: 'usd' }).expect(201);
    const b = await post(s, '/plans', body).expect(201);
    expect(a.body.data).toMatchObject({
      monthlyAmount: body.monthlyAmount,
      yearlyAmount: body.yearlyAmount,
      currency: 'bdt',
      version: 1,
    });
    expect(b.body.data.id).toBe(a.body.data.id);
    await post(s, '/plans', { ...inputPlan(), code: body.code }).expect(409);
    const list = await get(s, '/plans?search=' + body.code).expect(200);
    expect(list.body.data.total).toBe(1);
  });
  it('atomically creates an agreement with its server-priced initial invoice', async () => {
    const s = state(),
      a = await setupAgreement(s);
    expect(a.sub).toMatchObject({
      tenantId: a.turf.id,
      status: 'pending',
      amount: a.plan.monthlyAmount,
      openInvoiceCount: 1,
      canRenew: false,
    });
    expect(a.invoice).toMatchObject({
      subscriptionId: a.sub.id,
      periodIndex: 0,
      amount: a.plan.monthlyAmount,
      currency: 'bdt',
      status: 'issued',
    });
    const replay = await post(
      s,
      `/tenants/${a.turf.id}/subscription`,
      a.input,
    ).expect(201);
    expect(replay.body.data.id).toBe(a.sub.id);
    await post(s, `/tenants/${a.turf.id}/subscription`, {
      ...a.input,
      requestId: randomUUID(),
    }).expect(409);
    expect(
      await s.db.platformInvoice.count({ where: { subscriptionId: a.sub.id } }),
    ).toBe(1);
  });
  it('selects the yearly price and ignores client price overrides', async () => {
    const s = state(),
      turf = await post(s, '/tenants', inputTurf()).expect(201),
      plan = await post(s, '/plans', inputPlan()).expect(201);
    const sub = await post(s, `/tenants/${turf.body.data.id}/subscription`, {
      requestId: randomUUID(),
      planId: plan.body.data.id,
      interval: 'yearly',
      startDate: '2028-02-29',
      dueOn: '2028-02-29',
      amount: 1,
      currency: 'usd',
    }).expect(201);
    expect(sub.body.data.amount).toBe(plan.body.data.yearlyAmount);
    const invoices = await get(
      s,
      '/invoices?tenantId=' + turf.body.data.id,
    ).expect(200);
    expect(invoices.body.data.data[0]).toMatchObject({
      periodStart: '2028-02-29',
      periodEnd: '2029-02-28',
      amount: plan.body.data.yearlyAmount,
    });
  });
  it('rolls back unavailable-plan onboarding and rejects archived turfs', async () => {
    const s = state(),
      a = await setupAgreement(s),
      turf = await post(s, '/tenants', inputTurf()).expect(201);
    const path = `/tenants/${turf.body.data.id}/subscription`;
    await post(s, path, {
      ...a.input,
      requestId: randomUUID(),
      planId: randomUUID(),
    }).expect(400);
    expect(
      await s.db.platformSubscription.count({
        where: { tenantId: turf.body.data.id },
      }),
    ).toBe(0);
    await s.db.tenant.update({
      where: { id: turf.body.data.id },
      data: { status: 'archived' },
    });
    await post(s, path, { ...a.input, requestId: randomUUID() }).expect(409);
  });
  it('returns explicit missing records and validates filters', async () => {
    const s = state(),
      id = randomUUID();
    for (const path of [
      `/invoices/${id}`,
      `/subscriptions/${id}`,
      `/tenants/${id}/billing`,
    ])
      await get(s, path).expect(404);
    await get(s, '/invoices?status=invalid').expect(400);
    await get(s, '/subscriptions?tenantId=invalid').expect(400);
    await get(s, '/plans?page=0').expect(400);
  });
}
