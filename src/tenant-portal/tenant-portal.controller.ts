import { Controller, Get, Header, Param, Query } from '@nestjs/common';
import { ZodValidationPipe } from '../common/pipes/zod-validation.pipe.js';
import { IdParamSchema, type IdParam } from '../common/schemas.js';
import { ListGroundsQuerySchema, type ListGroundsQuery } from '../grounds/grounds.schemas.js';
import { GroundsService } from '../grounds/grounds.service.js';
import { PublicClosuresQuerySchema, type PublicClosuresQuery } from '../slots/closures.schemas.js';
import { ClosuresService } from '../slots/closures.service.js';
import { PublicSlotsQuerySchema, type PublicSlotsQuery } from '../slots/slots.schemas.js';
import { SlotsService } from '../slots/slots.service.js';
import { TenantPortalService } from './tenant-portal.service.js';

@Controller('turfs')
export class TenantPortalController {
  constructor(
    private readonly portal: TenantPortalService,
    private readonly grounds: GroundsService,
    private readonly slots: SlotsService,
    private readonly closures: ClosuresService,
  ) {}

  @Get('default')
  @Header('Cache-Control', 'no-store')
  defaultPortal() {
    return this.portal.defaultPortal();
  }

  @Get(':slug/website')
  @Header('Cache-Control', 'no-store')
  website(@Param('slug') slug: string) {
    return this.portal.website(slug);
  }

  @Get(':slug/grounds')
  @Header('Cache-Control', 'no-store')
  listGrounds(
    @Param('slug') slug: string,
    @Query(new ZodValidationPipe(ListGroundsQuerySchema)) query: ListGroundsQuery,
  ) {
    return this.portal.run(slug, () => this.grounds.listPublic(query));
  }

  @Get(':slug/grounds/:id')
  @Header('Cache-Control', 'no-store')
  ground(
    @Param('slug') slug: string,
    @Param(new ZodValidationPipe(IdParamSchema)) { id }: IdParam,
  ) {
    return this.portal.run(slug, () => this.grounds.getPublic(id));
  }

  @Get(':slug/grounds/:id/slots')
  @Header('Cache-Control', 'no-store')
  availability(
    @Param('slug') slug: string,
    @Param(new ZodValidationPipe(IdParamSchema)) { id }: IdParam,
    @Query(new ZodValidationPipe(PublicSlotsQuerySchema)) query: PublicSlotsQuery,
  ) {
    return this.portal.run(slug, () => this.slots.listPublic(id, query));
  }

  @Get(':slug/grounds/:id/closures')
  closureDates(
    @Param('slug') slug: string,
    @Param(new ZodValidationPipe(IdParamSchema)) { id }: IdParam,
    @Query(new ZodValidationPipe(PublicClosuresQuerySchema)) query: PublicClosuresQuery,
  ) {
    return this.portal.run(slug, async () => {
      await this.grounds.getPublic(id);
      const closures = await this.closures.listPublic(query);
      return closures.flatMap(({ groundIds, ...closure }) =>
        groundIds.length === 0 ? [{ ...closure, groundIds }]
          : groundIds.includes(id) ? [{ ...closure, groundIds: [id] }] : [],
      );
    });
  }
}
