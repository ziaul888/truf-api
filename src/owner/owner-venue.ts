import { AppError } from '../common/app-error.js';
import type { Prisma } from '../generated/prisma/client.js';
import { CompleteVenueSchema } from '../settings/venue.schemas.js';
import type { OwnerContext } from './owner-session.js';

export function setupData(data: Prisma.JsonValue | undefined) {
  return data && typeof data === 'object' && !Array.isArray(data) ? data : {};
}

export function configuredVenue(data: Prisma.JsonValue | undefined) {
  return CompleteVenueSchema.safeParse(setupData(data).venue).data;
}

export function assertTurfAvailable(owner: OwnerContext) {
  if (owner.user.tenant.status === 'suspended') {
    throw new AppError('This turf is suspended', 403, 'TURF_SUSPENDED');
  }
}

export function requireVenue(owner: OwnerContext) {
  assertTurfAvailable(owner);
  if (!owner.user.tenant.setupComplete) {
    throw new AppError(
      'Save Settings → General first',
      403,
      'TURF_SETUP_REQUIRED',
    );
  }
}
