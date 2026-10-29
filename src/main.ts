import { Logger } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { AppModule } from './app.module.js';
import { configureApp } from './app.setup.js';
import { env } from './config/env.js';

async function bootstrap() {
  const app = configureApp(await NestFactory.create(AppModule));
  await app.listen(env.PORT);
  new Logger('Bootstrap').log(`API ready on http://localhost:${env.PORT}/api/v1`);
}
await bootstrap();
