import {
  Body,
  Controller,
  Get,
  HttpCode,
  Post,
  Req,
  Res,
  UseGuards,
} from '@nestjs/common';
import type { Request, Response } from 'express';
import { LoginSchema, type LoginInput } from '../auth/auth.schemas.js';
import { LoginThrottlerGuard } from '../auth/login-throttler.guard.js';
import { env } from '../config/env.js';
import { ZodValidationPipe } from '../common/pipes/zod-validation.pipe.js';
import { PlatformAuthService } from './platform-auth.service.js';
import { PlatformGuard, CurrentPlatformUser } from './platform.guard.js';
import { PlatformOriginGuard } from './platform-origin.guard.js';
import {
  PLATFORM_COOKIE,
  platformCookieOptions,
  type PlatformUser,
} from './platform-session.js';

@Controller('platform/auth')
export class PlatformAuthController {
  constructor(private readonly auth: PlatformAuthService) {}

  @Post('login')
  @HttpCode(200)
  @UseGuards(PlatformOriginGuard, LoginThrottlerGuard)
  async login(
    @Body(new ZodValidationPipe(LoginSchema)) body: LoginInput,
    @Res({ passthrough: true }) res: Response,
  ) {
    const { user, token } = await this.auth.login(body);
    res.cookie(PLATFORM_COOKIE, token, {
      ...platformCookieOptions(),
      maxAge: env.JWT_TTL_HOURS * 60 * 60 * 1000,
    });
    return user;
  }

  @Get('me')
  @UseGuards(PlatformGuard)
  me(@CurrentPlatformUser() user: PlatformUser) {
    return user;
  }

  @Post('logout')
  @HttpCode(200)
  @UseGuards(PlatformOriginGuard)
  async logout(@Req() req: Request, @Res({ passthrough: true }) res: Response) {
    await this.auth.logout(req.cookies?.[PLATFORM_COOKIE]);
    res.clearCookie(PLATFORM_COOKIE, platformCookieOptions());
    return { loggedOut: true };
  }
}
