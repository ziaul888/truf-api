import { z } from 'zod';
import { PaginationSchema } from '../common/schemas.js';
import { httpsUrl } from '../settings/settings-fields.js';

export const SPORTS = ['football', 'cricket', 'badminton', 'tennis', 'hockey', 'basketball', 'other'] as const;
export const FORMATS = ['4x4', '5x5', '6x6', '7x7', '8x8', '9x9', '11x11', 'net', 'court'] as const;
export const SURFACES = ['outdoor-turf', 'indoor-court', 'covered-net'] as const;
export const AMENITIES = [
  'Floodlights', 'Parking', 'Changing room', 'Washroom', 'Scoreboard',
  'Drinking water', 'First aid', 'AC', 'CCTV', 'Seating area',
] as const;
export const AVAILABLE_DAYS = ['everyday', 'weekdays', 'weekends', 'custom'] as const;
export const WEEKDAYS = ['mon', 'tue', 'wed', 'thu', 'fri', 'sat', 'sun'] as const;

export const oneOf = <T extends readonly [string, ...string[]]>(values: T, label: string) =>
  z.enum(values, {
    error: (issue) =>
      issue.input === undefined ? 'This field is required' : `${label} must be one of: ${values.join(', ')}`,
  });

const uniqueList = <T extends z.ZodType>(item: T, max: number, label: string) =>
  z.array(item).max(max, `At most ${max} ${label}`)
    .refine((list) => new Set(list).size === list.length, `${label} must not repeat`);

export const hour = (min: number, max: number, label: string) =>
  z.number().int(`${label} must be a whole hour`).min(min, `${label} must be ${min}–${max}`).max(max, `${label} must be ${min}–${max}`);

const optionalText = (max: number) => z.string().trim().max(max).nullable().optional();

const GroundFields = z.object({
  name: z.string().trim().min(1, 'Enter a name').max(100),
  description: optionalText(2000),
  address: optionalText(300),
  /** https map link; "" or null clears it. */
  mapUrl: z.union([z.literal('').transform(() => null), httpsUrl.max(500, 'Keep it under 500 characters')]).nullable().optional(),
  /** Smallest currency unit, e.g. 1500 = 15.00. */
  hourlyPrice: z.number().int('Price must be a whole number of the smallest unit').min(1, 'Price must be above 0').max(10_000_000),
  openingHour: hour(0, 23, 'Opening hour'),
  closingHour: hour(1, 24, 'Closing hour'),
  isActive: z.boolean('isActive must be true or false'),
  sport: oneOf(SPORTS, 'Sport'),
  format: oneOf(FORMATS, 'Format').nullable().optional(),
  surface: oneOf(SURFACES, 'Surface').nullable().optional(),
  dimensions: optionalText(50),
  capacity: z.number().int('Capacity must be a whole number').min(1, 'Capacity must be at least 1').max(1000).nullable().optional(),
  amenities: uniqueList(oneOf(AMENITIES, 'Amenity'), 10, 'amenities'),
  availableDays: oneOf(AVAILABLE_DAYS, 'Available days'),
  /** Only used when availableDays is `custom`; ignored (stored empty) otherwise. */
  customDays: uniqueList(oneOf(WEEKDAYS, 'Day'), 7, 'days'),
  showOnPortal: z.boolean('showOnPortal must be true or false'),
  internalNotes: optionalText(2000),
  /** Hourly price inside peakRanges. When set, hourlyPrice is the off-peak price. */
  peakPrice: z.number().int('Peak price must be a whole number of the smallest unit').min(1, 'Peak price must be above 0').max(10_000_000).nullable(),
  peakRanges: z.array(
    z.object({ fromHour: hour(0, 23, 'Peak start'), toHour: hour(1, 24, 'Peak end') })
      .refine((r) => r.fromHour < r.toHour, { path: ['toHour'], message: 'Peak end must be after peak start' }),
  ).max(6, 'At most 6 peak ranges'),
  slotDurationMinutes: z.union([z.literal(60), z.literal(120)], 'Slot length must be 60 or 120 minutes'),
});

const opensBeforeCloses = (v: { openingHour?: number; closingHour?: number }) =>
  v.openingHour === undefined || v.closingHour === undefined || v.openingHour < v.closingHour;
const hoursRule = { path: ['closingHour'], message: 'Closing hour must be after opening hour' };

export const CreateGroundSchema = GroundFields.extend({
  isActive: GroundFields.shape.isActive.default(true),
  amenities: GroundFields.shape.amenities.default([]),
  availableDays: GroundFields.shape.availableDays.default('everyday'),
  customDays: GroundFields.shape.customDays.default([]),
  showOnPortal: GroundFields.shape.showOnPortal.default(true),
  peakPrice: GroundFields.shape.peakPrice.default(null),
  peakRanges: GroundFields.shape.peakRanges.default([]),
  slotDurationMinutes: GroundFields.shape.slotDurationMinutes.default(60),
}).refine(opensBeforeCloses, hoursRule);
export type CreateGroundInput = z.infer<typeof CreateGroundSchema>;

/**
 * Any subset of fields. Rules that span fields (hours, custom days, peak pricing) are checked by the service
 * against the stored ground, since the update may send only one side.
 */
export const UpdateGroundSchema = GroundFields.partial()
  .refine((v) => Object.keys(v).length > 0, 'Send at least one field to update')
  .refine(opensBeforeCloses, hoursRule);
export type UpdateGroundInput = z.infer<typeof UpdateGroundSchema>;

export const ListGroundsQuerySchema = PaginationSchema.extend({
  search: z.string().trim().max(100).optional(),
  sport: oneOf(SPORTS, 'Sport').optional(),
  format: oneOf(FORMATS, 'Format').optional(),
  surface: oneOf(SURFACES, 'Surface').optional(),
});
export type ListGroundsQuery = z.infer<typeof ListGroundsQuerySchema>;

export const AdminListGroundsQuerySchema = ListGroundsQuerySchema.extend({
  /** `?isActive=true|false`; omit for all. */
  isActive: z.enum(['true', 'false']).transform((v) => v === 'true').optional(),
});
export type AdminListGroundsQuery = z.infer<typeof AdminListGroundsQuerySchema>;
