import { createHash, createHmac } from 'node:crypto';
import { env } from '../config/env.js';
const key = createHmac('sha256', env.JWT_SECRET)
  .update('turf:owner-activation:v1')
  .digest();
export const invitationToken = (id: string, requestId: string) =>
  createHmac('sha256', key)
    .update(id + ':' + requestId)
    .digest('base64url');
export const invitationHash = (token: string) =>
  createHash('sha256').update(token).digest('hex');
