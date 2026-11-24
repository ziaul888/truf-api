import {
  Body,
  Controller,
  Delete,
  Param,
  Post,
  Put,
  UploadedFile,
  UseGuards,
  UseInterceptors,
} from '@nestjs/common';
import { AuthGuard, Roles } from '../auth/auth.guard.js';
import { ZodValidationPipe } from '../common/pipes/zod-validation.pipe.js';
import { IdParamSchema, type IdParam } from '../common/schemas.js';
import {
  GroundPhotosService,
  type UploadedPhoto,
} from './ground-photos.service.js';
import {
  GroundPhotoOrderSchema,
  GroundPhotoParamSchema,
  GroundPhotoUpload,
  type GroundPhotoOrder,
  type GroundPhotoParam,
} from './ground-photo-input.js';

/** Ground photos: admins only. The first photo is the cover. */
@Controller('admin/grounds/:id/photos')
@UseGuards(AuthGuard)
@Roles('admin')
export class AdminGroundPhotosController {
  constructor(private readonly photos: GroundPhotosService) {}

  /** multipart/form-data with one image in the `photo` field. */
  @Post()
  @UseInterceptors(GroundPhotoUpload)
  add(
    @Param(new ZodValidationPipe(IdParamSchema)) { id }: IdParam,
    @UploadedFile() file: UploadedPhoto | undefined,
  ) {
    return this.photos.add(id, file);
  }

  @Put()
  reorder(
    @Param(new ZodValidationPipe(IdParamSchema)) { id }: IdParam,
    @Body(new ZodValidationPipe(GroundPhotoOrderSchema))
    { photos }: GroundPhotoOrder,
  ) {
    return this.photos.reorder(id, photos);
  }

  @Delete(':photo')
  remove(
    @Param(new ZodValidationPipe(GroundPhotoParamSchema))
    { id, photo }: GroundPhotoParam,
  ) {
    return this.photos.remove(id, photo);
  }
}
