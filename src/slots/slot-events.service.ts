import { Injectable } from '@nestjs/common';
import type { Paginated } from '../common/schemas.js';
import type { BlockReason, Prisma, SlotEventAction } from '../generated/prisma/client.js';
import { PrismaService } from '../prisma/prisma.service.js';
import { assertRange, slotNotFound } from './slot-rules.js';
import type { ListSlotEventsQuery } from './slots.schemas.js';
import { fromDbDate, toDbDate, type IsoDate } from './venue-time.js';

const MAX_EVENT_DAYS = 366;

const EVENT_INCLUDE = {
  user: { select: { id: true, name: true } },
  ground: { select: { name: true } },
} satisfies Prisma.SlotEventInclude;

type EventRow = Prisma.SlotEventGetPayload<{ include: typeof EVENT_INCLUDE }>;

/** One block, unblock, close or reopen, as the slot's history shows it. */
export interface SlotEventDto {
  id: string;
  action: SlotEventAction;
  reason: BlockReason | null;
  note: string | null;
  /** Null if that staff account no longer exists. */
  user: { id: string; name: string } | null;
  createdAt: Date;
}

/** The venue-wide timeline adds where it happened. `slotId` is null once a free slot was regenerated. */
export interface SlotEventListDto extends SlotEventDto {
  slotId: string | null;
  groundId: string;
  groundName: string;
  date: IsoDate;
  startHour: number;
}

const toEventDto = (e: EventRow): SlotEventDto => ({
  id: e.id, action: e.action, reason: e.reason, note: e.note, user: e.user, createdAt: e.createdAt,
});

const toEventListDto = (e: EventRow): SlotEventListDto => ({
  ...toEventDto(e),
  slotId: e.slotId, groundId: e.groundId, groundName: e.ground.name, date: fromDbDate(e.date), startHour: e.startHour,
});

/** Reads the SlotEvent audit log. */
@Injectable()
export class SlotEventsService {
  constructor(private readonly prisma: PrismaService) {}

  /** Newest first. */
  async history(slotId: string): Promise<SlotEventDto[]> {
    const slot = await this.prisma.slot.findUnique({ where: { id: slotId }, select: { id: true } });
    if (!slot) throw slotNotFound();
    const rows = await this.prisma.slotEvent.findMany({
      where: { slotId }, include: EVENT_INCLUDE, orderBy: { createdAt: 'desc' },
    });
    return rows.map(toEventDto);
  }

  async list({ page, limit, groundId, from, to, action, userId }: ListSlotEventsQuery): Promise<Paginated<SlotEventListDto>> {
    if (from && to) assertRange(from, to, MAX_EVENT_DAYS);
    const where: Prisma.SlotEventWhereInput = {
      ...(groundId && { groundId }),
      ...(from && to && { date: { gte: toDbDate(from), lte: toDbDate(to) } }),
      ...(action && { action }),
      ...(userId && { userId }),
    };
    const [rows, total] = await this.prisma.$transaction([
      this.prisma.slotEvent.findMany({
        where, include: EVENT_INCLUDE, orderBy: { createdAt: 'desc' }, skip: (page - 1) * limit, take: limit,
      }),
      this.prisma.slotEvent.count({ where }),
    ]);
    return { data: rows.map(toEventListDto), total, page, limit };
  }
}
