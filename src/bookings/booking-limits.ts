import type { SlotSettings } from '../slots/slots.schemas.js';

/** Hard ceiling on slots per booking; the admin setting `maxSlotsPerBooking` (2 to 4) can only lower it. */
export const MAX_SLOTS_PER_BOOKING = 4;

/** Slots one new booking may hold (portal checkout or staff booking): 1 unless an admin allowed multiple slots. */
export const slotLimitOf = ({ multiSlotEnabled, maxSlotsPerBooking }: Pick<SlotSettings, 'multiSlotEnabled' | 'maxSlotsPerBooking'>): number =>
  multiSlotEnabled ? Math.min(Math.max(maxSlotsPerBooking, 1), MAX_SLOTS_PER_BOOKING) : 1;
