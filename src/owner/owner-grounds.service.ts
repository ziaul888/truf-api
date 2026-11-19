import { Injectable } from '@nestjs/common';
import type { Prisma } from '../generated/prisma/client.js';
import { peakRangesOf, toGroundDto } from '../grounds/ground.dto.js';
import {
  assertHours,
  assertPeakPricing,
  resolveDays,
  scheduleChanged,
} from '../grounds/ground-rules.js';
import type {
  AdminListGroundsQuery,
  CreateGroundInput,
  UpdateGroundInput,
} from '../grounds/grounds.schemas.js';
import { PrismaService } from '../prisma/prisma.service.js';
import { groundNotFound } from '../slots/slot-rules.js';
import type { TenantOperator } from './owner-session.js';
import { ownerTransaction } from './owner-transaction.js';
import { fillOwnerWindow, resyncOwnerSlots } from './owner-slot-plan.js';
import { requireVenue } from './owner-venue.js';
import { TenantDashboardDatabase } from './tenant-dashboard-database.service.js';

export async function ownerGround(db: Prisma.TransactionClient, id: string) {
  const row = await db.ground.findUnique({
    where: { id },
  });
  if (!row) throw groundNotFound();
  return row;
}

@Injectable()
export class OwnerGroundsService {
  constructor(
    private readonly db: PrismaService,
    private readonly dashboard: TenantDashboardDatabase,
  ) {}

  async stats(owner: TenantOperator) {
    requireVenue(owner);
    return this.dashboard.run(owner.user.tenant, async () => ({
      activeGrounds: await this.db.ground.count({ where: { isActive: true } }),
    }));
  }

  async list(owner: TenantOperator, query: AdminListGroundsQuery) {
    requireVenue(owner);
    const { page, limit, search, sport, format, surface, isActive } = query;
    const where: Prisma.GroundWhereInput = {
      sport,
      format,
      surface,
      isActive,
      ...(search && { name: { contains: search, mode: 'insensitive' } }),
    };
    const [grounds, total] = await this.dashboard.run(owner.user.tenant, () =>
      this.db.$transaction([
        this.db.ground.findMany({
          where,
          orderBy: [{ name: 'asc' }, { id: 'asc' }],
          skip: (page - 1) * limit,
          take: limit,
        }),
        this.db.ground.count({ where }),
      ]),
    );
    return { data: grounds.map(toGroundDto), total, page, limit };
  }

  async get(owner: TenantOperator, id: string) {
    requireVenue(owner);
    return this.dashboard.run(owner.user.tenant, async () =>
      toGroundDto(await ownerGround(this.db, id)),
    );
  }

  create(session: TenantOperator['session'], input: CreateGroundInput) {
    assertPeakPricing(input);
    const days = resolveDays(input.availableDays, input.customDays);
    return this.dashboard.runForAdmin(session, (settings) =>
      ownerTransaction(this.db, async (tx) => {
        const ground = await tx.ground.create({
          data: { ...input, ...days },
        });
        await fillOwnerWindow(tx, ground, settings);
        return toGroundDto(ground);
      }),
    );
  }

  update(
    session: TenantOperator['session'],
    id: string,
    input: UpdateGroundInput,
  ) {
    return this.dashboard.runForAdmin(session, () =>
      ownerTransaction(this.db, async (tx) => {
        const ground = await ownerGround(tx, id);
        const data = validatedChanges(ground, input);
        const updated = await tx.ground.update({ where: { id }, data });
        const dto = toGroundDto(updated);
        if (!scheduleChanged(ground, data)) return dto;
        const slotSync = await resyncOwnerSlots(tx, updated);
        return { ...dto, slotSync };
      }),
    );
  }
}

function validatedChanges(
  ground: Awaited<ReturnType<typeof ownerGround>>,
  input: UpdateGroundInput,
) {
  const openingHour = input.openingHour ?? ground.openingHour;
  const closingHour = input.closingHour ?? ground.closingHour;
  assertHours(openingHour, closingHour);
  assertPeakPricing({
    openingHour,
    closingHour,
    peakPrice:
      input.peakPrice === undefined ? ground.peakPrice : input.peakPrice,
    peakRanges: input.peakRanges ?? peakRangesOf(ground),
  });
  return {
    ...input,
    ...resolveDays(
      input.availableDays ?? ground.availableDays,
      input.customDays ?? ground.customDays,
    ),
  };
}
