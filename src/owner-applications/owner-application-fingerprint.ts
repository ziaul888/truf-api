import { createHmac } from 'node:crypto';
import { env } from '../config/env.js';
import type { SubmitOwnerApplication } from './owner-applications.schemas.js';

const key = createHmac('sha256', env.JWT_SECRET)
  .update('turf:owner-application:v1')
  .digest();

export function applicationFingerprint(input: SubmitOwnerApplication) {
  return createHmac('sha256', key)
    .update(
      JSON.stringify({
        name: input.name,
        slug: input.slug,
        timezone: input.timezone,
        currency: input.currency,
        ownerName: input.ownerName,
        ownerEmail: input.ownerEmail,
        password: input.password,
        planId: input.planId,
        interval: input.interval,
        planVersion: input.planVersion,
        expectedAmount: input.expectedAmount,
        paymentMethod: input.paymentMethod,
        paymentReference: input.paymentReference,
        paymentDate: input.paymentDate,
        logo: input.logo,
      }),
    )
    .digest('hex');
}
