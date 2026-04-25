import { Test, TestingModule } from '@nestjs/testing';
import { BalanceController } from '../../modules/balance/balance.controller';
import { BalanceService } from '../../modules/balance/balance.service';

const mockBalanceService = () => ({
  listBalances: jest.fn(),
  getBalance: jest.fn(),
});

describe('BalanceController', () => {
  let controller: BalanceController;
  let service: ReturnType<typeof mockBalanceService>;

  beforeEach(async () => {
    const module: TestingModule = await Test.createTestingModule({
      controllers: [BalanceController],
      providers: [{ provide: BalanceService, useFactory: mockBalanceService }],
    }).compile();

    controller = module.get<BalanceController>(BalanceController);
    service = module.get(BalanceService);
  });

  it('should list all balances', async () => {
    service.listBalances.mockResolvedValue([{ employeeId: 'emp-001' }]);
    const result = await controller.listBalances();
    expect(service.listBalances).toHaveBeenCalledWith(undefined);
    expect(result).toHaveLength(1);
  });

  it('should filter balances by employeeId', async () => {
    service.listBalances.mockResolvedValue([]);
    await controller.listBalances('emp-001');
    expect(service.listBalances).toHaveBeenCalledWith('emp-001');
  });

  it('should get a single balance', async () => {
    service.getBalance.mockResolvedValue({ employeeId: 'emp-001', locationId: 'loc-us', hcmBalance: 10 });
    const result = await controller.getBalance('emp-001', 'loc-us');
    expect(service.getBalance).toHaveBeenCalledWith('emp-001', 'loc-us');
    expect(result.hcmBalance).toBe(10);
  });
});
