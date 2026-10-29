import { Injectable } from '@nestjs/common';
import { AppError } from '../common/app-error.js';
import type { Prisma, Slot, SlotEventAction } from '../generated/prisma/client.js';
import { isOpenOn } from '../grounds/ground-schedule.js';
import { BookingCancellationService } from '../bookings/booking-cancellation.service.js';
import { PrismaService } from '../prisma/prisma.service.js';
import { SlotSettingsService } from './slot-settings.service.js';
import { SLOT_INCLUDE, toSlotDto, type SlotDto } from './slot.dto.js';
import { SlotGeneratorService } from './slot-generator.service.js';
import {
  assertRange, eventRows, groundClosed, groundNotFound, slotInPast, slotNotFound, UNBLOCK_DATA,
} from './slot-rules.js';
import type { BlockSlotInput, BulkBlockInput, BulkSlotsInput, BulkUnblockInput } from './slots.schemas.js';
import { datesBetween, fromDbDate, hasStarted, toDbDate, venueNow, weekdayOf, type IsoDate, type VenueNow } from './venue-time.js';

/** A recurring block may run at most a year. */
export const MAX_RECURRING_DAYS = 366;

export interface BlockResult {
  slot: SlotDto;
  /** True when the slot was booked and `cancelBooking: true` cancelled (and refunded) that booking. */
  cancelledBooking: boolean;
}

/** Per-id outcome of `POST /admin/slots/bulk`: failures don't roll back the others. */
export interface BulkByIdResult {
  done: number;
  failed: { id: string; code: string; error: string }[];
}

export interface BulkBlockResult {
  blocked: number;
  skippedBooked: number;
  cancelledBookings: number;
}

const hasBooking = () =>
  new AppError('This slot is booked. Send cancelBooking: true to cancel and refund the booking', 409, 'SLOT_HAS_BOOKING');
const slotHeld = () => new AppError('A customer is paying for this slot right now. Try again in a few minutes', 409, 'SLOT_NOT_AVAILABLE');

/** Reason and note of a block (the cancelBooking flag only applies to blocking one slot). */
type BlockFields = Pick<BlockSlotInput, 'reason' | 'note'>;

