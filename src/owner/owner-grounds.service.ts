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
import { requireOwner } from './owner-access.js';
import type { OwnerContext } from './owner-session.js';
import { ownerTransaction } from './owner-transaction.js';
import { resyncOwnerSlots } from './owner-slot-plan.js';
import { requireVenue } from './owner-venue.js';

export async function ownerGround(
  db: Prisma.TransactionClient,
  tenantId: string,
  id: string,
) {
  const row = await db.tenantGround.findUnique({
    where: { tenantId_id: { tenantId, id } },
  });
  if (!row) throw groundNotFound();
  return row;
}

@Injectable()
export class OwnerGroundsService {
  constructor(private readonly db: PrismaService) {}

  async stats(owner: OwnerContext) {
    requireVenue(owner);
    return {
      activeGrounds: await this.db.tenantGround.count({
        where: { tenantId: owner.session.tid, isActive: true },
      }),
    };
  }

  async list(owner: OwnerContext, query: AdminListGroundsQuery) {
    requireVenue(owner);
    const { page, limit, search, sport, format, surface, isActive } = query;
    const where: Prisma.TenantGroundWhereInput = {
      tenantId: owner.session.tid,
      sport,
      format,
      surface,
      isActive,
      ...(search && { name: { contains: search, mode: 'insensitive' } }),
    };
    const [grounds, total] = await this.db.$transaction([
      this.db.tenantGround.findMany({
        where,
        orderBy: [{ name: 'asc' }, { id: 'asc' }],
        skip: (page - 1) * limit,
        take: limit,
      }),
      this.db.tenantGround.count({ where }),
    ]);
    return { data: grounds.map(toGroundDto), total, page, limit };
  }

  async get(owner: OwnerContext, id: string) {
    requireVenue(owner);
    return toGroundDto(await ownerGround(this.db, owner.session.tid, id));
  }

  create(session: OwnerContext['session'], input: CreateGroundInput) {
    assertPeakPricing(input);
    const days = resolveDays(input.availableDays, input.customDays);
    return ownerTransaction(this.db, async (tx) => {
      requireVenue(await requireOwner(tx, session));
      const ground = await tx.tenantGround.create({
        data: { ...input, ...days, tenantId: session.tid, showOnPortal: false },
      });
      return toGroundDto(ground);
    });
  }

  update(
    session: OwnerContext['session'],
    id: string,
    input: UpdateGroundInput,
  ) {
    return ownerTransaction(this.db, async (tx) => {
      const owner = await requireOwner(tx, session);
      requireVenue(owner);
      const ground = await ownerGround(tx, session.tid, id);
      const data = validatedChanges(ground, input);
      const updated = await tx.tenantGround.update({
        where: { tenantId_id: { tenantId: session.tid, id } },
        data,
      });
      const dto = toGroundDto(updated);
      if (!scheduleChanged(ground, data)) return dto;
      const slotSync = await resyncOwnerSlots(
        tx,
        updated,
        owner.user.tenant.timezone,
      );
      return { ...dto, slotSync };
    });
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
    showOnPortal: false,
  };
}
