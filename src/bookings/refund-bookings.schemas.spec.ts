import { ListRefundBookingsQuerySchema } from './refund-bookings.schemas.js';

describe('ListRefundBookingsQuerySchema', () => {
  it('defaults to all refunds and parses pagination and search', () => {
    expect(ListRefundBookingsQuerySchema.parse({})).toEqual({
      page: 1,
      limit: 20,
      status: 'all',
    });
    expect(
      ListRefundBookingsQuerySchema.parse({
        page: '2',
        limit: '5',
        search: '  BK-123  ',
        status: 'due',
        method: 'bkash',
      }),
    ).toEqual({
      page: 2,
      limit: 5,
      search: 'BK-123',
      status: 'due',
      method: 'bkash',
    });
  });

  it.each([
    { status: 'sent' },
    { method: 'upi' },
    { groundId: 'invalid' },
    { page: 0 },
    { limit: 101 },
    { search: 'x'.repeat(101) },
  ])('rejects an unsupported filter or unsafe pagination: %j', (query) => {
    expect(ListRefundBookingsQuerySchema.safeParse(query).success).toBe(false);
  });
});
