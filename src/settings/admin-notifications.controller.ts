import { Body, Controller, Get, HttpCode, Post, Put, Query, UseGuards } from '@nestjs/common';
import { Throttle } from '@nestjs/throttler';
import { AuthGuard, CurrentUser, Roles } from '../auth/auth.guard.js';
import type { AuthUser } from '../auth/auth.types.js';
import { ZodValidationPipe } from '../common/pipes/zod-validation.pipe.js';
import { PaginationSchema, type Pagination } from '../common/schemas.js';
import { NotificationSettingsService } from './notification-settings.service.js';
import { TestEmailSchema, UpdateNotificationsSchema, type TestEmailInput, type UpdateNotificationsInput } from './notifications.schemas.js';
import { UserThrottlerGuard } from './user-throttler.guard.js';

/** Settings → Notifications. Admins and managers read and test; admins save. */
@Controller('admin/settings/notifications')
@UseGuards(AuthGuard)
export class AdminNotificationsController {
  constructor(private readonly notifications: NotificationSettingsService) {}

  @Get()
  get() {
    return this.notifications.get();
  }

  @Put()
  @Roles('admin')
  update(@Body(new ZodValidationPipe(UpdateNotificationsSchema)) body: UpdateNotificationsInput, @CurrentUser() user: AuthUser) {
    return this.notifications.update(body, user.id);
  }

  /** To `to`, or the signed-in user. 5 an hour per user. */
  @Post('test')
  @HttpCode(200)
  @UseGuards(UserThrottlerGuard)
  @Throttle({ default: { limit: 5, ttl: 60 * 60_000 } })
  test(@Body(new ZodValidationPipe(TestEmailSchema)) { to }: TestEmailInput, @CurrentUser() user: AuthUser) {
    return this.notifications.sendTest(to ?? user.email);
  }

  /** Recent emails, newest first, with masked addresses. */
  @Get('log')
  log(@Query(new ZodValidationPipe(PaginationSchema)) { page, limit }: Pagination) {
    return this.notifications.log(page, limit);
  }
}
