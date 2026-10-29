import type { User, UserRole } from '../generated/prisma/client.js';

/** A staff account as the admin dashboard sees it — never the password hash or token version. */
export interface UserDto {
  id: string;
  email: string;
  name: string;
  role: UserRole;
  isActive: boolean;
  createdAt: Date;
  updatedAt: Date;
}

export const toUserDto = ({ id, email, name, role, isActive, createdAt, updatedAt }: User): UserDto => ({
  id, email, name, role, isActive, createdAt, updatedAt,
});
