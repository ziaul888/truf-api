import { Injectable } from '@nestjs/common';
import { randomBytes } from 'node:crypto';
import { hashPassword } from '../auth/password.js';
import type { PlatformActor } from './platform-session.js';
import { PlatformCommands } from './platform-command.js';
import type { CreateTurf } from './platform-onboarding.schemas.js';
import { createTurf } from './platform-onboarding-writes.js';
import { PlatformTenantsService } from './platform-tenants.service.js';
@Injectable()
export class PlatformOnboardingService {
  constructor(
    private readonly commands: PlatformCommands,
    private readonly tenants: PlatformTenantsService,
  ) {}
  async create(actor: PlatformActor, input: CreateTurf) {
    const passwordHash = await hashPassword(
      randomBytes(32).toString('base64url'),
    );
    const id = await this.commands.run(
      actor,
      { requestId: input.requestId, action: 'tenant_created', payload: input },
      (tx) => createTurf(tx, input, passwordHash),
    );
    return this.tenants.detail(id);
  }
}
