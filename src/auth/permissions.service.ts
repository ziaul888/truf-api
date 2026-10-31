import { Injectable, RequestMethod } from '@nestjs/common';
import { GUARDS_METADATA, METHOD_METADATA, PATH_METADATA } from '@nestjs/common/constants.js';
import { DiscoveryService, MetadataScanner, Reflector } from '@nestjs/core';
import type { UserRole } from '../generated/prisma/client.js';
import { AuthGuard, ROLES_KEY } from './auth.guard.js';

export type Permissions = Record<UserRole, string[]>;

const ROLES: UserRole[] = ['admin', 'manager'];
const joinPath = (...parts: (string | undefined)[]) => `/${parts.filter(Boolean).join('/')}`.replace(/\/+/g, '/').replace(/(.)\/$/, '$1');

/**
 * Which staff routes each role may call, read from the controllers' own guard and `@Roles`
 * metadata, so the Access page can't drift from what the API enforces. Paths are under /api/v1.
 */
@Injectable()
export class PermissionsService {
  private cache?: Permissions;

  constructor(
    private readonly discovery: DiscoveryService,
    private readonly scanner: MetadataScanner,
    private readonly reflector: Reflector,
  ) {}

  list(): Permissions {
    this.cache ??= this.build();
    return this.cache;
  }

  private build(): Permissions {
    const result: Permissions = { admin: [], manager: [] };
    for (const { metatype } of this.discovery.getControllers()) {
      if (typeof metatype !== 'function') continue;
      const base = Reflect.getMetadata(PATH_METADATA, metatype) as string | undefined;
      const classGuards = (Reflect.getMetadata(GUARDS_METADATA, metatype) ?? []) as unknown[];
      const proto = metatype.prototype as Record<string, unknown>;
      for (const name of this.scanner.getAllMethodNames(proto)) {
        const handler = proto[name] as object;
        const path = Reflect.getMetadata(PATH_METADATA, handler) as string | undefined;
        if (path === undefined) continue;
        const guards = [...classGuards, ...((Reflect.getMetadata(GUARDS_METADATA, handler) ?? []) as unknown[])];
        if (!guards.includes(AuthGuard)) continue;
        const roles = this.reflector.getAllAndOverride<UserRole[] | undefined>(ROLES_KEY, [handler as never, metatype]);
        const route = `${RequestMethod[Reflect.getMetadata(METHOD_METADATA, handler) as number]} ${joinPath(base, path)}`;
        for (const role of ROLES) if (!roles || roles.includes(role)) result[role].push(route);
      }
    }
    for (const role of ROLES) result[role].sort();
    return result;
  }
}
