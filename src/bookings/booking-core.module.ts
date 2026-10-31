import { Module } from '@nestjs/common';
import { EmailModule } from '../email/email.module.js';
import { PaymentsModule } from '../payments/payments.module.js';
import { SettingsCoreModule } from '../settings/settings-core.module.js';
import { SlotSettingsModule } from '../slots/slot-settings.module.js';
import { BookingCancellationService } from './booking-cancellation.service.js';
import { BookingNotifier } from './booking-notifier.service.js';

/**
 * Cancellation (with refunds) and booking emails. Separate from BookingsModule so the slots
 * module can cancel a booking when staff block its slot, without a module cycle.
 */
@Module({
  imports: [PaymentsModule, EmailModule, SlotSettingsModule, SettingsCoreModule],
  providers: [BookingCancellationService, BookingNotifier],
  exports: [BookingCancellationService, BookingNotifier, PaymentsModule, EmailModule],
})
export class BookingCoreModule {}
