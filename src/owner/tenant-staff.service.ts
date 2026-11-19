import { Injectable } from '@nestjs/common';
import { hashPassword } from '../auth/password.js';
import { AppError } from '../common/app-error.js';
import type { Prisma } from '../generated/prisma/client.js';
import { PrismaService } from '../prisma/prisma.service.js';
import { toUserDto } from '../users/user.dto.js';
import type {
  CreateUserInput,
  ListUsersQuery,
  UpdateUserInput,
} from '../users/users.schemas.js';
import { requireTenantOperator } from './owner-access.js';
import type { OwnerSession, TenantOperator } from './owner-session.js';
import { ownerTransaction } from './owner-transaction.js';
import { assertTurfAdmin, requireVenue } from './owner-venue.js';

const staffNotFound = () =>
  new AppError('Staff account not found', 404, 'USER_NOT_FOUND');

function staffWhere(tenantId: string): Prisma.TenantMembershipWhereInput {
  return {
    tenantId,
    role: { in: ['admin', 'manager'] },
    user: {
      legacyStaffAccess: false,
      platformGrant: { is: null },
      tenantMemberships: { none: { tenantId: { not: tenantId } } },
    },
  };
}

type StaffMembership = Prisma.TenantMembershipGetPayload<{
  include: { user: true };
}>;

function staffDto({ user, role, isActive, updatedAt }: StaffMembership) {
  if (role === 'owner') throw staffNotFound();
  return toUserDto({
    ...user,
    role,
    isActive: isActive && user.isActive,
    updatedAt: updatedAt > user.updatedAt ? updatedAt : user.updatedAt,
  });
}

function assertStaffAccess(operator: TenantOperator) {
  assertTurfAdmin(operator);
  requireVenue(operator);
}

async function findStaff(
  db: Prisma.TransactionClient,
  tenantId: string,
  id: string,
) {
  const member = await db.tenantMembership.findFirst({
    where: { ...staffWhere(tenantId), userId: id },
    include: { user: true },
  });
  if (!member) throw staffNotFound();
  return member;
}

async function withEmailConflict<T>(work: Promise<T>) {
  try {
    return await work;
  } catch (error) {
    if ((error as { code?: string })?.code === 'P2002') {
      throw new AppError(
        'A user with this email already exists',
        409,
        'EMAIL_TAKEN',
      );
    }
    throw error;
  }
}

@Injectable()
export class TenantStaffService {
  constructor(private readonly db: PrismaService) {}

  async list(
    operator: TenantOperator,
    { page, limit, search }: ListUsersQuery,
  ) {
    assertStaffAccess(operator);
    const where: Prisma.TenantMembershipWhereInput = {
      ...staffWhere(operator.session.tid),
      ...(search && {
        AND: {
          user: {
            OR: [
              { name: { contains: search, mode: 'insensitive' } },
              { email: { contains: search, mode: 'insensitive' } },
            ],
          },
        },
      }),
    };
    const [rows, total] = await this.db.$transaction([
      this.db.tenantMembership.findMany({
        where,
        include: { user: true },
        orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
        skip: (page - 1) * limit,
        take: limit,
      }),
      this.db.tenantMembership.count({ where }),
    ]);
    return { data: rows.map(staffDto), total, page, limit };
  }

  async get(operator: TenantOperator, id: string) {
    assertStaffAccess(operator);
    return staffDto(await findStaff(this.db, operator.session.tid, id));
  }

  async create(
    operator: TenantOperator,
    { password, role, ...identity }: CreateUserInput,
  ) {
    assertStaffAccess(operator);
    const passwordHash = await hashPassword(password);
    return this.write(operator.session, async (tx) => {
      const user = await withEmailConflict(
        tx.user.create({
          data: {
            ...identity,
            passwordHash,
            role: 'manager',
            legacyStaffAccess: false,
          },
        }),
      );
      const member = await tx.tenantMembership.create({
        data: { tenantId: operator.session.tid, userId: user.id, role },
        include: { user: true },
      });
      return staffDto(member);
    });
  }

  update(
    session: OwnerSession,
    id: string,
    { role, isActive, ...identity }: UpdateUserInput,
  ) {
    return this.write(session, async (tx) => {
      const member = await findStaff(tx, session.tid, id);
      const changesAccess =
        (role !== undefined && role !== member.role) ||
        (isActive !== undefined && isActive !== member.isActive);
      if (id === session.sub && changesAccess) {
        throw new AppError(
          "You can't change your own access",
          400,
          'CANNOT_CHANGE_OWN_ACCESS',
        );
      }
      if (identity.email !== undefined || identity.name !== undefined) {
        await withEmailConflict(
          tx.user.update({ where: { id }, data: identity }),
        );
      }
      if (changesAccess) {
        await tx.tenantMembership.update({
          where: { id: member.id },
          data: { role, isActive, tokenVersion: { increment: 1 } },
        });
      }
      return staffDto(await findStaff(tx, session.tid, id));
    });
  }

  async resetPassword(operator: TenantOperator, id: string, password: string) {
    assertStaffAccess(operator);
    const { session } = operator;
    const passwordHash = await hashPassword(password);
    return this.write(session, async (tx) => {
      const member = await findStaff(tx, session.tid, id);
      const user = await tx.user.update({
        where: { id },
        data: { passwordHash, tokenVersion: { increment: 1 } },
      });
      return staffDto({ ...member, user });
    });
  }

  private write<T>(
    session: OwnerSession,
    work: (tx: Prisma.TransactionClient) => Promise<T>,
  ) {
    return ownerTransaction(this.db, async (tx) => {
      assertStaffAccess(await requireTenantOperator(tx, session));
      return work(tx);
    });
  }
}
