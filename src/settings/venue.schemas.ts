import { z } from 'zod';
import { optionalUrl, text } from './settings-fields.js';

const fields = {
  name: z.string().trim().min(2, 'Add the venue name').max(60, 'Keep it under 60 characters'),
  tagline: text(40),
  phone: z.string().trim().min(10, 'Enter a valid phone number').max(20, 'Enter a valid phone number'),
  email: z.email('Enter a valid email'),
  /** Null: use `email`. */
  supportEmail: z.email('Enter a valid email').nullable(),
  address: z.string().trim().min(5, 'Add the full address').max(160, 'Keep it under 160 characters'),
  /** Free text for the website; each ground has its own real hours. */
  openHours: text(40, 'Add opening hours'),
  mapUrl: optionalUrl,
  websiteUrl: optionalUrl,
};

/** Blank until an admin enters them on Settings → General (the defaults carry no contact details). */
const unset = <T extends z.ZodType>(field: T) => z.union([z.literal(''), field]);

/** What's stored. `logo` is the uploaded file's name (set by the upload endpoint only). */
export const VenueStoredSchema = z.object({
  ...fields,
  phone: unset(fields.phone), email: unset(fields.email), address: unset(fields.address), openHours: unset(fields.openHours),
  logo: z.string().nullable(),
});
export type VenueStored = z.infer<typeof VenueStoredSchema>;

export const UpdateVenueSchema = z.object(fields).partial()
  .refine((v) => Object.keys(v).length > 0, 'Send at least one field to update');
export type UpdateVenueInput = z.infer<typeof UpdateVenueSchema>;

/** Until an admin saves General: a name only, so the portal shows no made-up contact details. */
export const DEFAULT_VENUE: VenueStored = {
  name: 'Champions Turf',
  tagline: '',
  phone: '',
  email: '',
  supportEmail: null,
  address: '',
  openHours: '',
  mapUrl: '',
  websiteUrl: '',
  logo: null,
};
