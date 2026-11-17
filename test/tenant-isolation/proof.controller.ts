import {
  Body,
  Controller,
  Get,
  Param,
  Patch,
  Post,
  UseGuards,
} from '@nestjs/common';
import { z } from 'zod';
import { AuthGuard } from '../../src/auth/auth.guard.js';
import { ZodValidationPipe } from '../../src/common/pipes/zod-validation.pipe.js';
import {
  CurrentTenant,
  TenantGuard,
  TenantRoles,
} from '../../src/tenants/tenant.guard.js';
import type { TenantContext } from '../../src/tenants/tenant-access.js';
import { ProofOperations } from './proof-operations.js';

const reserveSchema = z.object({
  slotIds: z
    .array(z.uuid())
    .min(1)
    .max(4)
    .refine((ids) => new Set(ids).size === ids.length),
});
const groundParams = z.object({ tenantId: z.uuid(), groundId: z.uuid() });

/** Registered by the proof test module only. Never imported by AppModule. */
@Controller('tenants/:tenantId/proof')
@UseGuards(AuthGuard, TenantGuard)
export class ProofController {
  constructor(private readonly operations: ProofOperations) {}

  @Get('grounds')
  list(@CurrentTenant() scope: TenantContext) {
    // Deliberately omit a tenant predicate to verify the database backstop.
    return this.operations.run(scope.userId, scope.tenantId, (tx) =>
      tx.ground.findMany(),
    );
  }

  @Post('reservations')
  reserve(
    @CurrentTenant() scope: TenantContext,
    @Body(new ZodValidationPipe(reserveSchema))
    input: z.infer<typeof reserveSchema>,
  ) {
    return this.operations.reserve(scope.userId, scope.tenantId, input.slotIds);
  }

  @Patch('grounds/:groundId')
  @TenantRoles('owner')
  rename(
    @CurrentTenant() scope: TenantContext,
    @Param(new ZodValidationPipe(groundParams))
    params: z.infer<typeof groundParams>,
  ) {
    return this.operations.run(
      scope.userId,
      scope.tenantId,
      (tx) =>
        tx.ground.updateMany({
          where: { id: params.groundId },
          data: { name: 'Updated in proof' },
        }),
      ['owner'],
    );
  }
}
