import { randomUUID } from 'node:crypto';
import request from 'supertest';
import { OwnerBillingService } from '../../src/owner/owner-billing.service.js';
import {
  billingDate,
  billingToday,
} from '../../src/platform/platform-billing-dates.js';
import { activateOwner, platformPost, type GetOwnerState } from './state.js';
export function ownerBillingCases(state: GetOwnerState) {
  it('scopes account billing to the owner despite forged tenant selectors', async () => {
    const s = state(),
      a = await activateOwner(s),
      b = await activateOwner(s),
      today = billingDate(billingToday());
    const plan = (
      await platformPost(s, '/plans', {
        requestId: randomUUID(),
        name: 'Owner Billing Plan',
        code: 'owner-activation-e2e-' + randomUUID().slice(0, 12),
        monthlyAmount: 100000,
        yearlyAmount: 1000000,
      }).expect(201)
    ).body.data;
    const subscriptions = [];
    for (const turf of [a.turf, b.turf])
      subscriptions.push(
        (
          await platformPost(s, `/tenants/${turf.id}/subscription`, {
            requestId: randomUUID(),
            planId: plan.id,
            interval: 'monthly',
            startDate: today,
            dueOn: today,
          }).expect(201)
        ).body.data,
      );
    const response = await request(s.app.getHttpServer())
      .get(`/api/v1/owner/billing?tenantId=${b.turf.id}&userId=${s.adminId}`)
      .set('Cookie', a.cookie)
      .set('X-Tenant-Id', b.turf.id)
      .expect(200);
    expect(response.body.data.subscription.id).toBe(subscriptions[0].id);
    expect(response.body.data.subscription.id).not.toBe(subscriptions[1].id);
    expect(response.body.data.invoices).toHaveLength(1);
    expect(JSON.stringify(response.body)).not.toMatch(
      /recordedBy|referenceNormalized|actorId/,
    );
    const foreign = await s.db.platformInvoice.findFirstOrThrow({
      where: { tenantId: b.turf.id },
    });
    expect(JSON.stringify(response.body)).not.toContain(foreign.id);
    expect(JSON.stringify(response.body)).not.toContain(foreign.number);
  });
  it('rechecks membership when the billing transaction starts after the guard', async () => {
    const s = state(),
      a = await activateOwner(s),
      service = s.app.get(OwnerBillingService),
      original = service.read.bind(service);
    const member = await s.db.tenantMembership.findFirstOrThrow({
      where: { tenantId: a.turf.id, role: 'owner' },
    });
    const spy = vi
      .spyOn(service, 'read')
      .mockImplementationOnce(async (session) => {
        await s.db.tenantMembership.update({
          where: { id: member.id },
          data: { isActive: false },
        });
        return original(session);
      });
    try {
      const response = await request(s.app.getHttpServer())
        .get('/api/v1/owner/billing')
        .set('Cookie', a.cookie)
        .expect(401);
      expect(response.body.data).toBeUndefined();
    } finally {
      spy.mockRestore();
    }
  });
}
