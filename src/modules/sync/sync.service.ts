import { Injectable, Logger } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { Cron, CronExpression } from '@nestjs/schedule';
import { SyncLog, SyncStatus, SyncType } from '../../entities/sync-log.entity';
import { TimeOffRequest, RequestStatus } from '../../entities/time-off-request.entity';
import { BalanceService } from '../balance/balance.service';
import { HcmClientService } from './hcm-client.service';

@Injectable()
export class SyncService {
  private readonly logger = new Logger(SyncService.name);

  constructor(
    @InjectRepository(SyncLog)
    private readonly syncLogRepo: Repository<SyncLog>,
    @InjectRepository(TimeOffRequest)
    private readonly requestRepo: Repository<TimeOffRequest>,
    private readonly balanceService: BalanceService,
    private readonly hcmClient: HcmClientService,
  ) {}

  /**
   * Scheduled full batch reconciliation — runs every 6 hours.
   * Fetches ALL balances from HCM and updates our local records.
   * This is the safety net for any drift between systems.
   */
  @Cron(CronExpression.EVERY_6_HOURS)
  async scheduledBatchSync(): Promise<void> {
    this.logger.log('Starting scheduled batch sync from HCM');
    await this.runBatchSync();
  }

  /**
   * Manually trigger a full batch sync (e.g. via webhook or admin endpoint).
   */
  async runBatchSync(): Promise<SyncLog> {
    const log = this.syncLogRepo.create({
      syncType: SyncType.BATCH,
      syncStatus: SyncStatus.FAILED,
      recordsProcessed: 0,
      recordsUpdated: 0,
    });

    try {
      const balances = await this.hcmClient.batchFetchAllBalances();
      log.recordsProcessed = balances.length;

      let updated = 0;
      for (const b of balances) {
        try {
          await this.balanceService.updateFromHcm(
            b.employeeId,
            b.locationId,
            b.balance,
            b.version,
          );
          updated++;
        } catch (err) {
          this.logger.warn(
            `Failed to update balance for ${b.employeeId}/${b.locationId}: ${err.message}`,
          );
        }
      }

      log.recordsUpdated = updated;
      log.syncStatus =
        updated === balances.length ? SyncStatus.SUCCESS : SyncStatus.PARTIAL;

      this.logger.log(`Batch sync complete: ${updated}/${balances.length} updated`);
    } catch (err) {
      log.errorDetails = err.message;
      log.syncStatus = SyncStatus.FAILED;
      this.logger.error(`Batch sync failed: ${err.message}`);
    }

    return this.syncLogRepo.save(log);
  }

  /**
   * Receive a batch payload pushed by HCM (webhook / push model).
   * Called from the SyncController when HCM POSTs balance updates to us.
   */
  async receiveBatchPush(
    balances: Array<{ employeeId: string; locationId: string; balance: number; version?: string }>,
  ): Promise<SyncLog> {
    const log = this.syncLogRepo.create({
      syncType: SyncType.WEBHOOK,
      syncStatus: SyncStatus.FAILED,
      recordsProcessed: balances.length,
      recordsUpdated: 0,
    });

    let updated = 0;
    const errors: string[] = [];

    for (const b of balances) {
      try {
        await this.balanceService.updateFromHcm(
          b.employeeId,
          b.locationId,
          b.balance,
          b.version,
        );
        updated++;
      } catch (err) {
        errors.push(`${b.employeeId}/${b.locationId}: ${err.message}`);
      }
    }

    log.recordsUpdated = updated;
    log.syncStatus =
      updated === balances.length ? SyncStatus.SUCCESS : SyncStatus.PARTIAL;
    if (errors.length) {
      log.errorDetails = errors.join('; ');
    }

    return this.syncLogRepo.save(log);
  }

  /**
   * Realtime sync for a single employee/location pair.
   * Called proactively before displaying balance to an employee.
   */
  async syncSingleBalance(
    employeeId: string,
    locationId: string,
  ): Promise<SyncLog> {
    const log = this.syncLogRepo.create({
      syncType: SyncType.REALTIME,
      syncStatus: SyncStatus.FAILED,
      employeeId,
      locationId,
      recordsProcessed: 1,
      recordsUpdated: 0,
    });

    try {
      const hcmBalance = await this.hcmClient.getBalance(employeeId, locationId);
      if (!hcmBalance) {
        log.errorDetails = 'HCM returned null balance';
        return this.syncLogRepo.save(log);
      }

      await this.balanceService.updateFromHcm(
        employeeId,
        locationId,
        hcmBalance.balance,
        hcmBalance.version,
      );

      log.recordsUpdated = 1;
      log.syncStatus = SyncStatus.SUCCESS;
    } catch (err) {
      log.errorDetails = err.message;
    }

    return this.syncLogRepo.save(log);
  }

  /**
   * Reconcile APPROVED requests that are not yet HCM-confirmed.
   * This handles the case where HCM was down when a request was approved.
   * Runs every 15 minutes.
   */
  @Cron('0 */15 * * * *')
  async reconcileUnconfirmedApprovals(): Promise<void> {
    const unconfirmed = await this.requestRepo.find({
      where: { status: RequestStatus.APPROVED, hcmConfirmed: false },
    });

    if (unconfirmed.length === 0) return;

    this.logger.log(`Reconciling ${unconfirmed.length} unconfirmed HCM approvals`);

    for (const request of unconfirmed) {
      const idempotencyKey = `approve-${request.id}`;
      const result = await this.hcmClient.deductBalance(
        request.employeeId,
        request.locationId,
        request.daysRequested,
        idempotencyKey,
      );

      if (result.success) {
        request.hcmConfirmed = true;
        request.hcmTransactionId = result.transactionId;
        await this.requestRepo.save(request);
        await this.balanceService.recomputeAvailableBalance(
          request.employeeId,
          request.locationId,
        );
        this.logger.log(`Reconciled request ${request.id} with HCM`);
      } else if (result.errorCode === 'INSUFFICIENT_BALANCE') {
        // HCM has less balance than expected — auto-revert to REJECTED
        this.logger.warn(
          `HCM has insufficient balance for ${request.id} during reconciliation — reverting`,
        );
        request.status = RequestStatus.REJECTED;
        request.rejectionReason = `HCM reconciliation rejected: ${result.error}`;
        await this.requestRepo.save(request);
        await this.balanceService.recomputeAvailableBalance(
          request.employeeId,
          request.locationId,
        );
      } else {
        this.logger.warn(
          `HCM still unavailable for ${request.id}, will retry next cycle`,
        );
      }
    }
  }

  async getSyncLogs(limit = 50): Promise<SyncLog[]> {
    return this.syncLogRepo.find({
      order: { createdAt: 'DESC' },
      take: limit,
    });
  }
}
