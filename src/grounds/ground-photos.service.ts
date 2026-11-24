import { Injectable, Logger } from '@nestjs/common';
import { AppError } from '../common/app-error.js';
import { Prisma, type Ground } from '../generated/prisma/client.js';
import { PrismaService } from '../prisma/prisma.service.js';
import { toGroundDto, type GroundDto } from './ground.dto.js';
import {
  deletePhoto,
  detectImageType,
  MAX_PHOTO_BYTES,
  MAX_PHOTOS,
  newPhotoName,
  savePhoto,
} from './photo-storage.js';

/** The parts of an uploaded file we use (Multer's file object has more). */
export interface UploadedPhoto {
  buffer: Buffer;
  size: number;
}

const photoError = (message: string, code: string, status = 400) =>
  new AppError(message, status, code);

@Injectable()
export class GroundPhotosService {
  private readonly logger = new Logger(GroundPhotosService.name);

  constructor(private readonly prisma: PrismaService) {}

  async add(
    groundId: string,
    file: UploadedPhoto | undefined,
  ): Promise<GroundDto> {
    if (!file)
      throw photoError(
        'Attach an image in the "photo" field',
        'PHOTO_REQUIRED',
      );
    const ground = await this.findOrThrow(groundId);
    if (ground.photos.length >= MAX_PHOTOS) {
      throw photoError(
        `A ground can have at most ${MAX_PHOTOS} photos`,
        'TOO_MANY_PHOTOS',
      );
    }
    if (file.size > MAX_PHOTO_BYTES)
      throw photoError('Photos must be 2 MB or smaller', 'PHOTO_TOO_LARGE');
    const type = detectImageType(file.buffer);
    if (!type)
      throw photoError(
        'Photos must be JPG or PNG images',
        'INVALID_PHOTO_TYPE',
      );

    const name = newPhotoName(type);
    await savePhoto(groundId, name, file.buffer);
    try {
      return await this.updatePhotos(ground, [...ground.photos, name]);
    } catch (err) {
      await this.removeFile(groundId, name);
      throw err;
    }
  }

  async remove(groundId: string, name: string): Promise<GroundDto> {
    const ground = await this.findOrThrow(groundId);
    if (!ground.photos.includes(name))
      throw photoError('Photo not found', 'PHOTO_NOT_FOUND', 404);

    const updated = await this.updatePhotos(
      ground,
      ground.photos.filter((p) => p !== name),
    );
    await this.removeFile(groundId, name);
    return updated;
  }

  /** `order` must list exactly the ground's current photos, in the new order. */
  async reorder(groundId: string, order: string[]): Promise<GroundDto> {
    const ground = await this.findOrThrow(groundId);
    const samePhotos =
      order.length === ground.photos.length &&
      ground.photos.every((p) => order.includes(p));
    if (!samePhotos) {
      throw photoError(
        'Send every current photo exactly once, in the new order',
        'INVALID_PHOTO_ORDER',
      );
    }
    return this.updatePhotos(ground, order);
  }

  private async updatePhotos(
    ground: Ground,
    photos: string[],
  ): Promise<GroundDto> {
    // The old list is part of the write condition, so simultaneous requests
    // cannot overwrite another upload or exceed the limit.
    const existing = { photos: { equals: ground.photos } };
    const where: Prisma.GroundWhereUniqueInput = {
      id: ground.id,
      ...(ground.photos.length
        ? existing
        : { OR: [existing, { photos: { equals: null } }] }),
    };
    try {
      return toGroundDto(
        await this.prisma.ground.update({ where, data: { photos } }),
      );
    } catch (error) {
      if (
        error instanceof Prisma.PrismaClientKnownRequestError &&
        error.code === 'P2025'
      )
        throw photoError(
          'Ground photos changed. Try saving again.',
          'PHOTO_CONFLICT',
          409,
        );
      throw error;
    }
  }

  private async removeFile(groundId: string, name: string): Promise<void> {
    try {
      await deletePhoto(groundId, name);
    } catch (error) {
      this.logger.warn('Could not remove a ground photo file', error);
    }
  }

  private async findOrThrow(id: string): Promise<Ground> {
    const ground = await this.prisma.ground.findUnique({ where: { id } });
    if (!ground) throw photoError('Ground not found', 'GROUND_NOT_FOUND', 404);
    return ground;
  }
}
