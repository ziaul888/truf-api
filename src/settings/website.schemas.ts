import { z } from 'zod';
import { UPLOADS_ROUTE } from '../grounds/photo-storage.js';
import { httpsUrl, optionalUrl, text } from './settings-fields.js';

export const WEBSITE_IMAGE_SLOTS = ['hero', 'visit'] as const;
export type WebsiteImageSlot = (typeof WEBSITE_IMAGE_SLOTS)[number];

export const AMENITY_ICONS = ['parking', 'showers', 'lockers', 'cafe', 'wifi', 'firstAid', 'floodlights', 'seating', 'water', 'changing'] as const;

/** Files saved by the image upload endpoint. */
export const WEBSITE_UPLOAD = new RegExp(`^${UPLOADS_ROUTE}/website/[0-9a-f-]{36}\\.(jpg|png|webp)$`);

const imageSrc = z.union([z.string().regex(WEBSITE_UPLOAD), httpsUrl], 'Upload an image or enter a link starting with https://');

const VIDEO_MESSAGE = 'Use a direct link to an .mp4 or .webm file';

/** "" for none, else an https link straight to an .mp4 or .webm file (a query string is fine). YouTube and Vimeo page links are not video files. */
export const heroVideoUrl = z.string().trim().max(500, 'Keep it under 500 characters').refine((v) => {
  if (v === '') return true;
  try {
    return new URL(v).protocol === 'https:';
  } catch {
    return false;
  }
}, 'Enter a full URL starting with https://').refine((v) => {
  if (v === '') return true;
  try {
    return /\.(mp4|webm)$/i.test(new URL(v).pathname);
  } catch {
    return true; // already reported by the https check
  }
}, VIDEO_MESSAGE);

export const WebsiteHeroSchema = z.object({
  badge: text(40),
  headline: text(60, 'Add a headline'),
  description: text(280),
  imageUrl: imageSrc,
  // Default '' so a hero saved before this field existed still parses (else the whole section would reset) and an old frontend's PUT is accepted.
  videoUrl: heroVideoUrl.default(''),
});

/** One schema per homepage section; a PUT may send any of them, each in full. */
export const WEBSITE_SECTION_SCHEMAS = {
  sportChips: z.object({ enabled: z.boolean(), title: text(60, 'Add a title') }),
  featuredGrounds: z.object({ enabled: z.boolean(), title: text(60, 'Add a title'), subtitle: text(120) }),
  amenities: z.object({
    enabled: z.boolean(),
    title: text(60, 'Add a title'),
    subtitle: text(160),
    items: z.array(z.object({ icon: z.enum(AMENITY_ICONS), label: text(30, 'Add a label') }))
      .min(1, 'Add at least one amenity').max(12, 'Up to 12 amenities'),
  }),
  howItWorks: z.object({
    enabled: z.boolean(),
    badge: text(30),
    title: text(60, 'Add a title'),
    steps: z.array(z.object({ title: text(40, 'Add a step title'), body: text(200, 'Describe this step') })).length(3, 'Exactly 3 steps'),
    buttonLabel: text(30, 'Add the button text'),
  }),
  visitUs: z.object({ enabled: z.boolean(), badge: text(30), title: text(80, 'Add a title'), imageUrl: imageSrc }),
};

export const WebsiteSocialSchema = z.object({ facebook: optionalUrl, instagram: optionalUrl, whatsapp: optionalUrl });

export const WebsiteStoredSchema = z.object({
  hero: WebsiteHeroSchema,
  sections: z.object(WEBSITE_SECTION_SCHEMAS),
  social: WebsiteSocialSchema,
});
export type WebsiteStored = z.infer<typeof WebsiteStoredSchema>;

export const UpdateWebsiteSchema = z.object({
  hero: WebsiteHeroSchema.optional(),
  sections: z.object(WEBSITE_SECTION_SCHEMAS).partial().optional(),
  social: WebsiteSocialSchema.optional(),
}).refine((v) => Object.keys(v).length > 0, 'Send at least one part to update');
export type UpdateWebsiteInput = z.infer<typeof UpdateWebsiteSchema>;

export const WebsiteImageParamSchema = z.object({ slot: z.enum(WEBSITE_IMAGE_SLOTS, 'Image slot must be hero or visit') });
