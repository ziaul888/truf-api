import {
  Body,
  Controller,
  Get,
  HttpCode,
  Post,
  Put,
  UseGuards,
} from '@nestjs/common';
import { z } from 'zod';
import { ZodValidationPipe } from '../common/pipes/zod-validation.pipe.js';
import {
  AppearanceSchema,
  type Appearance,
} from '../settings/appearance.schemas.js';
import {
  ResetSettingsSchema,
  UpdateNotificationsSchema,
  type ResetSettingsInput,
  type UpdateNotificationsInput,
} from '../settings/notifications.schemas.js';
import {
  UpdateWebsiteSchema,
  type UpdateWebsiteInput,
} from '../settings/website.schemas.js';
import {
  UpdateSlotSettingsSchema,
  type UpdateSlotSettingsInput,
} from '../slots/slots.schemas.js';
import { RequirePlanFeature } from '../platform/platform-plan-features.js';
import { OwnerOriginGuard } from './owner-origin.guard.js';
import type { TenantOperator } from './owner-session.js';
import {
  CurrentOperator,
  TenantOperatorGuard,
} from './tenant-operator.guard.js';
import { TenantSettingsService } from './tenant-settings.service.js';

const PortalVisibilitySchema = z.object({ published: z.boolean() });

@Controller('owner/admin/settings')
@UseGuards(TenantOperatorGuard)
export class TenantSettingsController {
  constructor(private readonly settings: TenantSettingsService) {}

  @Post('reset')
  @HttpCode(200)
  @UseGuards(OwnerOriginGuard)
  reset(
    @CurrentOperator() operator: TenantOperator,
    @Body(new ZodValidationPipe(ResetSettingsSchema)) body: ResetSettingsInput,
  ) {
    return this.settings.reset(operator, body);
  }

  @Get('slots')
  getSlots(@CurrentOperator() operator: TenantOperator) {
    return this.settings.slots(operator);
  }

  @Put('slots')
  @UseGuards(OwnerOriginGuard)
  saveSlots(
    @CurrentOperator() operator: TenantOperator,
    @Body(new ZodValidationPipe(UpdateSlotSettingsSchema))
    body: UpdateSlotSettingsInput,
  ) {
    return this.settings.slots(operator, body);
  }

  @Get('appearance')
  getAppearance(@CurrentOperator() operator: TenantOperator) {
    return this.settings.appearance(operator);
  }

  @Put('appearance')
  @UseGuards(OwnerOriginGuard)
  saveAppearance(
    @CurrentOperator() operator: TenantOperator,
    @Body(new ZodValidationPipe(AppearanceSchema)) input: Appearance,
  ) {
    return this.settings.appearance(operator, input);
  }

  @Get('payments/status')
  payments(@CurrentOperator() operator: TenantOperator) {
    return this.settings.payments(operator);
  }

  @Get('website')
  @RequirePlanFeature('website')
  getWebsite(@CurrentOperator() operator: TenantOperator) {
    return this.settings.website(operator);
  }

  @Put('website')
  @RequirePlanFeature('website')
  @UseGuards(OwnerOriginGuard)
  saveWebsite(
    @CurrentOperator() operator: TenantOperator,
    @Body(new ZodValidationPipe(UpdateWebsiteSchema)) body: UpdateWebsiteInput,
  ) {
    return this.settings.website(operator, body);
  }

  @Get('website/portal')
  @RequirePlanFeature('website')
  getPortal(@CurrentOperator() operator: TenantOperator) {
    return this.settings.portal(operator);
  }

  @Put('website/portal')
  @RequirePlanFeature('website')
  @UseGuards(OwnerOriginGuard)
  savePortal(
    @CurrentOperator() operator: TenantOperator,
    @Body(new ZodValidationPipe(PortalVisibilitySchema))
    { published }: z.infer<typeof PortalVisibilitySchema>,
  ) {
    return this.settings.portal(operator, published);
  }

  @Get('notifications')
  getNotifications(@CurrentOperator() operator: TenantOperator) {
    return this.settings.notifications(operator);
  }

  @Put('notifications')
  @UseGuards(OwnerOriginGuard)
  saveNotifications(
    @CurrentOperator() operator: TenantOperator,
    @Body(new ZodValidationPipe(UpdateNotificationsSchema))
    body: UpdateNotificationsInput,
  ) {
    return this.settings.notifications(operator, body);
  }
}
