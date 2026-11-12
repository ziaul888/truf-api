import { env } from '../config/env.js';

/** Most slots one booking can hold (a portal checkout or a staff booking). Also sent as `maxSlotsPerBooking` in GET /checkout/options. */
export const MAX_SLOTS_PER_BOOKING = 4;

/** Single-slot mode keeps rolling deploys safe until the operator completes the cut-over. */
export const bookingSlotLimit = () => env.MULTI_SLOT_BOOKINGS_ENABLED ? MAX_SLOTS_PER_BOOKING : 1;
