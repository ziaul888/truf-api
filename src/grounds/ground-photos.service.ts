import { randomUUID } from 'node:crypto';
import { Injectable } from '@nestjs/common';
import { AppError } from '../common/app-error.js';
import type { Ground } from '../generated/prisma/client.js';
import { PrismaService } from '../prisma/prisma.service.js';
import { toGroundDto, type GroundDto } from './ground.dto.js';
import { deletePhoto, detectImageType, MAX_PHOTO_BYTES, MAX_PHOTOS, savePhoto } from './photo-storage.js';

/** The parts of an uploaded file we use (Multer's file object has more). */
export interface UploadedPhoto {
  buffer: Buffer;
  size: number;
}

const photoError = (message: string, code: string, status = 400) => new AppError(message, status, code);

@Injectable()
export class GroundPhotosService {
  constructor(private readonly prisma: PrismaService) {}

  async add(groundId: string, file: UploadedPhoto | undefined): Promise<GroundDto> {
    if (!file) throw photoError('Attach an image in the "photo" field', 'PHOTO_REQUIRED');
    const ground = await this.findOrThrow(groundId);
    if (ground.photos.length >= MAX_PHOTOS) {
      throw photoError(`A ground can have at most ${MAX_PHOTOS} photos`, 'TOO_MANY_PHOTOS');
    }
    if (file.size > MAX_PHOTO_BYTES) throw photoError('Photos must be 2 MB or smaller', 'PHOTO_TOO_LARGE');
    const type = detectImageType(file.buffer);
    if (!type) throw photoError('Photos must be JPG or PNG images', 'INVALID_PHOTO_TYPE');

    const name = `${randomUUID()}.${type}`;
    await savePhoto(groundId, name, file.buffer);
    try {
      const updated = await this.prisma.ground.update({ where: { id: groundId }, data: { photos: { push: name } } });
      return toGroundDto(updated);
    } catch (err) {
      await deletePhoto(groundId, name); // don't leave an orphan file behind
      throw err;
    }
  }

  async remove(groundId: string, name: string): Promise<GroundDto> {
    const ground = await this.findOrThrow(groundId);
    if (!ground.photos.includes(name)) throw photoError('Photo not found', 'PHOTO_NOT_FOUND', 404);

    const updated = await this.prisma.ground.update({
      where: { id: groundId },
      data: { photos: ground.photos.filter((p) => p !== name) },
    });
    await deletePhoto(groundId, name);
    return toGroundDto(updated);
  }

  /** `order` must list exactly the ground's current photos, in the new order. */
  async reorder(groundId: string, order: string[]): Promise<GroundDto> {
    const ground = await this.findOrThrow(groundId);
    const samePhotos = order.length === ground.photos.length && ground.photos.every((p) => order.includes(p));
    if (!samePhotos) {
      throw photoError('Send every current photo exactly once, in the new order', 'INVALID_PHOTO_ORDER');
    }
    return toGroundDto(await this.prisma.ground.update({ where: { id: groundId }, data: { photos: order } }));
  }

  private async findOrThrow(id: string): Promise<Ground> {
    const ground = await this.prisma.ground.findUnique({ where: { id } });
    if (!ground) throw photoError('Ground not found', 'GROUND_NOT_FOUND', 404);
    return ground;
  }
}
