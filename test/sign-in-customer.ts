import type { INestApplication } from '@nestjs/common';
import request from 'supertest';
import type { App } from 'supertest/types';
import { env } from './../src/config/env.js';

/**
 * Signs a customer in with the fixed TEST_OTP_CODE (vitest.config.e2e.ts; no SMS is sent) and
 * returns an agent carrying their `customer_token`. Cash, bKash and Nagad checkouts need one.
 * Verify only, no send-code: that keeps clear of the 3-codes-per-10-minutes limit.
 */
export async function signInCustomer(app: INestApplication<App>, phone: string) {
  const agent = request.agent(app.getHttpServer());
  await agent.post('/api/v1/customer/auth/verify').send({ phone, code: env.TEST_OTP_CODE }).expect(200);
  return agent;
}