const blockData = (actorId: string, { reason, note }: BlockFields) => ({
  status: 'blocked' as const, blockReason: reason, blockNote: note ?? null, blockedById: actorId, blockedAt: new Date(),
});
@Injectable()
export class SlotBlocksService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly generator: SlotGeneratorService,
    private readonly cancellation: BookingCancellationService,
    private readonly settings: SlotSettingsService,
  ) {}

  async block(actorId: string, id: string, input: Omit<BlockSlotInput, 'cancelBooking'> & { cancelBooking?: boolean }): Promise<BlockResult> {
    const current = await this.upcomingSlot(this.prisma, id);
    if (current.status === 'booked' && input.cancelBooking) return this.blockOverBooking(actorId, current, input);
    await this.prisma.$transaction(async (tx) => {
      const slot = await this.upcomingSlot(tx, id);
      if (slot.status === 'booked') throw hasBooking();
      if (slot.status === 'held') throw slotHeld();
      if (slot.status === 'blocked') throw new AppError('This slot is already blocked', 409, 'SLOT_ALREADY_BLOCKED');
      await this.apply(tx, [slot], 'block', actorId, input);
    });
    return { slot: await this.dto(id), cancelledBooking: false };
  }

  /** Cancels the live booking with a full refund (emailing the customer if notifyCustomerOnBlock), and blocks the slot. */
  private async blockOverBooking(actorId: string, slot: Slot, input: BlockFields): Promise<BlockResult> {
    const booking = await this.prisma.booking.findFirst({ where: { liveSlotId: slot.id }, select: { id: true } });
    if (!booking) throw hasBooking();
    const { notifyCustomerOnBlock } = await this.settings.get();
    await this.cancellation.cancel(booking.id, {
      actorId, reason: `Slot blocked (${input.reason})`, refund: true, notify: notifyCustomerOnBlock,
      blockSlot: { reason: input.reason, note: input.note },
    });
    return { slot: await this.dto(slot.id), cancelledBooking: true };
  }

  /** Back to `available`. A booking cancelled by the block is not restored. */
  async unblock(actorId: string, id: string): Promise<SlotDto> {
    await this.prisma.$transaction(async (tx) => {
      const slot = await this.upcomingSlot(tx, id);
      if (slot.status !== 'blocked') throw new AppError('This slot is not blocked', 409, 'SLOT_NOT_BLOCKED');
      await this.apply(tx, [slot], 'unblock', actorId);
    });
    return this.dto(id);
  }

  /** Blocks or unblocks each id on its own, with the single-slot rules; reports failures per id. */
  async bulkById(actorId: string, { ids, action, reason, note }: BulkSlotsInput): Promise<BulkByIdResult> {
    const result: BulkByIdResult = { done: 0, failed: [] };
    for (const id of ids) {
      try {
        if (action === 'block') await this.block(actorId, id, { reason: reason!, note });
        else await this.unblock(actorId, id);
        result.done++;
      } catch (err) {
        if (!(err instanceof AppError)) throw err;
        result.failed.push({ id, code: err.code ?? 'ERROR', error: err.message });
      }
    }
    return result;
  }

  /** `single` behaves like blocking one slot; `fullDay` and `recurringWeekly` skip booked and started slots. */
  async bulkBlock(actorId: string, input: BulkBlockInput): Promise<BulkBlockResult> {
    const now = venueNow();
    const ground = await this.prisma.ground.findUnique({ where: { id: input.groundId } });
    if (!ground) throw groundNotFound();
    const dates = targetDates(input).filter((date) => isOpenOn(ground, weekdayOf(date)));
    if (dates.length === 0) throw groundClosed();
    if (input.type !== 'recurringWeekly' && dates[0]! < now.date) throw slotInPast();

    return this.prisma.$transaction(async (tx) => {
      await this.generator.fillDates(tx, ground.id, dates);
      const slots = await tx.slot.findMany({
        where: {
          groundId: ground.id, date: { in: dates.map(toDbDate) },
          ...(input.type !== 'fullDay' && input.startHour !== undefined && { startHour: input.startHour }),
        },
      });
      if (input.type === 'single') return this.blockSingle(tx, slots[0], now, actorId, input);
      const free = slots.filter((s) => s.status === 'available' && !hasStarted(now, fromDbDate(s.date), s.startHour));
      const blocked = await this.apply(tx, free, 'block', actorId, input);
      return { blocked, skippedBooked: slots.filter((s) => s.status === 'booked').length, cancelledBookings: 0 };
    }, { timeout: 20_000 });
  }

  /** Unblocks every upcoming blocked slot on that date (the "Unblock all today" button). */
  async bulkUnblock(actorId: string, { groundId, date }: BulkUnblockInput): Promise<{ unblocked: number }> {
    const now = venueNow();
    return this.prisma.$transaction(async (tx) => {
      const slots = await tx.slot.findMany({ where: { ...(groundId && { groundId }), date: toDbDate(date), status: 'blocked' } });
      const upcoming = slots.filter((s) => !hasStarted(now, date, s.startHour));
      return { unblocked: await this.apply(tx, upcoming, 'unblock', actorId) };
    });
  }

  private async blockSingle(
    tx: Prisma.TransactionClient, slot: Slot | undefined, now: VenueNow, actorId: string, input: BlockFields,
  ): Promise<BulkBlockResult> {
    if (!slot) throw slotNotFound();
    if (hasStarted(now, fromDbDate(slot.date), slot.startHour)) throw slotInPast();
    if (slot.status === 'booked') throw hasBooking();
    if (slot.status === 'held') throw slotHeld();
    if (slot.status === 'blocked') throw new AppError('This slot is already blocked', 409, 'SLOT_ALREADY_BLOCKED');
    return { blocked: await this.apply(tx, [slot], 'block', actorId, input), skippedBooked: 0, cancelledBookings: 0 };
  }

  /** Changes status only where it is still what we read (so a slot booked meanwhile is left alone), and logs it. */
  private async apply(
    tx: Prisma.TransactionClient, slots: Slot[], action: SlotEventAction, actorId: string, block?: BlockFields,
  ): Promise<number> {
    if (slots.length === 0) return 0;
    const ids = slots.map((s) => s.id);
    const { count } = await tx.slot.updateMany({
      where: { id: { in: ids }, status: action === 'block' ? 'available' : 'blocked' },
      data: action === 'block' ? blockData(actorId, block!) : UNBLOCK_DATA,
    });
    if (count !== ids.length) throw new AppError('Some slots changed while saving; try again', 409, 'SLOT_NOT_AVAILABLE');
    await tx.slotEvent.createMany({ data: eventRows(slots, action, actorId, block) });
    return count;
  }

  private async upcomingSlot(tx: Prisma.TransactionClient | PrismaService, id: string): Promise<Slot> {
    const slot = await tx.slot.findUnique({ where: { id } });
    if (!slot) throw slotNotFound();
    if (hasStarted(venueNow(), fromDbDate(slot.date), slot.startHour)) throw slotInPast();
    return slot;
  }

  private async dto(id: string): Promise<SlotDto> {
    return toSlotDto(await this.prisma.slot.findUniqueOrThrow({ where: { id }, include: SLOT_INCLUDE }));
  }
}

function targetDates(input: BulkBlockInput): IsoDate[] {
  if (input.type !== 'recurringWeekly') return [input.date];
  assertRange(input.date, input.untilDate, MAX_RECURRING_DAYS);
  return datesBetween(input.date, input.untilDate).filter((date) => input.weekdays.includes(weekdayOf(date)));
}
