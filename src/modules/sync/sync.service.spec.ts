import { Test, TestingModule } from '@nestjs/testing';
import { getRepositoryToken } from '@nestjs/typeorm';
import { SyncService } from '../../modules/sync/sync.service';
import { SyncLog, SyncStatus, SyncType } from '../../entities/sync-log.entity';
import { TimeOffRequest, RequestStatus } from '../../entities/time-off-request.entity';
import { BalanceService } from '../../modules/balance/balance.service';
import { HcmClientService } from '../../modules/sync/hcm-client.service';

const mockSyncLogRepo = () => ({
  create: jest.fn(),
  save: jest.fn(),
  find: jest.fn(),
});

const mockRequestRepo = () => ({
  find: jest.fn(),
  save: jest.fn(),
});

const mockBalanceService = () => ({
  updateFromHcm: jest.fn(),
  recomputeAvailableBalance: jest.fn(),
});

const mockHcmClient = () => ({
  batchFetchAllBalances: jest.fn(),
  getBalance: jest.fn(),
  deductBalance: jest.fn(),
});

describe('SyncService', () => {
  let service: SyncService;
  let syncLogRepo: ReturnType<typeof mockSyncLogRepo>;
  let requestRepo: ReturnType<typeof mockRequestRepo>;
  let balanceService: ReturnType<typeof mockBalanceService>;
  let hcmClient: ReturnType<typeof mockHcmClient>;

  beforeEach(async () => {
    const module: TestingModule = await Test.createTestingModule({
      providers: [
        SyncService,
        { provide: getRepositoryToken(SyncLog), useFactory: mockSyncLogRepo },
        { provide: getRepositoryToken(TimeOffRequest), useFactory: mockRequestRepo },
        { provide: BalanceService, useFactory: mockBalanceService },
        { provide: HcmClientService, useFactory: mockHcmClient },
      ],
    }).compile();

    service = module.get<SyncService>(SyncService);
    syncLogRepo = module.get(getRepositoryToken(SyncLog));
    requestRepo = module.get(getRepositoryToken(TimeOffRequest));
    balanceService = module.get(BalanceService);
    hcmClient = module.get(HcmClientService);

    syncLogRepo.create.mockImplementation((data) => ({ ...data }));
    syncLogRepo.save.mockImplementation(async (log) => ({ id: 'log-1', ...log }));
  });

  // ──────────────────────────────────────────────────────────────────────────
  // BATCH SYNC
  // ──────────────────────────────────────────────────────────────────────────

  describe('runBatchSync', () => {
    it('should sync all balances and mark SUCCESS when all succeed', async () => {
      const balances = [
        { employeeId: 'emp-001', locationId: 'loc-us', balance: 10, version: 'v1' },
        { employeeId: 'emp-002', locationId: 'loc-us', balance: 5, version: 'v1' },
      ];
      hcmClient.batchFetchAllBalances.mockResolvedValue(balances);
      balanceService.updateFromHcm.mockResolvedValue({});

      const log = await service.runBatchSync();

      expect(hcmClient.batchFetchAllBalances).toHaveBeenCalled();
      expect(balanceService.updateFromHcm).toHaveBeenCalledTimes(2);
      expect(log.syncStatus).toBe(SyncStatus.SUCCESS);
      expect(log.recordsProcessed).toBe(2);
      expect(log.recordsUpdated).toBe(2);
    });

    it('should mark PARTIAL when some updates fail', async () => {
      const balances = [
        { employeeId: 'emp-001', locationId: 'loc-us', balance: 10 },
        { employeeId: 'emp-002', locationId: 'loc-us', balance: 5 },
      ];
      hcmClient.batchFetchAllBalances.mockResolvedValue(balances);
      balanceService.updateFromHcm
        .mockResolvedValueOnce({}) // first succeeds
        .mockRejectedValueOnce(new Error('DB lock')); // second fails

      const log = await service.runBatchSync();

      expect(log.syncStatus).toBe(SyncStatus.PARTIAL);
      expect(log.recordsUpdated).toBe(1);
    });

    it('should mark FAILED when HCM batch endpoint throws', async () => {
      hcmClient.batchFetchAllBalances.mockRejectedValue(new Error('HCM unavailable'));

      const log = await service.runBatchSync();

      expect(log.syncStatus).toBe(SyncStatus.FAILED);
      expect(log.errorDetails).toContain('HCM unavailable');
    });

    it('should handle empty batch response gracefully', async () => {
      hcmClient.batchFetchAllBalances.mockResolvedValue([]);

      const log = await service.runBatchSync();

      expect(log.syncStatus).toBe(SyncStatus.SUCCESS);
      expect(log.recordsProcessed).toBe(0);
      expect(log.recordsUpdated).toBe(0);
    });
  });

  // ──────────────────────────────────────────────────────────────────────────
  // BATCH PUSH (WEBHOOK)
  // ──────────────────────────────────────────────────────────────────────────

  describe('receiveBatchPush', () => {
    it('should process pushed balances and log SUCCESS', async () => {
      const payload = [
        { employeeId: 'emp-001', locationId: 'loc-us', balance: 12 },
        { employeeId: 'emp-003', locationId: 'loc-uk', balance: 20 },
      ];
      balanceService.updateFromHcm.mockResolvedValue({});

      const log = await service.receiveBatchPush(payload);

      expect(log.syncType).toBe(SyncType.WEBHOOK);
      expect(log.syncStatus).toBe(SyncStatus.SUCCESS);
      expect(log.recordsUpdated).toBe(2);
    });

    it('should mark PARTIAL and capture errors when some fail', async () => {
      const payload = [
        { employeeId: 'emp-001', locationId: 'loc-us', balance: 12 },
        { employeeId: 'emp-bad', locationId: 'loc-us', balance: -1 },
      ];
      balanceService.updateFromHcm
        .mockResolvedValueOnce({})
        .mockRejectedValueOnce(new Error('Negative balance not allowed'));

      const log = await service.receiveBatchPush(payload);

      expect(log.syncStatus).toBe(SyncStatus.PARTIAL);
      expect(log.recordsUpdated).toBe(1);
      expect(log.errorDetails).toContain('Negative balance not allowed');
    });
  });

  // ──────────────────────────────────────────────────────────────────────────
  // REALTIME SYNC
  // ──────────────────────────────────────────────────────────────────────────

  describe('syncSingleBalance', () => {
    it('should update balance from HCM and log SUCCESS', async () => {
      hcmClient.getBalance.mockResolvedValue({
        employeeId: 'emp-001',
        locationId: 'loc-us',
        balance: 8,
        version: 'v2',
      });
      balanceService.updateFromHcm.mockResolvedValue({});

      const log = await service.syncSingleBalance('emp-001', 'loc-us');

      expect(log.syncType).toBe(SyncType.REALTIME);
      expect(log.syncStatus).toBe(SyncStatus.SUCCESS);
      expect(balanceService.updateFromHcm).toHaveBeenCalledWith(
        'emp-001', 'loc-us', 8, 'v2',
      );
    });

    it('should log FAILED when HCM returns null', async () => {
      hcmClient.getBalance.mockResolvedValue(null);

      const log = await service.syncSingleBalance('emp-001', 'loc-us');

      expect(log.syncStatus).toBe(SyncStatus.FAILED);
      expect(log.errorDetails).toContain('HCM returned null balance');
    });
  });

  // ──────────────────────────────────────────────────────────────────────────
  // RECONCILIATION JOB
  // ──────────────────────────────────────────────────────────────────────────

  describe('reconcileUnconfirmedApprovals', () => {
    it('should confirm requests that HCM accepts', async () => {
      const unconfirmed = [
        {
          id: 'req-001', employeeId: 'emp-001', locationId: 'loc-us',
          daysRequested: 3, status: RequestStatus.APPROVED, hcmConfirmed: false,
        },
      ];
      requestRepo.find.mockResolvedValue(unconfirmed);
      hcmClient.deductBalance.mockResolvedValue({
        success: true,
        transactionId: 'txn-late',
      });
      requestRepo.save.mockResolvedValue({});
      balanceService.recomputeAvailableBalance.mockResolvedValue({});

      await service.reconcileUnconfirmedApprovals();

      expect(requestRepo.save).toHaveBeenCalledWith(
        expect.objectContaining({ hcmConfirmed: true, hcmTransactionId: 'txn-late' }),
      );
    });

    it('should auto-reject when HCM has INSUFFICIENT_BALANCE during reconciliation', async () => {
      const unconfirmed = [
        {
          id: 'req-002', employeeId: 'emp-002', locationId: 'loc-us',
          daysRequested: 5, status: RequestStatus.APPROVED, hcmConfirmed: false,
        },
      ];
      requestRepo.find.mockResolvedValue(unconfirmed);
      hcmClient.deductBalance.mockResolvedValue({
        success: false,
        errorCode: 'INSUFFICIENT_BALANCE',
        error: 'Balance depleted',
      });
      requestRepo.save.mockResolvedValue({});
      balanceService.recomputeAvailableBalance.mockResolvedValue({});

      await service.reconcileUnconfirmedApprovals();

      expect(requestRepo.save).toHaveBeenCalledWith(
        expect.objectContaining({ status: RequestStatus.REJECTED }),
      );
    });

    it('should skip when HCM still unavailable (retry next cycle)', async () => {
      const unconfirmed = [
        {
          id: 'req-003', employeeId: 'emp-003', locationId: 'loc-uk',
          daysRequested: 2, status: RequestStatus.APPROVED, hcmConfirmed: false,
        },
      ];
      requestRepo.find.mockResolvedValue(unconfirmed);
      hcmClient.deductBalance.mockResolvedValue({
        success: false,
        errorCode: 'NETWORK_ERROR',
        error: 'Timeout',
      });

      await service.reconcileUnconfirmedApprovals();

      // Save should NOT be called — we leave it for next reconciliation cycle
      expect(requestRepo.save).not.toHaveBeenCalled();
    });

    it('should do nothing when no unconfirmed approvals exist', async () => {
      requestRepo.find.mockResolvedValue([]);

      await service.reconcileUnconfirmedApprovals();

      expect(hcmClient.deductBalance).not.toHaveBeenCalled();
    });
  });
});
