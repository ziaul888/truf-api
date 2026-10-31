import { once } from 'node:events';
import { Controller, Get, Query, Res, UseGuards } from '@nestjs/common';
import type { Response } from 'express';
import { AuthGuard } from '../auth/auth.guard.js';
import { ZodValidationPipe } from '../common/pipes/zod-validation.pipe.js';
import { ReportExportService } from './report-export.service.js';
import {
  ExportQuerySchema, ReportRangeSchema, ReportSeriesQuerySchema, type ExportQuery, type ReportRange, type ReportSeriesQuery,
} from './reports.schemas.js';
import { ReportsService } from './reports.service.js';

/** Reports pages and dashboard charts. Admin and manager, like the dashboard. */
@Controller('admin/reports')
@UseGuards(AuthGuard)
export class ReportsController {
  constructor(
    private readonly reports: ReportsService,
    private readonly exports: ReportExportService,
  ) {}

  @Get('summary')
  summary(@Query(new ZodValidationPipe(ReportRangeSchema)) q: ReportRange) {
    return this.reports.summary(q);
  }

  @Get('revenue')
  revenue(@Query(new ZodValidationPipe(ReportSeriesQuerySchema)) q: ReportSeriesQuery) {
    return this.reports.revenue(q);
  }

  @Get('grounds')
  grounds(@Query(new ZodValidationPipe(ReportRangeSchema)) q: ReportRange) {
    return this.reports.grounds(q);
  }

  @Get('bookings')
  bookings(@Query(new ZodValidationPipe(ReportSeriesQuerySchema)) q: ReportSeriesQuery) {
    return this.reports.bookings(q);
  }

  /**
   * A CSV download, streamed, outside the JSON envelope. The BOM makes Excel read ৳ and Bangla
   * names as UTF-8. Validation errors come back as JSON; a failure mid-download aborts the file.
   */
  @Get('export')
  async export(@Query(new ZodValidationPipe(ExportQuerySchema)) q: ExportQuery, @Res() res: Response) {
    const file = this.exports.open(q);
    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader('Content-Disposition', `attachment; filename="${file.filename}"`);
    res.write('\uFEFF');
    try {
      for await (const line of file.lines) {
        if (!res.write(line)) await once(res, 'drain');
      }
      res.end();
    } catch (err) {
      res.destroy(err instanceof Error ? err : new Error(String(err)));
    }
  }
}
