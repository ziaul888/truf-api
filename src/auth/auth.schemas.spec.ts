import { z } from 'zod';
import { OptionalEmailSchema } from './auth.schemas.js';

describe('OptionalEmailSchema', () => {
  const schema = z.object({ email: OptionalEmailSchema });

  it('turns blank or null into null, and leaves a missing one missing', () => {
    expect(schema.parse({ email: '' })).toEqual({ email: null });
    expect(schema.parse({ email: '   ' })).toEqual({ email: null });
    expect(schema.parse({ email: null })).toEqual({ email: null });
    expect(schema.parse({})).toEqual({});
  });

  it('trims and lowercases a real email, and refuses anything else', () => {
    expect(schema.parse({ email: ' Rakib@Example.COM ' })).toEqual({ email: 'rakib@example.com' });
    expect(schema.safeParse({ email: 'not-an-email' }).error?.issues[0]?.message).toBe('Enter a valid email');
    expect(schema.safeParse({ email: 42 }).success).toBe(false);
  });
});
