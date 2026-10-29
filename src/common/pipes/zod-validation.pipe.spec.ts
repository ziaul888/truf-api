import { BadRequestException } from '@nestjs/common';
import { z } from 'zod';
import { ZodValidationPipe } from './zod-validation.pipe.js';

describe('ZodValidationPipe', () => {
  const pipe = new ZodValidationPipe(
    z.object({ email: z.email('Enter a valid email'), age: z.coerce.number().min(18) }),
  );

  it('returns the parsed value when input is valid', () => {
    expect(pipe.transform({ email: 'a@b.co', age: '21' })).toEqual({ email: 'a@b.co', age: 21 });
  });

  it('throws a 400 with field-level details when input is invalid', () => {
    try {
      pipe.transform({ email: 'nope', age: 12 });
      expect.unreachable();
    } catch (err) {
      expect(err).toBeInstanceOf(BadRequestException);
      const body = (err as BadRequestException).getResponse() as { code: string; details: { field: string }[] };
      expect(body.code).toBe('VALIDATION_FAILED');
      expect(body.details.map((d) => d.field)).toEqual(['email', 'age']);
    }
  });
});
