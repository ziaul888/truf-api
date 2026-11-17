import { randomUUID } from 'node:crypto';
import request from 'supertest';
import type { Server } from 'node:http';
import type { INestApplication } from '@nestjs/common';
import type { PrismaService } from '../../src/prisma/prisma.service.js';
import {
  billingDate,
  billingToday,
} from '../../src/platform/platform-billing-dates.js';
export const credentials = {
  email: 'admin@billing-e2e.test',
  password: 'billing-e2e-password',
};
export interface BillingState {
  app: INestApplication<Server>;
  db: PrismaService;
  cookie: string;
  staffCookie: string;
  adminId: string;
  staffId: string;
}
export type GetBilling = () => BillingState;
export const api = '/api/v1/platform';
let sequence = 0;
export const inputTurf = () => {
  const n = ++sequence;
  return {
    requestId: randomUUID(),
    name: 'Billing E2E Turf ' + n,
    slug: 'billing-e2e-' + n,
    ownerName: 'Pending Owner ' + n,
    ownerEmail: `owner-${n}@billing-e2e.test`,
    timezone: 'Asia/Dhaka',
    currency: 'bdt',
  };
};
export const inputPlan = () => ({
  requestId: randomUUID(),
  name: 'Starter',
  code: 'billing-e2e-plan-' + ++sequence,
  monthlyAmount: 150000,
  yearlyAmount: 1500000,
});
export const post = (s: BillingState, path: string, body: object) =>
  request(s.app.getHttpServer())
    .post(api + path)
    .set('Cookie', s.cookie)
    .send(body);
export const get = (s: BillingState, path: string) =>
  request(s.app.getHttpServer())
    .get(api + path)
    .set('Cookie', s.cookie);
export async function setupAgreement(s: BillingState) {
  const turf = await post(s, '/tenants', inputTurf()).expect(201);
  const plan = await post(s, '/plans', inputPlan()).expect(201);
  const input = {
    requestId: randomUUID(),
    planId: plan.body.data.id,
    interval: 'monthly',
    startDate: billingDate(billingToday()),
    dueOn: billingDate(billingToday()),
  };
  const sub = await post(
    s,
    `/tenants/${turf.body.data.id}/subscription`,
    input,
  ).expect(201);
  const invoices = await get(
    s,
    `/invoices?tenantId=${turf.body.data.id}`,
  ).expect(200);
  return {
    turf: turf.body.data,
    plan: plan.body.data,
    sub: sub.body.data,
    invoice: invoices.body.data.data[0],
    input,
  };
}
export const receiptInput = (reference = 'REF-' + randomUUID()) => ({
  requestId: randomUUID(),
  method: 'bkash',
  reference,
  receivedOn: billingDate(billingToday()),
  confirmed: true,
});
