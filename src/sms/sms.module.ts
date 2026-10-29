import { Module } from '@nestjs/common';
import { SmsVerifyService } from './sms-verify.service.js';

@Module({
  providers: [SmsVerifyService],
  exports: [SmsVerifyService],
})
export class SmsModule {}
