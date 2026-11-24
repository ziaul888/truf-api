import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  Param,
  Patch,
  Post,
  Put,
  Query,
  Res,
  UploadedFile,
  UseGuards,
  UseInterceptors,
} from '@nestjs/common';
import { FileInterceptor } from '@nestjs/platform-express';
import type { Response } from 'express';
import { z } from 'zod';
import {
  ChangePasswordSchema,
  type ChangePasswordInput,
} from '../auth/auth.schemas.js';
import { PermissionsService } from '../auth/permissions.service.js';
import { ZodValidationPipe } from '../common/pipes/zod-validation.pipe.js';
import { IdParamSchema, type IdParam } from '../common/schemas.js';
import {
  AdminListGroundsQuerySchema,
  CreateGroundSchema,
  UpdateGroundSchema,
  type AdminListGroundsQuery,
  type CreateGroundInput,
  type UpdateGroundInput,
} from '../grounds/grounds.schemas.js';
import type { UploadedImage } from '../settings/settings-images.js';
import {
  CompleteVenueSchema,
  type CompleteVenueInput,
} from '../settings/venue.schemas.js';
import {
  CalendarQuerySchema,
  GenerateSlotsSchema,
  ListSlotsQuerySchema,
  type CalendarQuery,
  type GenerateSlotsInput,
  type ListSlotsQuery,
} from '../slots/slots.schemas.js';
import { OwnerGroundsService } from './owner-grounds.service.js';
import { OwnerOriginGuard } from './owner-origin.guard.js';
import { OwnerAuthService } from './owner-auth.service.js';
import {
  OWNER_COOKIE,
  ownerCookieOptions,
  type TenantOperator,
} from './owner-session.js';
import { OwnerSlotsService } from './owner-slots.service.js';
import { OwnerVenueService } from './owner-venue.service.js';
import { assertTurfAvailable } from './owner-venue.js';
import {
  CurrentOperator,
  TenantOperatorGuard,
} from './tenant-operator.guard.js';

const CreateTurfGroundSchema = CreateGroundSchema.safeExtend({
  showOnPortal: z.boolean().default(false),
});

@Controller('owner/admin')
@UseGuards(TenantOperatorGuard)
export class OwnerOperationsController {
  constructor(
    private readonly venue: OwnerVenueService,
    private readonly grounds: OwnerGroundsService,
    private readonly slots: OwnerSlotsService,
    private readonly auth: OwnerAuthService,
    private readonly rolePermissions: PermissionsService,
  ) {}

  @Get('session')
  session(@CurrentOperator() operator: TenantOperator) {
    return operator.user;
  }

  @Post('auth/change-password')
  @HttpCode(200)
  @UseGuards(OwnerOriginGuard)
  async changePassword(
    @CurrentOperator() operator: TenantOperator,
    @Body(new ZodValidationPipe(ChangePasswordSchema))
    input: ChangePasswordInput,
    @Res({ passthrough: true }) response: Response,
  ) {
    const { token } = await this.auth.changePassword(operator.session, input);
    response.cookie(OWNER_COOKIE, token, ownerCookieOptions());
    return { passwordChanged: true };
  }

  @Get('auth/permissions')
  permissions(@CurrentOperator() operator: TenantOperator) {
    assertTurfAvailable(operator);
    const shared = this.rolePermissions.list(true);
    const manager = [
      ...shared.manager,
      'POST /admin/auth/change-password',
      'GET /admin/dashboard/stats',
      'GET /admin/dashboard/today',
      'GET /admin/grounds',
      'GET /admin/grounds/:id',
      'GET /admin/slots',
      'GET /admin/slots/calendar',
      'GET /admin/settings/venue',
      'GET /admin/settings/slots',
      'GET /admin/settings/website',
      'GET /admin/settings/website/portal',
      'GET /admin/settings/payments/status',
      'GET /admin/settings/notifications',
    ];
    const admin = [
      ...manager,
      'POST /admin/grounds',
      'PATCH /admin/grounds/:id',
      'POST /admin/slots/generate',
      'PUT /admin/settings/venue',
      'PUT /admin/settings/slots',
      'PUT /admin/settings/website',
      'PUT /admin/settings/website/portal',
      'PUT /admin/settings/notifications',
      'GET /admin/users',
      'POST /admin/users',
      'PATCH /admin/users/:id',
      'POST /admin/users/:id/reset-password',
      'POST /admin/settings/reset',
    ];
    return {
      admin: [...new Set([...admin, ...shared.admin])].sort(),
      manager: manager.sort(),
    };
  }

