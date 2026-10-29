/**
 * Normalises a phone number to "+" and digits, so the same number always matches.
 * Bangladesh local numbers ("01711000000") get the 88 country code. Returns null if too short.
 */
export function normalizePhone(input: string): string | null {
  let digits = input.replace(/\D/g, '');
  if (/^01\d{9}$/.test(digits)) digits = `88${digits}`;
  return digits.length >= 8 && digits.length <= 15 ? `+${digits}` : null;
}
