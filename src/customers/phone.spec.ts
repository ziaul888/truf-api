import { normalizePhone } from './phone.js';

describe('normalizePhone', () => {
  it.each([
    ['01711000000', '+8801711000000'],
    ['+880 1711-000000', '+8801711000000'],
    ['8801711000000', '+8801711000000'],
    ['+44 20 7946 0958', '+442079460958'],
  ])('normalises %s', (input, expected) => {
    expect(normalizePhone(input)).toBe(expected);
  });

  it('rejects numbers that are too short or too long', () => {
    expect(normalizePhone('12345')).toBeNull();
    expect(normalizePhone('1'.repeat(16))).toBeNull();
  });
});
