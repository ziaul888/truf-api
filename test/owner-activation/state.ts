import { randomUUID } from 'node:crypto';
import request from 'supertest';
import type { Server } from 'node:http';
import type { INestApplication } from '@nestjs/common';
import type { PrismaService } from '../../src/prisma/prisma.service.js';
export const platformCredentials = {
  email: 'platform@owner-activation-e2e.test',
  password: 'owner-activation-admin-password',
};
export const chosenPassword = 'owner-chosen-password-123';
export interface OwnerState {
  app: INestApplication<Server>;
  db: PrismaService;
  platformCookie: string;
  staffCookie: string;
  adminId: string;
  staffId: string;
}
export type GetOwnerState = () => OwnerState;
let sequence = 0;
export const turfInput = () => {
  const n = ++sequence;
  return {
    requestId: randomUUID(),
    name: 'Owner Activation Turf ' + n,
    slug: 'owner-activation-e2e-' + n,
    ownerName: 'Owner ' + n,
    ownerEmail: `owner-${n}@owner-activation-e2e.test`,
    timezone: 'Asia/Dhaka',
    currency: 'bdt',
  };
};
export const platformPost = (s: OwnerState, path: string, body: object) =>
  request(s.app.getHttpServer())
    .post('/api/v1/platform' + path)
    .set('Cookie', s.platformCookie)
    .send(body);
export const platformGet = (s: OwnerState, path: string) =>
  request(s.app.getHttpServer())
    .get('/api/v1/platform' + path)
    .set('Cookie', s.platformCookie);
export const preview = (s: OwnerState, token: string) =>
  request(s.app.getHttpServer())
    .post('/api/v1/owner/activation/preview')
    .send({ token });
export const accept = (
  s: OwnerState,
  token: string,
  password = chosenPassword,
) =>
  request(s.app.getHttpServer())
    .post('/api/v1/owner/activation/accept')
    .send({ token, password });
export const signIn = (
  s: OwnerState,
  email: string,
  password = chosenPassword,
) =>
  request(s.app.getHttpServer())
    .post('/api/v1/admin/auth/login')
    .send({ email, password });
export async function createInvitation(s: OwnerState) {
  const input = turfInput(),
    turf = (await platformPost(s, '/tenants', input).expect(201)).body.data;
  const body = { requestId: randomUUID() },
    invitation = (
      await platformPost(
        s,
        `/tenants/${turf.id}/owner-invitation`,
        body,
      ).expect(201)
    ).body.data;
  return { turf, invitation, input, body };
}
export function ownerCookie(response: { headers: Record<string, unknown> }) {
  const cookies = response.headers['set-cookie'];
  if (!Array.isArray(cookies)) throw new Error('Expected owner cookie');
  const cookie = cookies.find(
    (value) => typeof value === 'string' && value.startsWith('owner_token='),
  );
  if (typeof cookie !== 'string') throw new Error('Expected owner cookie');
  return cookie.split(';')[0]!;
}
export async function activateOwner(s: OwnerState) {
  const a = await createInvitation(s);
  await accept(s, a.invitation.token).expect(200);
  const login = await signIn(s, a.input.ownerEmail).expect(200);
  return { ...a, cookie: ownerCookie(login), login };
}
