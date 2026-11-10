import { CheckoutSchema } from './bookings.schemas.js';

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
});
