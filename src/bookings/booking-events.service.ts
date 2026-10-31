import { Injectable } from '@nestjs/common';
import type { Paginated } from '../common/schemas.js';
import type { BookingEventType, Prisma } from '../generated/prisma/client.js';
import { PrismaService } from '../prisma/prisma.service.js';
import { ABANDONED_CHECKOUT } from './booking-rules.js';
import type { ListBookingEventsQuery } from './bookings.schemas.js';

export interface ActivityDto {
  id: string;
  type: BookingEventType;
  detail: string | null;
  /** Null for automatic events (Stripe, jobs, portal checkouts). */
  user: { id: string; name: string } | null;
  booking: { id: string; bookingNumber: string; customerName: string; groundName: string };
  createdAt: Date;
}

/** "Recent activity": booking events across all bookings, newest first. */
@Injectable()
export class BookingEventsService {
  constructor(private readonly prisma: PrismaService) {}

  async list(q: ListBookingEventsQuery): Promise<Paginated<ActivityDto>> {
    const where: Prisma.BookingEventWhereInput = {
      ...(q.type && { type: { in: q.type } }),
      booking: { deletedAt: null, NOT: ABANDONED_CHECKOUT },
    };
    const [rows, total] = await this.prisma.$transaction([
      this.prisma.bookingEvent.findMany({
        where, orderBy: [{ createdAt: 'desc' }, { id: 'desc' }], skip: (q.page - 1) * q.limit, take: q.limit,
        include: {
          user: { select: { id: true, name: true } },
          booking: { select: { id: true, bookingNumber: true, contactName: true, ground: { select: { name: true } } } },
        },
      }),
      this.prisma.bookingEvent.count({ where }),
    ]);
    const data = rows.map((e) => ({
      id: e.id, type: e.type, detail: e.detail, user: e.user,
      booking: { id: e.booking.id, bookingNumber: e.booking.bookingNumber, customerName: e.booking.contactName, groundName: e.booking.ground.name },
      createdAt: e.createdAt,
    }));
    return { data, total, page: q.page, limit: q.limit };
  }
}