  @Get('settings/venue')
  getVenue(@CurrentOperator() owner: TenantOperator) {
    return this.venue.get(owner);
  }

  @Put('settings/venue')
  @UseGuards(OwnerOriginGuard)
  saveVenue(
    @CurrentOperator() owner: TenantOperator,
    @Body(new ZodValidationPipe(CompleteVenueSchema)) body: CompleteVenueInput,
  ) {
    return this.venue.update(owner.session, body);
  }

  @Post('settings/venue/logo')
  @UseGuards(OwnerOriginGuard)
  @UseInterceptors(
    FileInterceptor('logo', { limits: { fileSize: 1024 * 1024, files: 1 } }),
  )
  uploadLogo(
    @CurrentOperator() owner: TenantOperator,
    @UploadedFile() file: UploadedImage | undefined,
  ) {
    return this.venue.uploadLogo(owner, file);
  }

  @Delete('settings/venue/logo')
  @UseGuards(OwnerOriginGuard)
  removeLogo(@CurrentOperator() owner: TenantOperator) {
    return this.venue.removeLogo(owner.session);
  }

  @Get('grounds')
  listGrounds(
    @CurrentOperator() owner: TenantOperator,
    @Query(new ZodValidationPipe(AdminListGroundsQuerySchema))
    query: AdminListGroundsQuery,
  ) {
    return this.grounds.list(owner, query);
  }

  @Get('grounds/:id')
  getGround(
    @CurrentOperator() owner: TenantOperator,
    @Param(new ZodValidationPipe(IdParamSchema)) { id }: IdParam,
  ) {
    return this.grounds.get(owner, id);
  }

  @Post('grounds')
  @UseGuards(OwnerOriginGuard)
  createGround(
    @CurrentOperator() owner: TenantOperator,
    @Body(new ZodValidationPipe(CreateTurfGroundSchema)) body: CreateGroundInput,
  ) {
    return this.grounds.create(owner.session, body);
  }

  @Patch('grounds/:id')
  @UseGuards(OwnerOriginGuard)
  updateGround(
    @CurrentOperator() owner: TenantOperator,
    @Param(new ZodValidationPipe(IdParamSchema)) { id }: IdParam,
    @Body(new ZodValidationPipe(UpdateGroundSchema)) body: UpdateGroundInput,
  ) {
    return this.grounds.update(owner.session, id, body);
  }

  @Get('slots')
  listSlots(
    @CurrentOperator() owner: TenantOperator,
    @Query(new ZodValidationPipe(ListSlotsQuerySchema)) query: ListSlotsQuery,
  ) {
    return this.slots.list(owner, query);
  }

  @Get('dashboard/today')
  today(@CurrentOperator() owner: TenantOperator) {
    return this.slots.today(owner);
  }

  @Get('slots/calendar')
  calendar(
    @CurrentOperator() owner: TenantOperator,
    @Query(new ZodValidationPipe(CalendarQuerySchema)) query: CalendarQuery,
  ) {
    return this.slots.calendar(owner, query);
  }

  @Get('dashboard/stats')
  stats(@CurrentOperator() owner: TenantOperator) {
    return this.grounds.stats(owner);
  }

  @Post('slots/generate')
  @UseGuards(OwnerOriginGuard)
  generateSlots(
    @CurrentOperator() owner: TenantOperator,
    @Body(new ZodValidationPipe(GenerateSlotsSchema)) body: GenerateSlotsInput,
  ) {
    return this.slots.generate(owner.session, body);
  }
}
