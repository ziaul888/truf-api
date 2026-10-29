import { Controller, Get } from '@nestjs/common';

@Controller('health')
export class HealthController {
  /** Liveness check for local dev, uptime monitors and deploy checks. */
  @Get()
  check() {
    return { status: 'ok', uptime: Math.round(process.uptime()) };
  }
}
