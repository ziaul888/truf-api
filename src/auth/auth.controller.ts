import { Body, Controller, Get, HttpCode, Post, Req, Res, UseGuards } from '@nestjs/common';
import type { Request, Response } from 'express';
import { ZodValidationPipe } from '../common/pipes/zod-validation.pipe.js';
import { AUTH_COOKIE, authCookieOptions, clearAuthCookieOptions } from './auth-cookie.js';
import { AuthGuard, CurrentUser } from './auth.guard.js';
import { ChangePasswordSchema, LoginSchema, type ChangePasswordInput, type LoginInput } from './auth.schemas.js';
import { AuthService } from './auth.service.js';
import type { AuthUser } from './auth.types.js';
import { LoginThrottlerGuard } from './login-throttler.guard.js';
import { PermissionsService } from './permissions.service.js';

@Controller('admin/auth')
export class AuthController {
  constructor(
    private readonly auth: AuthService,
    private readonly permissions: PermissionsService,
  ) {}

  @Post('login')
  @HttpCode(200)
  @UseGuards(LoginThrottlerGuard)
  async login(
    @Body(new ZodValidationPipe(LoginSchema)) body: LoginInput,
    @Res({ passthrough: true }) res: Response,
  ): Promise<AuthUser> {
    const { user, token } = await this.auth.login(body);
    res.cookie(AUTH_COOKIE, token, authCookieOptions());
    return user;
  }

  /** No guard: it must work even with an expired token. Signs the user out on every device. */
  @Post('logout')
  @HttpCode(200)
  async logout(@Req() req: Request, @Res({ passthrough: true }) res: Response) {
    await this.auth.logout(req.cookies?.[AUTH_COOKIE]);
    res.clearCookie(AUTH_COOKIE, clearAuthCookieOptions());
    return { loggedOut: true };
  }

  @Get('me')
  @UseGuards(AuthGuard)
  me(@CurrentUser() user: AuthUser): AuthUser {
    return user;
  }

  /** `{ admin: ["GET /admin/bookings", …], manager: [...] }`, generated from the route guards. */
  @Get('permissions')
  @UseGuards(AuthGuard)
  listPermissions() {
    return this.permissions.list();
  }

  /** Any signed-in user. Keeps this session, signs out the others. */
  @Post('change-password')
  @HttpCode(200)
  @UseGuards(AuthGuard)
  async changePassword(
    @CurrentUser() user: AuthUser,
    @Body(new ZodValidationPipe(ChangePasswordSchema)) body: ChangePasswordInput,
    @Res({ passthrough: true }) res: Response,
  ) {
    const token = await this.auth.changePassword(user.id, body);
    res.cookie(AUTH_COOKIE, token, authCookieOptions());
    return { passwordChanged: true };
  }
}
