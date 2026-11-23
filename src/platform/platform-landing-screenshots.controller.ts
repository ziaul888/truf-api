import {
  Controller,
  Delete,
  Get,
  Logger,
  Param,
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
  saveImage,
  type UploadedImage,
  WEBSITE_IMAGE_RULES,
} from '../settings/settings-images.js';
import { requirePlatformActor } from './platform-command.js';
import { PlatformOriginGuard } from './platform-origin.guard.js';
import type { PlatformActor } from './platform-session.js';
import { CurrentPlatformActor, PlatformGuard } from './platform.guard.js';

const SlotParamSchema = z.object({ slot: z.enum(['desktop', 'phone']) });
type SlotParam = z.infer<typeof SlotParamSchema>;

const screenshotKey = (slot: SlotParam['slot']) =>
  'platform.landing.screenshot.' + slot;
const StoredScreenshotSchema = z.object({
  filename: z
    .string()
    .regex(/^[0-9a-f-]{36}\.(jpg|png|webp)$/)
    .nullable(),
});
const filenameOf = (data: unknown) =>
  StoredScreenshotSchema.safeParse(data).data?.filename ?? null;

@Controller('platform/landing-screenshots')
export class PlatformLandingScreenshotsController {
  private readonly logger = new Logger(
    PlatformLandingScreenshotsController.name,
  );

  constructor(private readonly db: PrismaService) {}

  @Get()
  async list() {
    const slots = SlotParamSchema.shape.slot.options;
    const rows = await this.db.systemState.findMany({
      where: { key: { in: slots.map(screenshotKey) } },
    });
    return Object.fromEntries(
      slots.map((slot) => {
        const filename = filenameOf(
          rows.find((row) => row.key === screenshotKey(slot))?.data,
        );
        return [slot, filename ? imageUrl('saas', filename) : null];
      }),
    );
  }

  @Put(':slot')
  @UseGuards(PlatformGuard, PlatformOriginGuard)
  @UseInterceptors(
    FileInterceptor('image', {
      limits: { fileSize: WEBSITE_IMAGE_RULES.maxBytes, files: 1 },
    }),
  )
  async replace(
    @CurrentPlatformActor() actor: PlatformActor,
    @Param(new ZodValidationPipe(SlotParamSchema)) { slot }: SlotParam,
    @UploadedFile() file: UploadedImage | undefined,
  ) {
    const filename = await saveImage('saas', file, WEBSITE_IMAGE_RULES);
    return this.save(actor, slot, filename);
  }

  @Delete(':slot')
  @UseGuards(PlatformGuard, PlatformOriginGuard)
  restore(
    @CurrentPlatformActor() actor: PlatformActor,
    @Param(new ZodValidationPipe(SlotParamSchema)) { slot }: SlotParam,
  ) {
    return this.save(actor, slot, null);
  }

  private async save(
    actor: PlatformActor,
    slot: SlotParam['slot'],
    filename: string | null,
  ) {
    const key = screenshotKey(slot);
    const previous = await this.db
      .$transaction(
        async (tx) => {
          await requirePlatformActor(tx, actor);
          const where = { key };
          const row = await tx.systemState.findUnique({ where });
          const data = { filename };
          await tx.systemState.upsert({
            where,
            update: { data },
            create: { key, data },
          });
          return filenameOf(row?.data);
        },
        { isolationLevel: 'Serializable' },
      )
      .catch(async (error: unknown) => {
        await this.removeFile(filename);
        if (
          error instanceof Prisma.PrismaClientKnownRequestError &&
          ['P2002', 'P2034'].includes(error.code)
        ) {
          throw new AppError(
            'This screenshot changed. Try saving again.',
            409,
            'PLATFORM_CONFLICT',
          );
        }
        throw error;
      });

    if (previous !== filename) await this.removeFile(previous);
    return { imageUrl: filename ? imageUrl('saas', filename) : null };
  }

  private async removeFile(filename: string | null) {
    try {
      await deleteImage('saas', filename);
    } catch (error) {
      this.logger.warn('Could not remove a landing screenshot file', error);
    }
  }
}
