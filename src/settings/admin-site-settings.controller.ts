import { Body, Controller, Delete, Get, Param, Post, Put, UploadedFile, UseGuards, UseInterceptors } from '@nestjs/common';
import { FileInterceptor } from '@nestjs/platform-express';
import { AuthGuard, CurrentUser, Roles } from '../auth/auth.guard.js';
import type { AuthUser } from '../auth/auth.types.js';
import { ZodValidationPipe } from '../common/pipes/zod-validation.pipe.js';
import type { UploadedImage } from './settings-images.js';
import { UpdateVenueSchema, type UpdateVenueInput } from './venue.schemas.js';
import { VenueSettingsService } from './venue-settings.service.js';
import { UpdateWebsiteSchema, WebsiteImageParamSchema, type UpdateWebsiteInput, type WebsiteImageSlot } from './website.schemas.js';
import { WebsiteSettingsService } from './website-settings.service.js';

// Multer's own caps. Files between the real limit and these get a clear 400; bigger ones a 413.
const upload = (field: string, maxBytes: number) => FileInterceptor(field, { limits: { fileSize: maxBytes, files: 1 } });

/** Settings → General (the venue profile) and Website. Admins and managers read; admins save. */
@Controller('admin/settings')
@UseGuards(AuthGuard)
export class AdminSiteSettingsController {
  constructor(
    private readonly venue: VenueSettingsService,
    private readonly website: WebsiteSettingsService,
  ) {}

  @Get('venue')
  getVenue() {
    return this.venue.get();
  }

  @Put('venue')
  @Roles('admin')
  updateVenue(@Body(new ZodValidationPipe(UpdateVenueSchema)) body: UpdateVenueInput, @CurrentUser() user: AuthUser) {
    return this.venue.update(body, user.id);
  }

  /** multipart/form-data, field `logo`: PNG or JPG, 200 KB at most. */
  @Post('venue/logo')
  @Roles('admin')
  @UseInterceptors(upload('logo', 1024 * 1024))
  uploadLogo(@UploadedFile() file: UploadedImage | undefined, @CurrentUser() user: AuthUser) {
    return this.venue.uploadLogo(file, user.id);
  }

  @Delete('venue/logo')
  @Roles('admin')
  removeLogo(@CurrentUser() user: AuthUser) {
    return this.venue.removeLogo(user.id);
  }

  @Get('website')
  getWebsite() {
    return this.website.get();
  }

  @Put('website')
  @Roles('admin')
  updateWebsite(@Body(new ZodValidationPipe(UpdateWebsiteSchema)) body: UpdateWebsiteInput, @CurrentUser() user: AuthUser) {
    return this.website.update(body, user.id);
  }

  /** `:slot` is `hero` or `visit`. multipart/form-data, field `image`: JPG, PNG or WEBP, 2 MB at most. */
  @Post('website/images/:slot')
  @Roles('admin')
  @UseInterceptors(upload('image', 5 * 1024 * 1024))
  uploadImage(
    @Param(new ZodValidationPipe(WebsiteImageParamSchema)) { slot }: { slot: WebsiteImageSlot },
    @UploadedFile() file: UploadedImage | undefined,
    @CurrentUser() user: AuthUser,
  ) {
    return this.website.uploadImage(slot, file, user.id);
  }
}
