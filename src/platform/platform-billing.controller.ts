import {
  Body,
  Controller,
  Get,
  HttpCode,
  Param,
  Post,
  Query,
  UseGuards,
} from '@nestjs/common';
import { ZodValidationPipe } from '../common/pipes/zod-validation.pipe.js';
import { IdParamSchema, type IdParam } from '../common/schemas.js';
import { CurrentPlatformActor, PlatformGuard } from './platform.guard.js';
import { PlatformOriginGuard } from './platform-origin.guard.js';
import type { PlatformActor } from './platform-session.js';
import { PlatformBillingReadService } from './platform-billing-read.service.js';
import { PlatformPlansService } from './platform-plans.service.js';
import { PlatformSubscriptionsService } from './platform-subscriptions.service.js';
import { PlatformReceiptsService } from './platform-receipts.service.js';
import {
  BillingListSchema,
  InvoiceListSchema,
  SubscriptionListSchema,
  CreatePlanSchema,
  CreateSubscriptionSchema,
  IssueRenewalSchema,
  CancelSubscriptionSchema,
  RecordReceiptSchema,
  type BillingList,
  type InvoiceList,
  type SubscriptionList,
  type CreatePlan,
  type CreateSubscription,
  type IssueRenewal,
  type CancelSubscription,
  type RecordReceipt,
} from './platform-billing.schemas.js';
@Controller('platform')
@UseGuards(PlatformGuard, PlatformOriginGuard)
export class PlatformBillingController {
  constructor(
    private readonly read: PlatformBillingReadService,
    private readonly plans: PlatformPlansService,
    private readonly subs: PlatformSubscriptionsService,
    private readonly receipts: PlatformReceiptsService,
  ) {}
  @Get('plans') listPlans(
    @Query(new ZodValidationPipe(BillingListSchema)) q: BillingList,
  ) {
    return this.read.plans(q);
  }
  @Post('plans') createPlan(
    @CurrentPlatformActor() actor: PlatformActor,
    @Body(new ZodValidationPipe(CreatePlanSchema)) input: CreatePlan,
  ) {
    return this.plans.create(actor, input);
  }
  @Get('subscriptions') subscriptions(
    @Query(new ZodValidationPipe(SubscriptionListSchema)) q: SubscriptionList,
  ) {
    return this.read.subscriptions(q);
  }
  @Get('subscriptions/:id') subscription(
    @Param(new ZodValidationPipe(IdParamSchema)) { id }: IdParam,
  ) {
    return this.read.subscription(id);
  }
  @Get('tenants/:id/billing') tenantBilling(
    @Param(new ZodValidationPipe(IdParamSchema)) { id }: IdParam,
  ) {
    return this.read.tenantBilling(id);
  }
  @Get('tenants/:id/activity') activity(
    @Param(new ZodValidationPipe(IdParamSchema)) { id }: IdParam,
    @Query(new ZodValidationPipe(BillingListSchema)) q: BillingList,
  ) {
    return this.read.activity(id, q);
  }
  @Post('tenants/:id/subscription') createSubscription(
    @CurrentPlatformActor() actor: PlatformActor,
    @Param(new ZodValidationPipe(IdParamSchema)) { id }: IdParam,
    @Body(new ZodValidationPipe(CreateSubscriptionSchema))
    input: CreateSubscription,
  ) {
    return this.subs.create(actor, id, input);
  }
  @Post('subscriptions/:id/renewal-invoice') renewal(
    @CurrentPlatformActor() actor: PlatformActor,
    @Param(new ZodValidationPipe(IdParamSchema)) { id }: IdParam,
    @Body(new ZodValidationPipe(IssueRenewalSchema)) input: IssueRenewal,
  ) {
    return this.subs.renew(actor, id, input);
  }
  @Post('subscriptions/:id/cancel') @HttpCode(200) cancel(
    @CurrentPlatformActor() actor: PlatformActor,
    @Param(new ZodValidationPipe(IdParamSchema)) { id }: IdParam,
    @Body(new ZodValidationPipe(CancelSubscriptionSchema))
    input: CancelSubscription,
  ) {
    return this.subs.cancel(actor, id, input);
  }
  @Get('invoices') invoices(
    @Query(new ZodValidationPipe(InvoiceListSchema)) q: InvoiceList,
  ) {
    return this.read.invoices(q);
  }
  @Get('invoices/:id') invoice(
    @Param(new ZodValidationPipe(IdParamSchema)) { id }: IdParam,
  ) {
    return this.read.invoice(id);
  }
  @Post('invoices/:id/record-payment') @HttpCode(200) receipt(
    @CurrentPlatformActor() actor: PlatformActor,
    @Param(new ZodValidationPipe(IdParamSchema)) { id }: IdParam,
    @Body(new ZodValidationPipe(RecordReceiptSchema)) input: RecordReceipt,
  ) {
    return this.receipts.record(actor, id, input);
  }
}
