import { createHash } from 'node:crypto';
import { Injectable } from '@nestjs/common';
import { AppError } from '../common/app-error.js';
import {
  Prisma,
  type PlatformAuditAction,
} from '../generated/prisma/client.js';
import { PrismaService } from '../prisma/prisma.service.js';
import type { PlatformActor } from './platform-session.js';
import { withPlatformAvailability } from './platform-availability.js';
export type PlatformTx = Prisma.TransactionClient;
export interface PlatformCommand {
  requestId: string;
  action: PlatformAuditAction;
  payload: unknown;
}
export interface PlatformCommandResult {
  targetId: string;
  tenantId?: string;
  details?: Prisma.InputJsonObject;
}
export async function requirePlatformActor(
  tx: PlatformTx,
  actor: PlatformActor,
) {
  const grant = await tx.platformGrant.findUnique({
    where: { userId: actor.userId },
    select: {
      id: true,
      isActive: true,
      tokenVersion: true,
      user: { select: { isActive: true, tokenVersion: true } },
    },
  });
  if (
    !grant?.isActive ||
    !grant.user.isActive ||
    grant.id !== actor.grantId ||
    grant.tokenVersion !== actor.grantVersion ||
    grant.user.tokenVersion !== actor.userVersion
  )
    throw new AppError(
      'Platform administrator access is required',
      403,
      'PLATFORM_ACCESS_DENIED',
    );
}
@Injectable()
export class PlatformCommands {
  constructor(private readonly db: PrismaService) {}
  run(
    actor: PlatformActor,
    command: PlatformCommand,
    work: (tx: PlatformTx) => Promise<PlatformCommandResult>,
  ) {
    const hash = createHash('sha256')
      .update(JSON.stringify(command.payload))
      .digest('hex');
    return withPlatformAvailability(async () => {
      for (let attempt = 0; ; attempt++) {
        try {
          return await this.execute(actor, command, hash, work);
        } catch (error) {
          const conflict =
            error instanceof Prisma.PrismaClientKnownRequestError &&
            ['P2002', 'P2034'].includes(error.code);
          if (conflict && attempt < 3) continue;
          if (conflict)
            throw new AppError(
              'These details conflict with an existing record. Refresh and try again.',
              409,
              'PLATFORM_CONFLICT',
            );
          throw error;
        }
      }
    });
  }
  private execute(
    actor: PlatformActor,
    command: PlatformCommand,
    hash: string,
    work: (tx: PlatformTx) => Promise<PlatformCommandResult>,
  ) {
    return this.db.$transaction(
      async (tx) => {
        await requirePlatformActor(tx, actor);
        const previous = await previousTarget(tx, actor, command, hash);
        if (previous) return previous;
        const result = await work(tx);
        await auditResult(tx, actor, command, hash, result);
        return result.targetId;
      },
      { isolationLevel: 'Serializable', maxWait: 10_000, timeout: 10_000 },
    );
  }
}

async function previousTarget(
  tx: PlatformTx,
  actor: PlatformActor,
  command: PlatformCommand,
  hash: string,
) {
  const previous = await tx.platformAuditEvent.findUnique({
    where: { requestId: command.requestId },
  });
  if (!previous) return null;
  if (
    previous.actorId !== actor.userId ||
    previous.action !== command.action ||
    previous.inputHash !== hash
  )
    throw new AppError(
      'This request was already used for a different action',
      409,
      'IDEMPOTENCY_CONFLICT',
    );
  return previous.targetId;
}
async function auditResult(
  tx: PlatformTx,
  actor: PlatformActor,
  command: PlatformCommand,
  hash: string,
  result: PlatformCommandResult,
) {
  await tx.platformAuditEvent.create({
    data: {
      requestId: command.requestId,
      actorId: actor.userId,
      action: command.action,
      inputHash: hash,
      targetId: result.targetId,
      tenantId: result.tenantId,
      details: result.details ?? {},
    },
  });
}
