import { Injectable } from '@nestjs/common';
import { AppError } from '../common/app-error.js';
import type { Paginated } from '../common/schemas.js';
import type { Ground, Prisma } from '../generated/prisma/client.js';
import { PrismaService } from '../prisma/prisma.service.js';
import { SlotGeneratorService, type SlotSync } from '../slots/slot-generator.service.js';
import { peakRangesOf, toGroundDto, toPublicGroundDto, type GroundDto, type PublicGroundDto } from './ground.dto.js';
import { assertHours, assertPeakPricing, resolveDays, VISIBLE_GROUND as VISIBLE } from './ground-rules.js';
import type { AdminListGroundsQuery, CreateGroundInput, ListGroundsQuery, UpdateGroundInput } from './grounds.schemas.js';

/** Fields that change which slots a ground has, or what they cost. Editing any of them resyncs future free slots. */
const SCHEDULE_FIELDS = [
  'openingHour', 'closingHour', 'slotDurationMinutes', 'hourlyPrice', 'peakPrice', 'peakRanges',
  'availableDays', 'customDays', 'isActive',
] as const satisfies (keyof UpdateGroundInput)[];

const notFound = () => new AppError('Ground not found', 404, 'GROUND_NOT_FOUND');

@Injectable()
export class GroundsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly slots: SlotGeneratorService,
  ) {}

  async listPublic({ page, limit, ...filters }: ListGroundsQuery): Promise<Paginated<PublicGroundDto>> {
    const { rows, total } = await this.findPage({ ...filterWhere(filters), ...VISIBLE }, page, limit);
    return { data: rows.map(toPublicGroundDto), total, page, limit };
  }

  /** 404 for hidden grounds, as if they didn't exist. */
  async getPublic(id: string): Promise<PublicGroundDto> {
    const ground = await this.prisma.ground.findFirst({ where: { id, ...VISIBLE } });
    if (!ground) throw notFound();
    return toPublicGroundDto(ground);
  }

  async list({ page, limit, isActive, ...filters }: AdminListGroundsQuery): Promise<Paginated<GroundDto>> {
    const where: Prisma.GroundWhereInput = { ...filterWhere(filters), ...(isActive !== undefined && { isActive }) };
    const { rows, total } = await this.findPage(where, page, limit);
    return { data: rows.map(toGroundDto), total, page, limit };
  }

  async get(id: string): Promise<GroundDto> {
    return toGroundDto(await this.findOrThrow(id));
  }

  async create(input: CreateGroundInput): Promise<GroundDto> {
    assertPeakPricing(input);
    const data = { ...input, ...resolveDays(input.availableDays, input.customDays) };
    const ground = await this.prisma.ground.create({ data });
    await this.slots.fillWindow([ground.id]);
    return toGroundDto(ground);
  }

  /**
   * No delete: deactivate instead (`isActive: false`) so bookings keep their ground.
   * Schedule changes return `slotSync`: how many future free slots were replaced and how many booked/blocked ones kept.
   */
  async update(id: string, input: UpdateGroundInput): Promise<GroundDto & { slotSync?: SlotSync }> {
    const ground = await this.findOrThrow(id);
    const openingHour = input.openingHour ?? ground.openingHour;
    const closingHour = input.closingHour ?? ground.closingHour;
    assertHours(openingHour, closingHour);
    assertPeakPricing({
      openingHour,
      closingHour,
      peakPrice: input.peakPrice !== undefined ? input.peakPrice : ground.peakPrice,
      peakRanges: input.peakRanges ?? peakRangesOf(ground),
    });

    const data: Prisma.GroundUpdateInput = { ...input };
    if (input.availableDays !== undefined || input.customDays !== undefined) {
      Object.assign(data, resolveDays(input.availableDays ?? ground.availableDays, input.customDays ?? ground.customDays));
    }
    const updated = toGroundDto(await this.prisma.ground.update({ where: { id }, data }));
    if (!SCHEDULE_FIELDS.some((field) => input[field] !== undefined)) return updated;
    return { ...updated, slotSync: await this.slots.resync(id) };
  }

  private async findPage(where: Prisma.GroundWhereInput, page: number, limit: number) {
    const [rows, total] = await this.prisma.$transaction([
      this.prisma.ground.findMany({ where, orderBy: { name: 'asc' }, skip: (page - 1) * limit, take: limit }),
      this.prisma.ground.count({ where }),
    ]);
    return { rows, total };
  }

  private async findOrThrow(id: string): Promise<Ground> {
    const ground = await this.prisma.ground.findUnique({ where: { id } });
    if (!ground) throw notFound();
    return ground;
  }
}

function filterWhere({ search, sport, format, surface }: Omit<ListGroundsQuery, 'page' | 'limit'>): Prisma.GroundWhereInput {
  return {
    ...(search && { name: { contains: search, mode: 'insensitive' } }),
    ...(sport && { sport }),
    ...(format && { format }),
    ...(surface && { surface }),
  };
}
