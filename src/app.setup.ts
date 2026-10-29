import { resolve } from 'node:path';
import type { INestApplication } from '@nestjs/common';
import express from 'express';
import cookieParser from 'cookie-parser';
import helmet from 'helmet';
import { env } from './config/env.js';
import { AllExceptionsFilter } from './common/filters/all-exceptions.filter.js';
import { ResponseInterceptor } from './common/interceptors/response.interceptor.js';
import { UPLOADS_ROUTE } from './grounds/photo-storage.js';

/** Shared app wiring, used by main.ts and the e2e tests so both behave the same. */
export function configureApp(app: INestApplication) {
  app.setGlobalPrefix('api/v1');
  app.use(helmet());
  app.use(cookieParser());
  // Stripe signs the exact bytes it sent, so this route keeps the raw body (Nest's JSON parser then skips it).
  app.use('/api/v1/stripe/webhook', express.raw({ type: 'application/json', limit: '1mb' }));
  // File names are random UUIDs and never change, so they can be cached for good.
  app.use(UPLOADS_ROUTE, express.static(resolve(env.UPLOAD_DIR), { index: false, immutable: true, maxAge: '365d' }));
  app.enableCors({ origin: env.CORS_ORIGINS, credentials: true });
  app.useGlobalFilters(new AllExceptionsFilter());
  app.useGlobalInterceptors(new ResponseInterceptor());
  app.enableShutdownHooks();
  return app;
}
