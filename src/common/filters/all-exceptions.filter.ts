import {
  Catch, HttpException, HttpStatus, Logger, type ArgumentsHost, type ExceptionFilter,
} from '@nestjs/common';
import type { Response } from 'express';
import { AppError } from '../app-error.js';
import { failure, type ApiError, type ApiFieldError } from '../api-response.js';

/** Turns every thrown error into the `{ success: false, error }` shape from CLAUDE.md. */
@Catch()
export class AllExceptionsFilter implements ExceptionFilter {
  private readonly logger = new Logger(AllExceptionsFilter.name);

  catch(exception: unknown, host: ArgumentsHost) {
    const res = host.switchToHttp().getResponse<Response>();
    const [status, body] = this.toResponse(exception);
    res.status(status).json(body);
  }

  private toResponse(exception: unknown): [number, ApiError] {
    if (exception instanceof AppError) {
      return [exception.status, failure(exception.message, exception.code)];
    }
    if (exception instanceof HttpException) {
      return [exception.getStatus(), fromHttpException(exception)];
    }
    // Unknown error: log it, but never leak internals to the client.
    this.logger.error(exception instanceof Error ? exception.stack : String(exception));
    return [HttpStatus.INTERNAL_SERVER_ERROR, failure('Internal server error')];
  }
}

function fromHttpException(exception: HttpException): ApiError {
  const response = exception.getResponse();
  if (typeof response === 'string') return failure(response);

  const { message, code, details } = response as { message?: string | string[]; code?: string; details?: ApiFieldError[] };
  const text = Array.isArray(message) ? message.join(', ') : (message ?? exception.message);
  return failure(text, code, details);
}
