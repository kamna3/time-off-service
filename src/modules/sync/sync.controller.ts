import { Controller, Post, Body, Get, Query, HttpCode } from '@nestjs/common';
import { SyncService } from './sync.service';
import { BatchSyncDto } from '../../dtos/time-off.dto';

@Controller('sync')
export class SyncController {
  constructor(private readonly syncService: SyncService) {}

  /**
   * POST /api/v1/sync/batch
   * HCM pushes a full batch of balance updates to us.
   * Also usable as an admin trigger for manual reconciliation.
   */
  @Post('batch')
  @HttpCode(200)
  receiveBatch(@Body() dto: BatchSyncDto) {
    return this.syncService.receiveBatchPush(dto.balances || []);
  }

  /**
   * POST /api/v1/sync/trigger
   * Admin: trigger a pull-based full batch sync from HCM.
   */
  @Post('trigger')
  @HttpCode(200)
  triggerBatchSync() {
    return this.syncService.runBatchSync();
  }

  /**
   * POST /api/v1/sync/realtime
   * Realtime sync for a specific employee/location.
   */
  @Post('realtime')
  @HttpCode(200)
  syncRealtime(
    @Body() body: { employeeId: string; locationId: string },
  ) {
    return this.syncService.syncSingleBalance(body.employeeId, body.locationId);
  }

  /**
   * GET /api/v1/sync/logs
   * Retrieve recent sync logs for observability.
   */
  @Get('logs')
  getLogs(@Query('limit') limit?: number) {
    return this.syncService.getSyncLogs(limit ? Number(limit) : 50);
  }
}
