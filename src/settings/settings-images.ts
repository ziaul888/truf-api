import { randomUUID } from 'node:crypto';
import { mkdir, rm, writeFile } from 'node:fs/promises';
import { basename, resolve } from 'node:path';
import { AppError } from '../common/app-error.js';
import { env } from '../config/env.js';
import { detectImageType, UPLOADS_ROUTE } from '../grounds/photo-storage.js';

export type ImageFolder = 'venue' | 'website';
type ImageType = 'jpg' | 'png' | 'webp';

/** The parts of a Multer file we use. */
export interface UploadedImage {
  buffer: Buffer;
  size: number;
}

const imageError = (message: string, code: string) => new AppError(message, 400, code);

/** JPEG and PNG as for ground photos, plus WEBP ("RIFF....WEBP"). From the bytes, never the MIME type. */
function typeOf(bytes: Buffer): ImageType | null {
  if (bytes.subarray(0, 4).toString('latin1') === 'RIFF' && bytes.subarray(8, 12).toString('latin1') === 'WEBP') return 'webp';
  return detectImageType(bytes);
}

export const imageUrl = (folder: ImageFolder, name: string) => `${UPLOADS_ROUTE}/${folder}/${name}`;

/** Checks and saves an upload under UPLOAD_DIR/<folder>/<uuid>.<type>; returns the file name. */
export async function saveImage(
  folder: ImageFolder, file: UploadedImage | undefined, rules: { field: string; types: ImageType[]; maxBytes: number; maxLabel: string; label: string },
): Promise<string> {
  if (!file) throw imageError(`Attach an image in the "${rules.field}" field`, 'IMAGE_REQUIRED');
  if (file.size > rules.maxBytes) throw imageError(`${rules.label} must be ${rules.maxLabel} or smaller`, 'IMAGE_TOO_LARGE');
  const type = typeOf(file.buffer);
  if (!type || !rules.types.includes(type)) {
    throw imageError(`${rules.label} must be ${rules.types.map((t) => t.toUpperCase()).join(', ')}`, 'INVALID_IMAGE_TYPE');
  }
  const name = `${randomUUID()}.${type}`;
  const dir = resolve(env.UPLOAD_DIR, folder);
  await mkdir(dir, { recursive: true });
  await writeFile(resolve(dir, name), file.buffer, { flag: 'wx' });
  return name;
}

/** Deletes one of our uploads, by name or by its URL. Anything else (an https link) is left alone. */
export async function deleteImage(folder: ImageFolder, nameOrUrl: string | null | undefined): Promise<void> {
  if (!nameOrUrl) return;
  const prefix = `${UPLOADS_ROUTE}/${folder}/`;
  if (nameOrUrl.includes('/') && !nameOrUrl.startsWith(prefix)) return;
  const name = basename(nameOrUrl);
  if (!/^[0-9a-f-]{36}\.(jpg|png|webp)$/.test(name)) return;
  await rm(resolve(env.UPLOAD_DIR, folder, name), { force: true });
}
