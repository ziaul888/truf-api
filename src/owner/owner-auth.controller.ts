import {
  Controller,
  Get,
  Post,
  Body,
  HttpCode,
  Req,
  Res,
  UseGuards,
} from '@nestjs/common';
import type { Request, Response } from 'express';
import { ThrottlerGuard } from '@nestjs/throttler';
import { ZodValidationPipe } from '../common/pipes/zod-validation.pipe.js';
import { OwnerAuthService } from './owner-auth.service.js';
import { OwnerActivationService } from './owner-activation.service.js';
import {
  OWNER_COOKIE,
  ownerCookieOptions,
  type OwnerContext,
} from './owner-session.js';
import { OwnerGuard, CurrentOwner } from './owner.guard.js';
import { OwnerOriginGuard } from './owner-origin.guard.js';
import {
  PreviewOwnerInvitationSchema,
  AcceptOwnerInvitationSchema,
  type AcceptOwnerInvitation,
} from './owner-activation.schemas.js';
@Controller('owner')
export class OwnerAuthController {
  constructor(
    private readonly auth: OwnerAuthService,
    private readonly activation: OwnerActivationService,
  ) {}
  @Get('auth/me') @UseGuards(OwnerGuard) me(
    @CurrentOwner() owner: OwnerContext,
  ) {
    return owner.user;
  }
  @Post('auth/logout')
  @HttpCode(200)
  @UseGuards(OwnerOriginGuard)
  async logout(@Req() req: Request, @Res({ passthrough: true }) res: Response) {
    await this.auth.logout(req.cookies?.[OWNER_COOKIE]);
    res.clearCookie(OWNER_COOKIE, ownerCookieOptions());
    return { loggedOut: true };
  }
  @Post('activation/preview')
  @HttpCode(200)
  @UseGuards(OwnerOriginGuard, ThrottlerGuard)
  preview(
    @Body(new ZodValidationPipe(PreviewOwnerInvitationSchema))
    input: {
      token: string;
    },
  ) {
    return this.activation.preview(input.token);
  }
  @Post('activation/accept')
  @HttpCode(200)
  @UseGuards(OwnerOriginGuard, ThrottlerGuard)
  accept(
    @Body(new ZodValidationPipe(AcceptOwnerInvitationSchema))
    input: AcceptOwnerInvitation,
  ) {
    return this.activation.accept(input);
  }
}
