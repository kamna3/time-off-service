import { Injectable, Logger, NotFoundException } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository, DataSource } from 'typeorm';
import { Balance } from '../../entities/balance.entity';
import { TimeOffRequest, RequestStatus } from '../../entities/time-off-request.entity';

@Injectable()
export class BalanceService {
  private readonly logger = new Logger(BalanceService.name);

  constructor(
    @InjectRepository(Balance)
    private readonly balanceRepo: Repository<Balance>,
    @InjectRepository(TimeOffRequest)
    private readonly requestRepo: Repository<TimeOffRequest>,
    private readonly dataSource: DataSource,
  ) {}

  async getBalance(employeeId: string, locationId: string): Promise<Balance> {
    const balance = await this.balanceRepo.findOne({
      where: { employeeId, locationId },
    });
    if (!balance) {
      throw new NotFoundException(
        `No balance record found for employee ${employeeId} at location ${locationId}`,
      );
    }
    return balance;
  }

  async getOrCreateBalance(
    employeeId: string,
    locationId: string,
  ): Promise<Balance> {
    let balance = await this.balanceRepo.findOne({
      where: { employeeId, locationId },
    });
    if (!balance) {
      balance = this.balanceRepo.create({
        employeeId,
        locationId,
        hcmBalance: 0,
        availableBalance: 0,
        usedBalance: 0,
        reservedBalance: 0,
      });
      balance = await this.balanceRepo.save(balance);
    }
    return balance;
  }

  /**
   * Recompute availableBalance from hcmBalance minus all pending/approved requests.
   * This is called after any state-changing operation to ensure consistency.
   */
  async recomputeAvailableBalance(
    employeeId: string,
    locationId: string,
  ): Promise<Balance> {
    return this.dataSource.transaction(async (manager) => {
      const balance = await manager.findOne(Balance, {
        where: { employeeId, locationId },
        lock: { mode: 'pessimistic_write' },
      });

      if (!balance) {
        throw new NotFoundException('Balance record not found');
      }

      // Sum up all PENDING requests (reserved but not yet confirmed by HCM)
      const pendingResult = await manager
        .createQueryBuilder(TimeOffRequest, 'r')
        .select('SUM(r.daysRequested)', 'total')
        .where('r.employeeId = :employeeId', { employeeId })
        .andWhere('r.locationId = :locationId', { locationId })
        .andWhere('r.status = :status', { status: RequestStatus.PENDING })
        .getRawOne();

      // Sum up all APPROVED but NOT yet HCM-confirmed requests
      const approvedPendingHcmResult = await manager
        .createQueryBuilder(TimeOffRequest, 'r')
        .select('SUM(r.daysRequested)', 'total')
        .where('r.employeeId = :employeeId', { employeeId })
        .andWhere('r.locationId = :locationId', { locationId })
        .andWhere('r.status = :status', { status: RequestStatus.APPROVED })
        .andWhere('r.hcmConfirmed = :confirmed', { confirmed: false })
        .getRawOne();

      // Sum up APPROVED + HCM-confirmed (used)
      const usedResult = await manager
        .createQueryBuilder(TimeOffRequest, 'r')
        .select('SUM(r.daysRequested)', 'total')
        .where('r.employeeId = :employeeId', { employeeId })
        .andWhere('r.locationId = :locationId', { locationId })
        .andWhere('r.status = :status', { status: RequestStatus.APPROVED })
        .andWhere('r.hcmConfirmed = :confirmed', { confirmed: true })
        .getRawOne();

      const reserved = parseFloat(pendingResult?.total || '0');
      const approvedPendingHcm = parseFloat(approvedPendingHcmResult?.total || '0');
      const used = parseFloat(usedResult?.total || '0');

      balance.reservedBalance = reserved + approvedPendingHcm;
      balance.usedBalance = used;
      balance.availableBalance = Math.max(
        0,
        balance.hcmBalance - reserved - approvedPendingHcm - used,
      );

      return manager.save(Balance, balance);
    });
  }

  /**
   * Update hcmBalance from an authoritative HCM sync.
   * Recomputes available balance automatically.
   */
  async updateFromHcm(
    employeeId: string,
    locationId: string,
    hcmBalance: number,
    hcmVersion?: string,
  ): Promise<Balance> {
    const balance = await this.getOrCreateBalance(employeeId, locationId);
    balance.hcmBalance = hcmBalance;
    balance.lastSyncedAt = new Date();
    if (hcmVersion) balance.hcmVersion = hcmVersion;
    await this.balanceRepo.save(balance);
    return this.recomputeAvailableBalance(employeeId, locationId);
  }

  /**
   * Check if an employee has sufficient available balance.
   * Defensive check - we always verify locally even if HCM will also check.
   */
  async hasSufficientBalance(
    employeeId: string,
    locationId: string,
    daysRequested: number,
  ): Promise<{ sufficient: boolean; available: number }> {
    let balance: Balance;
    try {
      balance = await this.getBalance(employeeId, locationId);
    } catch {
      return { sufficient: false, available: 0 };
    }
    return {
      sufficient: balance.availableBalance >= daysRequested,
      available: balance.availableBalance,
    };
  }

  async listBalances(employeeId?: string): Promise<Balance[]> {
    if (employeeId) {
      return this.balanceRepo.find({ where: { employeeId } });
    }
    return this.balanceRepo.find();
  }
}
