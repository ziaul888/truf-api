interface UniqueViolation {
  code?: string;
  meta?: { driverAdapterError?: { cause?: { constraint?: { index?: string } } } };
}

/** The unique index a write violated (e.g. "Booking_liveSlotId_key"), or null if it wasn't a unique violation. */
export function violatedUniqueIndex(err: unknown): string | null {
  const e = err as UniqueViolation;
  if (e?.code !== 'P2002') return null;
  return e.meta?.driverAdapterError?.cause?.constraint?.index ?? '';
}
