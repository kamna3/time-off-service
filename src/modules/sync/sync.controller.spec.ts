import { Test, TestingModule } from '@nestjs/testing';
import { SyncController } from '../../modules/sync/sync.controller';
import { SyncService } from '../../modules/sync/sync.service';
import { SyncStatus, SyncType } from '../../entities/sync-log.entity';

const mockSyncService = () => ({
  receiveBatchPush: jest.fn(),
  runBatchSync: jest.fn(),
  syncSingleBalance: jest.fn(),
  getSyncLogs: jest.fn(),
});

describe('SyncController', () => {
  let controller: SyncController;
  let service: ReturnType<typeof mockSyncService>;

  beforeEach(async () => {
    const module: TestingModule = await Test.createTestingModule({
      controllers: [SyncController],
      providers: [{ provide: SyncService, useFactory: mockSyncService }],
    }).compile();

    controller = module.get<SyncController>(SyncController);
    service = module.get(SyncService);
  });

  it('should delegate batch push to SyncService', async () => {
    const dto = { balances: [{ employeeId: 'emp-001', locationId: 'loc-us', balance: 10 }] };
    const logResult = { syncType: SyncType.WEBHOOK, syncStatus: SyncStatus.SUCCESS, recordsUpdated: 1 };
    service.receiveBatchPush.mockResolvedValue(logResult);

    const result = await controller.receiveBatch(dto);
    expect(service.receiveBatchPush).toHaveBeenCalledWith(dto.balances);
    expect(result.syncStatus).toBe(SyncStatus.SUCCESS);
  });

  it('should handle empty balances array in batch push', async () => {
    const dto = { balances: [] };
    service.receiveBatchPush.mockResolvedValue({ recordsProcessed: 0, syncStatus: SyncStatus.SUCCESS });
    await controller.receiveBatch(dto);
    expect(service.receiveBatchPush).toHaveBeenCalledWith([]);
  });

  it('should trigger a batch pull sync', async () => {
    service.runBatchSync.mockResolvedValue({ syncType: SyncType.BATCH, syncStatus: SyncStatus.SUCCESS });
    const result = await controller.triggerBatchSync();
    expect(service.runBatchSync).toHaveBeenCalled();
    expect(result.syncType).toBe(SyncType.BATCH);
  });

  it('should sync a single employee via realtime endpoint', async () => {
    service.syncSingleBalance.mockResolvedValue({ syncStatus: SyncStatus.SUCCESS });
    await controller.syncRealtime({ employeeId: 'emp-001', locationId: 'loc-us' });
    expect(service.syncSingleBalance).toHaveBeenCalledWith('emp-001', 'loc-us');
  });

  it('should retrieve sync logs with default limit', async () => {
    service.getSyncLogs.mockResolvedValue([{ id: 'log-1' }, { id: 'log-2' }]);
    const result = await controller.getLogs(undefined);
    expect(service.getSyncLogs).toHaveBeenCalledWith(50);
    expect(result).toHaveLength(2);
  });

  it('should retrieve sync logs with custom limit', async () => {
    service.getSyncLogs.mockResolvedValue([{ id: 'log-1' }]);
    await controller.getLogs(5);
    expect(service.getSyncLogs).toHaveBeenCalledWith(5);
  });
});
