import { UpdateSlotSettingsSchema } from './slots.schemas.js';

describe('UpdateSlotSettingsSchema multi-slot fields', () => {
  it.each([2, 3, 4])('accepts maxSlotsPerBooking %i', (value) => {
    expect(UpdateSlotSettingsSchema.safeParse({ maxSlotsPerBooking: value }).success).toBe(true);
  });

  it.each([1, 5, 0, 2.5, '3'])('rejects maxSlotsPerBooking %j', (value) => {
    expect(UpdateSlotSettingsSchema.safeParse({ maxSlotsPerBooking: value }).success).toBe(false);
  });

  it('needs multiSlotEnabled to be a boolean', () => {
    expect(UpdateSlotSettingsSchema.safeParse({ multiSlotEnabled: true }).success).toBe(true);
    expect(UpdateSlotSettingsSchema.safeParse({ multiSlotEnabled: 'true' }).success).toBe(false);
  });
});
