/**
 * A known, user-facing failure thrown from services, e.g.
 * `throw new AppError('That slot was just taken', 409, 'SLOT_UNAVAILABLE')`.
 * The global exception filter turns it into `{ success: false, error, code }`.
 */
export class AppError extends Error {
  constructor(
    message: string,
    readonly status = 400,
    readonly code?: string,
  ) {
    super(message);
    this.name = 'AppError';
  }
}
