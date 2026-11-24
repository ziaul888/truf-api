import { randomUUID } from 'node:crypto';
import { mkdir, rm, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { env } from '../config/env.js';
import { dashboardData } from '../prisma/dashboard-data-context.js';

/** Where uploads are served from (app.setup.ts mounts UPLOAD_DIR here). Goes through the frontend proxy. */
export const UPLOADS_ROUTE = '/api/v1/uploads';

export const MAX_PHOTOS = 5;
export const MAX_PHOTO_BYTES = 2 * 1024 * 1024;

/** Existing and tenant-scoped photo names. */
export const PHOTO_NAME =
  /^(?:turf-)?[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\.(jpg|png)$/;

const TENANT_PHOTO_PREFIX = 'turf-';
type PhotoType = 'jpg' | 'png';

export function newPhotoName(type: PhotoType): string {
  const prefix = dashboardData.getStore() ? TENANT_PHOTO_PREFIX : '';
  return `${prefix}${randomUUID()}.${type}`;
}

/** Unprefixed names retain the URL used by earlier versions. */
function photoDirectory(groundId: string, name: string): string {
  const tenant = dashboardData.getStore();
  if (tenant && name.startsWith(TENANT_PHOTO_PREFIX))
    return `grounds/${tenant.tenantId}/${groundId}`;
  return `grounds/${groundId}`;
}

export const photoUrl = (groundId: string, name: string) =>
  `${UPLOADS_ROUTE}/${photoDirectory(groundId, name)}/${name}`;

/** Detects JPEG/PNG from the file's first bytes; the browser-sent MIME type can't be trusted. */
export function detectImageType(bytes: Buffer): PhotoType | null {
  if (bytes.subarray(0, 3).equals(Buffer.from([0xff, 0xd8, 0xff])))
    return 'jpg';
  if (
    bytes
      .subarray(0, 8)
      .equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))
  )
    return 'png';
  return null;
}

export async function savePhoto(
  groundId: string,
  name: string,
  bytes: Buffer,
): Promise<void> {
  const directory = resolve(env.UPLOAD_DIR, photoDirectory(groundId, name));
  await mkdir(directory, { recursive: true });
  await writeFile(resolve(directory, name), bytes, { flag: 'wx' });
}

/** Missing files are fine: the goal is that the file is gone. */
export async function deletePhoto(
  groundId: string,
  name: string,
): Promise<void> {
  // A migrated photo can still refer to a shared legacy file.
  if (dashboardData.getStore() && !name.startsWith(TENANT_PHOTO_PREFIX)) return;
  await rm(resolve(env.UPLOAD_DIR, photoDirectory(groundId, name), name), {
    force: true,
  });
}
