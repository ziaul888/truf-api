import { Injectable } from '@nestjs/common';
import { hashPassword } from '../auth/password.js';
import { AppError } from '../common/app-error.js';
import type { Paginated } from '../common/schemas.js';
import type { Prisma, User } from '../generated/prisma/client.js';
import { PrismaService } from '../prisma/prisma.service.js';
import { toUserDto, type UserDto } from './user.dto.js';
import type { CreateUserInput, ListUsersQuery, ResetPasswordInput, UpdateUserInput } from './users.schemas.js';

const emailTaken = () => new AppError('A user with this email already exists', 409, 'EMAIL_TAKEN');

/** Prisma's unique-constraint error — the email was taken between our check and the write. */
const isUniqueViolation = (err: unknown) => (err as { code?: string })?.code === 'P2002';

@Injectable()
export class UsersService {
  constructor(private readonly prisma: PrismaService) {}

  async list({ page, limit, search }: ListUsersQuery): Promise<Paginated<UserDto>> {
    const where: Prisma.UserWhereInput = search
      ? {
          OR: [
            { name: { contains: search, mode: 'insensitive' } },
            { email: { contains: search, mode: 'insensitive' } },
          ],
        }
      : {};
    const [users, total] = await this.prisma.$transaction([
      this.prisma.user.findMany({ where, orderBy: { createdAt: 'desc' }, skip: (page - 1) * limit, take: limit }),
      this.prisma.user.count({ where }),
    ]);
    return { data: users.map(toUserDto), total, page, limit };
  }

  async get(id: string): Promise<UserDto> {
    return toUserDto(await this.findOrThrow(id));
  }

  async create({ password, ...data }: CreateUserInput): Promise<UserDto> {
    await this.assertEmailFree(data.email);
    const passwordHash = await hashPassword(password);
    const user = await this.prisma.user.create({ data: { ...data, passwordHash } }).catch((err: unknown) => {
      throw isUniqueViolation(err) ? emailTaken() : err;
    });
    return toUserDto(user);
  }

  /**
   * Admins can't change their own role or deactivate themselves, so there is always at least
   * one active admin (the one making the change) and nobody locks themselves out by accident.
   */
  async update(actorId: string, id: string, input: UpdateUserInput): Promise<UserDto> {
    const user = await this.findOrThrow(id);
    const changesOwnAccess =
      (input.role !== undefined && input.role !== user.role) ||
      (input.isActive !== undefined && input.isActive !== user.isActive);
    if (id === actorId && changesOwnAccess) {
      throw new AppError("You can't change your own role or deactivate yourself", 400, 'CANNOT_CHANGE_OWN_ACCESS');
    }
    if (input.email && input.email !== user.email) await this.assertEmailFree(input.email);

    const updated = await this.prisma.user.update({ where: { id }, data: input }).catch((err: unknown) => {
      throw isUniqueViolation(err) ? emailTaken() : err;
    });
    return toUserDto(updated);
  }

  /** Sets a new password for someone who forgot theirs, and signs them out everywhere. */
  async resetPassword(id: string, { password }: ResetPasswordInput): Promise<UserDto> {
    await this.findOrThrow(id);
    const updated = await this.prisma.user.update({
      where: { id },
      data: { passwordHash: await hashPassword(password), tokenVersion: { increment: 1 } },
    });
    return toUserDto(updated);
  }

  private async findOrThrow(id: string): Promise<User> {
    const user = await this.prisma.user.findUnique({ where: { id } });
    if (!user) throw new AppError('User not found', 404, 'USER_NOT_FOUND');
    return user;
  }

  private async assertEmailFree(email: string): Promise<void> {
    if (await this.prisma.user.findUnique({ where: { email } })) throw emailTaken();
  }
}
