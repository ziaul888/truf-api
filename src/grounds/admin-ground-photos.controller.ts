import { Body, Controller, Delete, Param, Post, Put, UploadedFile, UseGuards, UseInterceptors } from '@nestjs/common';
import { FileInterceptor } from '@nestjs/platform-express';
import { z } from 'zod';
import { AuthGuard, Roles } from '../auth/auth.guard.js';
import { ZodValidationPipe } from '../common/pipes/zod-validation.pipe.js';
import { IdParamSchema, type IdParam } from '../common/schemas.js';
import { GroundPhotosService, type UploadedPhoto } from './ground-photos.service.js';
import { MAX_PHOTOS, PHOTO_NAME } from './photo-storage.js';

const PhotoName = z.string().regex(PHOTO_NAME, 'Unknown photo');
const PhotoParamSchema = IdParamSchema.extend({ photo: PhotoName });
const ReorderSchema = z.object({ photos: z.array(PhotoName).max(MAX_PHOTOS) });

// Multer's own cap. Files between 2 MB and this get a clear 400 from the service; bigger ones a 413.
const UPLOAD_LIMIT_BYTES = 5 * 1024 * 1024;

/** Ground photos: admins only. The first photo is the cover. */
@Controller('admin/grounds/:id/photos')
@UseGuards(AuthGuard)
@Roles('admin')
export class AdminGroundPhotosController {
  constructor(private readonly photos: GroundPhotosService) {}

  /** multipart/form-data with one image in the `photo` field. */
  @Post()
  @UseInterceptors(FileInterceptor('photo', { limits: { fileSize: UPLOAD_LIMIT_BYTES, files: 1 } }))
  add(@Param(new ZodValidationPipe(IdParamSchema)) { id }: IdParam, @UploadedFile() file: UploadedPhoto | undefined) {
    return this.photos.add(id, file);
  }

  @Put()
  reorder(
    @Param(new ZodValidationPipe(IdParamSchema)) { id }: IdParam,
    @Body(new ZodValidationPipe(ReorderSchema)) { photos }: z.infer<typeof ReorderSchema>,
  ) {
    return this.photos.reorder(id, photos);
  }

  @Delete(':photo')
  remove(@Param(new ZodValidationPipe(PhotoParamSchema)) { id, photo }: z.infer<typeof PhotoParamSchema>) {
    return this.photos.remove(id, photo);
  }
}
