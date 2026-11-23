import { z } from 'zod';

export const AppearanceSchema = z.object({
  accentColor: z
    .string()
    .regex(/^#[0-9a-f]{6}$/i, 'Enter a six-digit hex color')
    .toUpperCase()
    .nullable(),
});

export type Appearance = z.infer<typeof AppearanceSchema>;

export function storedAppearance(data: unknown): Appearance {
  return AppearanceSchema.safeParse(data).data ?? { accentColor: null };
}
