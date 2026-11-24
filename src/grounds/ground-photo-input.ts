import { FileInterceptor } from '@nestjs/platform-express';
import { z } from 'zod';
import { IdParamSchema } from '../common/schemas.js';
import { MAX_PHOTOS, PHOTO_NAME } from './photo-storage.js';

const PhotoName = z.string().regex(PHOTO_NAME, 'Unknown photo');
export const GroundPhotoParamSchema = IdParamSchema.extend({
  photo: PhotoName,
});
export const GroundPhotoOrderSchema = z.object({
  photos: z.array(PhotoName).max(MAX_PHOTOS),
});
export type GroundPhotoParam = z.infer<typeof GroundPhotoParamSchema>;
export type GroundPhotoOrder = z.infer<typeof GroundPhotoOrderSchema>;

export const GroundPhotoUpload = FileInterceptor('photo', {
  limits: { fileSize: 5 * 1024 * 1024, files: 1 },
});
