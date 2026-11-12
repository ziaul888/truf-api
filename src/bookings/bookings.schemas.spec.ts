import { CheckoutSchema, CreateStaffBookingSchema } from './bookings.schemas.js';

const body = {
  groundId: '6f1c2a8e-0b7d-4c3e-9a51-2d4f8e6b7c10', date: '2026-10-29', hour: 16,
  customerName: 'Rakib', customerEmail: 'r@x.test', customerPhone: '01711000000',
};

describe('CheckoutSchema', () => {
  it('takes the minute as `minute` or `startMinute`: 0 or 30, default 0', () => {
    expect(CheckoutSchema.parse(body)).toMatchObject({ startHour: 16, startMinute: 0 });
    expect(CheckoutSchema.parse({ ...body, minute: '30' })).toMatchObject({ startHour: 16, startMinute: 30 });
    expect(CheckoutSchema.parse({ ...body, startMinute: 30, minute: 0 })).toMatchObject({ startMinute: 30 });
    expect(CheckoutSchema.safeParse({ ...body, minute: 15 }).error?.issues.map((i) => i.path.join('.'))).toEqual(['startMinute']);
  });

  describe('slots', () => {
    const { hour: _hour, ...multi } = body;
    const paths = (v: unknown) => CheckoutSchema.safeParse(v).error?.issues.map((i) => i.path.join('.'));

    it('takes a list of start times, each with the same short names', () => {
      expect(CheckoutSchema.parse({ ...multi, slots: [{ hour: 16 }, { startHour: '17', minute: '30' }] }).slots)
        .toEqual([{ startHour: 16, startMinute: 0 }, { startHour: 17, startMinute: 30 }]);
    });

    it('needs exactly one of the single hour and the list', () => {
      expect(paths(multi)).toEqual(['startHour']);
      expect(paths({ ...body, slots: [{ hour: 17 }] })).toEqual(['slots']);
    });

    it('refuses an empty list, a repeated slot, a bad minute and keys that would change the ground or date', () => {
      expect(paths({ ...multi, slots: [] })).toEqual(['slots']);
      expect(paths({ ...multi, slots: [{ hour: 16 }, { hour: 16 }] })).toEqual(['slots']);
      expect(paths({ ...multi, slots: [{ hour: 16, minute: 15 }] })).toEqual(['slots.0.startMinute']);
      expect(paths({ ...multi, slots: [{ hour: 16, groundId: '6f1c2a8e-0b7d-4c3e-9a51-2d4f8e6b7c11' }] })).toEqual(['slots.0']);
      expect(paths({ ...multi, slots: [{ hour: 16, date: '2026-10-30' }] })).toEqual(['slots.0']);
    });

    it('leaves the 4-slot limit to the service, which answers TOO_MANY_SLOTS', () => {
      const five = [14, 15, 16, 17, 18].map((hour) => ({ hour }));
      expect(CheckoutSchema.safeParse({ ...multi, slots: five }).success).toBe(true);
    });
  });
});

describe('CreateStaffBookingSchema', () => {
  const rest = { customer: { name: 'Walk In', phone: '01711000000' }, payment: { type: 'none' as const } };
  const id = (n: number) => `6f1c2a8e-0b7d-4c3e-9a51-2d4f8e6b7c1${n}`;
  const paths = (v: unknown) => CreateStaffBookingSchema.safeParse(v).error?.issues.map((i) => i.path.join('.'));

  it('takes slotId (as before) or slotIds, exactly one of them', () => {
    expect(CreateStaffBookingSchema.safeParse({ ...rest, slotId: id(0) }).success).toBe(true);
    expect(CreateStaffBookingSchema.safeParse({ ...rest, slotIds: [id(0), id(1)] }).success).toBe(true);
    expect(paths(rest)).toEqual(['slotIds']);
    expect(paths({ ...rest, slotId: id(0), slotIds: [id(1)] })).toEqual(['slotIds']);
  });

  it('refuses an empty or repeated list, and keeps the customer shape for repeat bookings', () => {
    expect(paths({ ...rest, slotIds: [] })).toEqual(['slotIds']);
    expect(paths({ ...rest, slotIds: [id(0), id(0)] })).toEqual(['slotIds']);
    expect(CreateStaffBookingSchema.shape.customer).toBeDefined();
  });
});
