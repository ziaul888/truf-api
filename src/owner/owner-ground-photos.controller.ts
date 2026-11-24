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
import { ZodValidationPipe } from '../common/pipes/zod-validation.pipe.js';
import { IdParamSchema, type IdParam } from '../common/schemas.js';
import {
  GroundPhotoOrderSchema,
  GroundPhotoParamSchema,
  GroundPhotoUpload,
  type GroundPhotoOrder,
  type GroundPhotoParam,
} from '../grounds/ground-photo-input.js';
import {
  GroundPhotosService,
  type UploadedPhoto,
} from '../grounds/ground-photos.service.js';
import { OwnerOriginGuard } from './owner-origin.guard.js';
import type { TenantOperator } from './owner-session.js';
import { TenantDashboardDatabase } from './tenant-dashboard-database.service.js';
import {
  CurrentOperator,
  TenantOperatorGuard,
} from './tenant-operator.guard.js';

@Controller('owner/admin/grounds/:id/photos')
@UseGuards(TenantOperatorGuard, OwnerOriginGuard)
export class OwnerGroundPhotosController {
  constructor(
    private readonly photos: GroundPhotosService,
    private readonly dashboard: TenantDashboardDatabase,
  ) {}

  @Post()
  @UseInterceptors(GroundPhotoUpload)
  add(
    @CurrentOperator() operator: TenantOperator,
    @Param(new ZodValidationPipe(IdParamSchema)) { id }: IdParam,
    @UploadedFile() file: UploadedPhoto | undefined,
  ) {
    return this.dashboard.runForAdmin(operator.session, () =>
      this.photos.add(id, file),
    );
  }

  @Put()
  reorder(
    @CurrentOperator() operator: TenantOperator,
    @Param(new ZodValidationPipe(IdParamSchema)) { id }: IdParam,
    @Body(new ZodValidationPipe(GroundPhotoOrderSchema))
    { photos }: GroundPhotoOrder,
  ) {
    return this.dashboard.runForAdmin(operator.session, () =>
      this.photos.reorder(id, photos),
    );
  }

  @Delete(':photo')
  remove(
    @CurrentOperator() operator: TenantOperator,
    @Param(new ZodValidationPipe(GroundPhotoParamSchema))
    { id, photo }: GroundPhotoParam,
  ) {
    return this.dashboard.runForAdmin(operator.session, () =>
      this.photos.remove(id, photo),
    );
  }
}
