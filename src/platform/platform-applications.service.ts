import { Injectable } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service.js';
import {
  ownerApplicationSelect,
  toOwnerApplicationDto,
} from '../owner-applications/owner-application.dto.js';
import type { PlatformActor } from './platform-session.js';
import { PlatformCommands } from './platform-command.js';
import { PlatformTenantsService } from './platform-tenants.service.js';
import type { PlatformApplicationFilters } from './platform-applications.schemas.js';
import {
  activateApplication,
  rejectApplication,
} from './platform-applications-writes.js';

@Injectable()
export class PlatformApplicationsService {
  constructor(
    private readonly db: PrismaService,
    private readonly commands: PlatformCommands,
    private readonly tenants: PlatformTenantsService,
  ) {}

  async list(filters: PlatformApplicationFilters) {
    const where = filters.status ? { status: filters.status } : {};
    const [rows, total] = await Promise.all([
      this.db.ownerApplication.findMany({
        where,
        select: ownerApplicationSelect,
        orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
        skip: (filters.page - 1) * filters.limit,
        take: filters.limit,
      }),
      this.db.ownerApplication.count({ where }),
    ]);
    return {
      data: rows.map(toOwnerApplicationDto),
      total,
      page: filters.page,
      limit: filters.limit,
    };
  }

  async activate(actor: PlatformActor, id: string, requestId: string) {
    const tenantId = await this.commands.run(
      actor,
      {
        requestId,
        action: 'application_activated',
        payload: { applicationId: id, requestId },
      },
      (tx) => activateApplication(tx, id, actor.userId),
    );
    return this.tenants.detail(tenantId);
  }

  async reject(actor: PlatformActor, id: string, requestId: string) {
    await this.commands.run(
      actor,
      {
        requestId,
        action: 'application_rejected',
        payload: { applicationId: id, requestId },
      },
      (tx) => rejectApplication(tx, id, actor.userId),
    );
    const row = await this.db.ownerApplication.findUniqueOrThrow({
      where: { id },
      select: ownerApplicationSelect,
    });
    return toOwnerApplicationDto(row);
  }
}
