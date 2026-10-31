import { z } from 'zod';

/** Plain text, trimmed, with the frontend's own messages. */
export const text = (max: number, required?: string) =>
  required
    ? z.string().trim().min(1, required).max(max, `Keep it under ${max} characters`)
    : z.string().trim().max(max, `Keep it under ${max} characters`);

export const httpsUrl = z.url({ protocol: /^https$/, message: 'Enter a full URL starting with https://' });

/** An https link, or "" for none. */
export const optionalUrl = z.union([z.literal(''), httpsUrl]);

/**
 * Leaf paths that differ between two plain JSON values ("hero.headline",
 * "sections.amenities.items"). Arrays count as one leaf. For the audit trail: names, not values.
 */
export function changedFields(before: unknown, after: unknown, prefix = ''): string[] {
  const isObject = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);
  if (!isObject(before) || !isObject(after)) {
    return JSON.stringify(before) === JSON.stringify(after) ? [] : [prefix || '*'];
  }
  const keys = [...new Set([...Object.keys(before), ...Object.keys(after)])];
  return keys.flatMap((key) => changedFields(before[key], after[key], prefix ? `${prefix}.${key}` : key));
}
