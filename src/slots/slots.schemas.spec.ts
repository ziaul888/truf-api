import { UpdateSlotSettingsSchema } from './slots.schemas.js';

describe('UpdateSlotSettingsSchema multi-slot fields', () => {
  it.each([2, 3, 4])('accepts maxSlotsPerBooking %i', (value) => {
    expect(
      UpdateSlotSettingsSchema.safeParse({ maxSlotsPerBooking: value }).success,
    ).toBe(true);
  });

  it.each([1, 5, 0, 2.5, '3'])('rejects maxSlotsPerBooking %j', (value) => {
    expect(
      UpdateSlotSettingsSchema.safeParse({ maxSlotsPerBooking: value }).success,
    ).toBe(false);
  });

  it('needs multiSlotEnabled to be a boolean', () => {
    expect(
      UpdateSlotSettingsSchema.safeParse({ multiSlotEnabled: true }).success,
    ).toBe(true);
    expect(
      UpdateSlotSettingsSchema.safeParse({ multiSlotEnabled: 'true' }).success,
    ).toBe(false);
  });
});

describe('UpdateSlotSettingsSchema cash-deposit fields', () => {
  it.each([1, 30, 100])('accepts cashDepositPercent %i', (value) => {
    expect(
      UpdateSlotSettingsSchema.safeParse({ cashDepositPercent: value }).success,
    ).toBe(true);
  });

  it.each([0, 101, -5, 12.5, '30'])(
    'rejects cashDepositPercent %j',
    (value) => {
      expect(
        UpdateSlotSettingsSchema.safeParse({ cashDepositPercent: value })
          .success,
      ).toBe(false);
    },
  );

  it('needs cashDepositEnabled to be a boolean', () => {
    expect(
      UpdateSlotSettingsSchema.safeParse({ cashDepositEnabled: true }).success,
    ).toBe(true);
    expect(
      UpdateSlotSettingsSchema.safeParse({ cashDepositEnabled: 'true' })
        .success,
    ).toBe(false);
  });
});
