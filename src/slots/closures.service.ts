import { Injectable } from '@nestjs/common';
import { AppError } from '../common/app-error.js';
import type { Paginated } from '../common/schemas.js';
import type { BlockReason, Prisma } from '../generated/prisma/client.js';
import { PrismaService } from '../prisma/prisma.service.js';
import type { CreateClosureInput, ListClosuresQuery, PublicClosuresQuery } from './closures.schemas.js';
import {
  assertRange, closureBlock, dateWhere, eventRows, groundNotFound, UNBLOCK_DATA, upcomingWhere,
} from './slot-rules.js';
import { fromDbDate, toDbDate, venueNow, type IsoDate } from './venue-time.js';

export const MAX_CLOSURE_DAYS = 31;
const MAX_PUBLIC_CLOSURE_DAYS = 92;

const CLOSURE_INCLUDE = {
  createdBy: { select: { id: true, name: true } },
  liftedBy: { select: { id: true, name: true } },
} satisfies Prisma.ClosureInclude;

type ClosureRow = Prisma.ClosureGetPayload<{ include: typeof CLOSURE_INCLUDE }>;

export interface ClosureDto {
  id: string;
  fromDate: IsoDate;
  toDate: IsoDate;
  /** Empty = every ground. */
  groundIds: string[];
  reason: BlockReason;
  note: string | null;
  publicLabel: string | null;
  createdBy: { id: string; name: string } | null;
  createdAt: Date;
  /** Null while the closure is in force. */
  liftedAt: Date | null;
  liftedBy: { id: string; name: string } | null;
}

/** What customers see: dates and a label, never the staff note or reason. */
export interface PublicClosureDto {
  fromDate: IsoDate;
  toDate: IsoDate;
  groundIds: string[];
  label: string;
}

const toClosureDto = (c: ClosureRow): ClosureDto => ({
  id: c.id, fromDate: fromDbDate(c.fromDate), toDate: fromDbDate(c.toDate), groundIds: c.groundIds,
  reason: c.reason, note: c.note, publicLabel: c.publicLabel,
  createdBy: c.createdBy, createdAt: c.createdAt, liftedAt: c.liftedAt, liftedBy: c.liftedBy,
});

const closureNotFound = () => new AppError('Closure not found', 404, 'CLOSURE_NOT_FOUND');

/**
 * Venue-wide closures. The closure row is stored so slots generated later on those days are
 * created already blocked (see SlotGeneratorService); its blocks carry `closureId`.
 */
@Injectable()
export class ClosuresService {
  constructor(private readonly prisma: PrismaService) {}

  /** Blocks every free, upcoming slot in range; booked slots are skipped and counted. */
  async create(actorId: string, input: CreateClosureInput) {
    const now = venueNow();
    assertRange(input.fromDate, input.toDate, MAX_CLOSURE_DAYS);
    if (input.fromDate < now.date) throw new AppError('Start date must not be in the past', 400, 'INVALID_DATE_RANGE');
    const groundIds = input.groundIds ?? [];
    if (groundIds.length && (await this.prisma.ground.count({ where: { id: { in: groundIds } } })) !== groundIds.length) {
      throw groundNotFound();
    }

    return this.prisma.$transaction(async (tx) => {
      const closure = await tx.closure.create({
        data: {
          fromDate: toDbDate(input.fromDate), toDate: toDbDate(input.toDate), groundIds,
          reason: input.reason, note: input.note ?? null, publicLabel: input.publicLabel ?? null, createdById: actorId,
        },
        include: CLOSURE_INCLUDE,
      });
      const slots = await tx.slot.findMany({
        where: { ...(groundIds.length && { groundId: { in: groundIds } }), ...dateWhere(input.fromDate, input.toDate), ...upcomingWhere(now) },
      });
      const free = slots.filter((s) => s.status === 'available');
      const { count } = await tx.slot.updateMany({
        where: { id: { in: free.map((s) => s.id) }, status: 'available' }, data: closureBlock(closure),
      });
      if (count !== free.length) throw new AppError('Some slots changed while saving; try again', 409, 'SLOT_NOT_AVAILABLE');
      await tx.slotEvent.createMany({ data: eventRows(free, 'close', actorId, input) });
      return { closure: toClosureDto(closure), blocked: count, skippedBooked: slots.filter((s) => s.status === 'booked').length };
    }, { timeout: 20_000 });
  }

  /** Frees the upcoming slots this closure blocked. Slots blocked separately stay blocked. */
  async lift(actorId: string, id: string): Promise<{ unblocked: number }> {
    const now = venueNow();
    return this.prisma.$transaction(async (tx) => {
      const closure = await tx.closure.findUnique({ where: { id } });
      if (!closure) throw closureNotFound();
      if (closure.liftedAt) throw new AppError('This closure was already lifted', 409, 'CLOSURE_ALREADY_LIFTED');
      const slots = await tx.slot.findMany({ where: { closureId: id, status: 'blocked', ...upcomingWhere(now) } });
      const { count } = await tx.slot.updateMany({ where: { id: { in: slots.map((s) => s.id) } }, data: UNBLOCK_DATA });
      await tx.slotEvent.createMany({ data: eventRows(slots, 'reopen', actorId) });
      await tx.closure.update({ where: { id }, data: { liftedAt: new Date(), liftedById: actorId } });
      return { unblocked: count };
    }, { timeout: 20_000 });
  }

  /** Newest first, lifted ones included (they show `liftedAt`). */
  async list({ page, limit }: ListClosuresQuery): Promise<Paginated<ClosureDto>> {
    const [rows, total] = await this.prisma.$transaction([
      this.prisma.closure.findMany({
        include: CLOSURE_INCLUDE, orderBy: [{ fromDate: 'desc' }, { createdAt: 'desc' }], skip: (page - 1) * limit, take: limit,
      }),
      this.prisma.closure.count(),
    ]);
    return { data: rows.map(toClosureDto), total, page, limit };
  }

  /** Closures in force that overlap the range, so the portal can say why days are closed. */
  async listPublic({ from, to }: PublicClosuresQuery): Promise<PublicClosureDto[]> {
    assertRange(from, to, MAX_PUBLIC_CLOSURE_DAYS);
    const rows = await this.prisma.closure.findMany({
      where: { liftedAt: null, fromDate: { lte: toDbDate(to) }, toDate: { gte: toDbDate(from) } },
      orderBy: { fromDate: 'asc' },
    });
    return rows.map((c) => ({
      fromDate: fromDbDate(c.fromDate), toDate: fromDbDate(c.toDate), groundIds: c.groundIds, label: c.publicLabel ?? 'Closed',
    }));
  }
}
