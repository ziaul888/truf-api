import { Injectable } from '@nestjs/common';
import { AppError } from '../common/app-error.js';
import type { Ground, Prisma } from '../generated/prisma/client.js';
import { peakRangesOf } from '../grounds/ground.dto.js';
import { isOpenOn, slotStartHours } from '../grounds/ground-schedule.js';
import { PrismaService } from '../prisma/prisma.service.js';
import { SlotSettingsService } from './slot-settings.service.js';
import {
  activeClosuresWhere, assertRange, closureBlock, closureOn, dateWhere, groundClosed, groundNotFound, planDay, upcomingWhere,
  type DayPlan, type GroundForSlots, type SlotSpan,
} from './slot-rules.js';
import type { GenerateSlotsInput } from './slots.schemas.js';
import {
  addDays, datesBetween, fromDbDate, venueNow, weekdayOf, type IsoDate, type VenueNow,
} from './venue-time.js';

/** The longest range one generate request may cover. */
export const MAX_GENERATE_DAYS = 90;

export interface GenerateResult {
  generated: number;
  skipped: number;
  days: number;
  slotsPerDay: number;
}

/** What changed when a ground's schedule was edited. */
export interface SlotSync {
  /** Future free slots replaced to match the new schedule. */
  removed: number;
  generated: number;
  /** Future slots left untouched because they are booked, blocked or have a booking. */
  kept: number;
}

type Db = PrismaService | Prisma.TransactionClient;

const forSlots = (g: Ground): GroundForSlots => ({ ...g, peakRanges: peakRangesOf(g) });

@Injectable()
export class SlotGeneratorService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly settings: SlotSettingsService,
  ) {}

  /** `POST /admin/slots/generate`. Never touches existing slots; `dryRun` only counts. */
  async generate({ groundId, fromDate, toDate, dryRun }: GenerateSlotsInput): Promise<GenerateResult> {
    const now = venueNow();
    assertRange(fromDate, toDate, MAX_GENERATE_DAYS);
    if (fromDate < now.date) throw new AppError('Start date must not be in the past', 400, 'INVALID_DATE_RANGE');
    const grounds = groundId === 'all' ? await this.activeGrounds() : [await this.groundOrThrow(groundId)];
    const dates = datesBetween(fromDate, toDate);
    if (groundId !== 'all') assertOpenOnSome(grounds[0]!, dates);

    const result: GenerateResult = { generated: 0, skipped: 0, days: dates.length, slotsPerDay: 0 };
    for (const ground of grounds) {
      const plan = await this.plan(this.prisma, ground, dates, now);
      if (!dryRun) await this.prisma.slot.createMany({ data: plan.create, skipDuplicates: true });
      result.generated += plan.create.length;
      result.skipped += plan.skipped;
      result.slotsPerDay += slotStartHours(ground).length;
    }
    return result;
  }

  /** Creates any missing slots up to the booking window (the auto-generate job). Off when autoGenerate is. */
  async fillWindow(groundIds?: string[]): Promise<number> {
    const { autoGenerate, advanceBookingDays } = await this.settings.get();
    if (!autoGenerate) return 0;
    const now = venueNow();
    const dates = datesBetween(now.date, addDays(now.date, advanceBookingDays));
    let generated = 0;
    for (const ground of await this.activeGrounds(groundIds)) {
      const plan = await this.plan(this.prisma, ground, dates, now);
      generated += (await this.prisma.slot.createMany({ data: plan.create, skipDuplicates: true })).count;
    }
    return generated;
  }

  /** Makes sure a ground has slots on these dates (before blocking them). */
  async fillDates(db: Db, groundId: string, dates: IsoDate[]): Promise<void> {
    const ground = await db.ground.findUnique({ where: { id: groundId } });
    if (!ground || dates.length === 0) return;
    const plan = await this.plan(db, forSlots(ground), dates, venueNow());
    await db.slot.createMany({ data: plan.create, skipDuplicates: true });
  }

  /**
   * After a ground's hours, length, prices or days change: replace its future free slots
   * (available, never booked) so they match. Booked and blocked slots are never touched.
   */
  async resync(groundId: string): Promise<SlotSync> {
    const now = venueNow();
    const { autoGenerate, advanceBookingDays } = await this.settings.get();
    const free: Prisma.SlotWhereInput = { groundId, status: 'available', bookings: { none: {} }, ...upcomingWhere(now) };

    return this.prisma.$transaction(async (tx) => {
      const cleared = await tx.slot.findMany({ where: free, select: { date: true }, distinct: ['date'] });
      const { count: removed } = await tx.slot.deleteMany({ where: free });
      // Refill the days just cleared, plus the booking window when auto-generate is on.
      const window = autoGenerate ? datesBetween(now.date, addDays(now.date, advanceBookingDays)) : [];
      const dates = [...new Set([...cleared.map((s) => fromDbDate(s.date)), ...window])].sort();
      const ground = await tx.ground.findUniqueOrThrow({ where: { id: groundId } });
      const generated = await this.insertPlan(tx, forSlots(ground), dates, now);
      const kept = await tx.slot.count({ where: { groundId, ...upcomingWhere(now) } }) - generated;
      return { removed, generated, kept };
    });
  }

  private async insertPlan(db: Db, ground: GroundForSlots, dates: IsoDate[], now: VenueNow) {
    if (!ground.isActive) return 0;
    const plan = await this.plan(db, ground, dates, now);
    return (await db.slot.createMany({ data: plan.create, skipDuplicates: true })).count;
  }

  private async plan(db: Db, ground: GroundForSlots, dates: IsoDate[], now: VenueNow): Promise<DayPlan> {
    if (dates.length === 0) return { create: [], skipped: 0 };
    const stored = await db.slot.findMany({
      where: { groundId: ground.id, ...dateWhere(dates[0], dates.at(-1)) },
      select: { date: true, startHour: true, durationMinutes: true },
    });
    const closures = await db.closure.findMany({ where: activeClosuresWhere(ground.id, dates[0]!, dates.at(-1)!) });
    const byDate = new Map<IsoDate, SlotSpan[]>();
    for (const s of stored) byDate.set(fromDbDate(s.date), [...(byDate.get(fromDbDate(s.date)) ?? []), s]);

    const total: DayPlan = { create: [], skipped: 0 };
    for (const date of dates) {
      const day = planDay(ground, date, byDate.get(date) ?? [], now);
      // Days inside a venue closure get their slots already blocked by it.
      const closure = closureOn(closures, date);
      total.create.push(...(closure ? day.create.map((slot) => ({ ...slot, ...closureBlock(closure) })) : day.create));
      total.skipped += day.skipped;
    }
    return total;
  }

  private async activeGrounds(ids?: string[]): Promise<GroundForSlots[]> {
    const grounds = await this.prisma.ground.findMany({ where: { isActive: true, ...(ids && { id: { in: ids } }) } });
    return grounds.map(forSlots);
  }

  private async groundOrThrow(id: string): Promise<GroundForSlots> {
    const ground = await this.prisma.ground.findUnique({ where: { id } });
    if (!ground) throw groundNotFound();
    if (!ground.isActive) throw groundClosed('This ground is inactive');
    return forSlots(ground);
  }
}

function assertOpenOnSome(ground: GroundForSlots, dates: IsoDate[]) {
  if (!dates.some((date) => isOpenOn(ground, weekdayOf(date)))) throw groundClosed('The ground is closed on every day in that range');
}
