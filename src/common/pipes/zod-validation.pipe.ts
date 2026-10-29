import { BadRequestException, type PipeTransform } from '@nestjs/common';
import { z, type ZodType } from 'zod';
import type { ApiFieldError } from '../api-response.js';

// Friendlier defaults than "Invalid input: expected string, received undefined".
// Messages set on a schema (e.g. `z.email('Enter a valid email')`) still win.
z.config({
  customError: (issue) => {
    if (issue.code !== 'invalid_type') return undefined;
    return issue.input === undefined ? 'This field is required' : `Must be a ${issue.expected}`;
  },
});

/**
 * Validates a body, query or param against a Zod schema and returns the parsed value.
 * Usage: `@Body(new ZodValidationPipe(LoginSchema)) body: LoginInput`
 */
export class ZodValidationPipe<T> implements PipeTransform<unknown, T> {
  constructor(private readonly schema: ZodType<T>) {}

  transform(value: unknown): T {
    const parsed = this.schema.safeParse(value);
    if (parsed.success) return parsed.data;

    const details: ApiFieldError[] = parsed.error.issues.map((issue) => ({
      field: issue.path.join('.'),
      message: issue.message,
    }));
    throw new BadRequestException({ message: 'Some fields are invalid', code: 'VALIDATION_FAILED', details });
  }
}
