import { mkdir, rm, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { env } from '../config/env.js';

/** Where uploads are served from (app.setup.ts mounts UPLOAD_DIR here). Goes through the frontend proxy. */
export const UPLOADS_ROUTE = '/api/v1/uploads';

export const MAX_PHOTOS = 5;
export const MAX_PHOTO_BYTES = 2 * 1024 * 1024;

/** Names we generate: `<uuid>.jpg|png`. Anything else is rejected before touching the disk. */
export const PHOTO_NAME = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\.(jpg|png)$/;

const groundDir = (groundId: string) => resolve(env.UPLOAD_DIR, 'grounds', groundId);

export const photoUrl = (groundId: string, name: string) => `${UPLOADS_ROUTE}/grounds/${groundId}/${name}`;

/** Detects JPEG/PNG from the file's first bytes; the browser-sent MIME type can't be trusted. */
export function detectImageType(bytes: Buffer): 'jpg' | 'png' | null {
  if (bytes.subarray(0, 3).equals(Buffer.from([0xff, 0xd8, 0xff]))) return 'jpg';
  if (bytes.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) return 'png';
  return null;
}

export async function savePhoto(groundId: string, name: string, bytes: Buffer): Promise<void> {
  await mkdir(groundDir(groundId), { recursive: true });
  await writeFile(resolve(groundDir(groundId), name), bytes, { flag: 'wx' });
}

/** Missing files are fine: the goal is that the file is gone. */
export async function deletePhoto(groundId: string, name: string): Promise<void> {
  await rm(resolve(groundDir(groundId), name), { force: true });
}
