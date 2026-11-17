import type { Server } from 'node:http';
import type { INestApplication } from '@nestjs/common';
import type { PrismaService } from '../../src/prisma/prisma.service.js';
export const platformLogin = {
  email: 'admin@platform-e2e.test',
  password: 'platform-e2e-password',
};
export const staffLogin = {
  email: 'staff@platform-e2e.test',
  password: 'platform-e2e-password',
};
export interface PlatformFixtures {
  userId: string;
  staffId: string;
  aId: string;
  bId: string;
  draftId: string;
}
export interface PlatformState {
  app: INestApplication<Server>;
  db: PrismaService;
  fixtures: PlatformFixtures;
  cookie: string;
  staffCookie: string;
}
export type GetPlatform = () => PlatformState;
