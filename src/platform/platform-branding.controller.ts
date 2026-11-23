import {
  Body,
  Controller,
  Get,
  Logger,
  Put,
  UploadedFile,
  UseGuards,
  UseInterceptors,
} from '@nestjs/common';
import { FileInterceptor } from '@nestjs/platform-express';
import { z } from 'zod';
import { AppError } from '../common/app-error.js';
import { ZodValidationPipe } from '../common/pipes/zod-validation.pipe.js';
import { Prisma } from '../generated/prisma/client.js';
import { PrismaService } from '../prisma/prisma.service.js';
import {
  deleteImage,
  imageUrl,
  LOGO_RULES,
  saveImage,
  type UploadedImage,
} from '../settings/settings-images.js';
import { requirePlatformActor } from './platform-command.js';
import { PlatformOriginGuard } from './platform-origin.guard.js';
import type { PlatformActor } from './platform-session.js';
import { CurrentPlatformActor, PlatformGuard } from './platform.guard.js';

const key = 'platform.dashboard.branding';
const text = {
  title: z.string().trim().min(1, 'Enter a title').max(60),
  subtitle: z.string().trim().max(100),
};
const BrandingInputSchema = z.object({
  ...text,
  logoAction: z.enum(['keep', 'remove']).default('keep'),
});
type BrandingInput = z.infer<typeof BrandingInputSchema>;

const StoredBrandingSchema = z.object({
  ...text,
  logo: z
    .string()
    .regex(/^[0-9a-f-]{36}\.(png|jpg)$/)
    .nullable(),
});

function brandingOf(data: unknown) {
  return (
    StoredBrandingSchema.safeParse(data).data ?? {
      title: 'SaaS Admin',
      subtitle: 'Platform administration',
      logo: null,
    }
  );
}

function toDto({ title, subtitle, logo }: ReturnType<typeof brandingOf>) {
  return { title, subtitle, logoUrl: logo ? imageUrl('platform', logo) : null };
}

@Controller('platform/branding')
export class PlatformBrandingController {
  private readonly logger = new Logger(PlatformBrandingController.name);

  constructor(private readonly db: PrismaService) {}

  @Get()
  async get() {
    const row = await this.db.systemState.findUnique({ where: { key } });
    return toDto(brandingOf(row?.data));
  }

  @Put()
  @UseGuards(PlatformGuard, PlatformOriginGuard)
  @UseInterceptors(
    FileInterceptor('logo', { limits: { fileSize: 1024 * 1024, files: 1 } }),
  )
  async save(
    @CurrentPlatformActor() actor: PlatformActor,
    @Body(new ZodValidationPipe(BrandingInputSchema))
    { title, subtitle, logoAction }: BrandingInput,
    @UploadedFile() file: UploadedImage | undefined,
  ) {
    if (file && logoAction === 'remove') {
      throw new AppError(
        'Choose whether to replace or remove the logo',
        400,
        'INVALID_LOGO_ACTION',
      );
    }
    const uploaded = file
      ? await saveImage('platform', file, LOGO_RULES)
      : null;
    const result = await this.db
      .$transaction(
        async (tx) => {
          await requirePlatformActor(tx, actor);
          const where = { key };
          const row = await tx.systemState.findUnique({ where });
          const previous = brandingOf(row?.data);
          const logo =
            uploaded ?? (logoAction === 'remove' ? null : previous.logo);
          const data = { title, subtitle, logo };
          await tx.systemState.upsert({
            where,
            create: { key, data },
            update: { data },
          });
          return { data, previousLogo: previous.logo };
        },
        { isolationLevel: 'Serializable' },
      )
      .catch(async (error: unknown) => {
        await this.removeFile(uploaded);
        if (
          error instanceof Prisma.PrismaClientKnownRequestError &&
          ['P2002', 'P2034'].includes(error.code)
        ) {
          throw new AppError(
            'Branding changed. Try saving again.',
            409,
            'PLATFORM_CONFLICT',
          );
        }
        throw error;
      });

    if (result.previousLogo !== result.data.logo)
      await this.removeFile(result.previousLogo);
    return toDto(result.data);
  }

  private async removeFile(name: string | null) {
    try {
      await deleteImage('platform', name);
    } catch (error) {
      this.logger.warn('Could not remove a platform logo file', error);
    }
  }
}
