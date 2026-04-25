import { Test, TestingModule } from '@nestjs/testing';
import { getRepositoryToken } from '@nestjs/typeorm';
import { DataSource } from 'typeorm';
import { BalanceService } from '../../modules/balance/balance.service';
import { Balance } from '../../entities/balance.entity';
import { TimeOffRequest, RequestStatus } from '../../entities/time-off-request.entity';
import { NotFoundException } from '@nestjs/common';

const mockBalanceRepo = () => ({
  findOne: jest.fn(),
  find: jest.fn(),
  create: jest.fn(),
  save: jest.fn(),
});

const mockRequestRepo = () => ({
  find: jest.fn(),
  createQueryBuilder: jest.fn(),
});

const mockDataSource = () => ({
  transaction: jest.fn(),
});

describe('BalanceService', () => {
  let service: BalanceService;
  let balanceRepo: ReturnType<typeof mockBalanceRepo>;
  let dataSource: ReturnType<typeof mockDataSource>;

  beforeEach(async () => {
    const module: TestingModule = await Test.createTestingModule({
      providers: [
        BalanceService,
        { provide: getRepositoryToken(Balance), useFactory: mockBalanceRepo },
        { provide: getRepositoryToken(TimeOffRequest), useFactory: mockRequestRepo },
        { provide: DataSource, useFactory: mockDataSource },
      ],
    }).compile();

    service = module.get<BalanceService>(BalanceService);
    balanceRepo = module.get(getRepositoryToken(Balance));
    dataSource = module.get(DataSource);
  });

  describe('getBalance', () => {
    it('should return balance when found', async () => {
      const balance: Partial<Balance> = {
        employeeId: 'emp-001',
        locationId: 'loc-us',
        hcmBalance: 10,
        availableBalance: 8,
      };
      balanceRepo.findOne.mockResolvedValue(balance);

      const result = await service.getBalance('emp-001', 'loc-us');
      expect(result).toEqual(balance);
      expect(balanceRepo.findOne).toHaveBeenCalledWith({
        where: { employeeId: 'emp-001', locationId: 'loc-us' },
      });
    });

    it('should throw NotFoundException when balance not found', async () => {
      balanceRepo.findOne.mockResolvedValue(null);

      await expect(service.getBalance('emp-999', 'loc-us')).rejects.toThrow(
        NotFoundException,
      );
    });
  });

  describe('getOrCreateBalance', () => {
    it('should return existing balance if found', async () => {
      const existing: Partial<Balance> = { employeeId: 'emp-001', locationId: 'loc-us' };
      balanceRepo.findOne.mockResolvedValue(existing);

      const result = await service.getOrCreateBalance('emp-001', 'loc-us');
      expect(result).toEqual(existing);
      expect(balanceRepo.create).not.toHaveBeenCalled();
    });

    it('should create and save new balance if not found', async () => {
      const newBalance: Partial<Balance> = {
        employeeId: 'emp-new',
        locationId: 'loc-us',
        hcmBalance: 0,
        availableBalance: 0,
        usedBalance: 0,
        reservedBalance: 0,
      };
      balanceRepo.findOne.mockResolvedValue(null);
      balanceRepo.create.mockReturnValue(newBalance);
      balanceRepo.save.mockResolvedValue({ id: 'new-id', ...newBalance });

      const result = await service.getOrCreateBalance('emp-new', 'loc-us');
      expect(balanceRepo.create).toHaveBeenCalledWith(
        expect.objectContaining({ employeeId: 'emp-new', locationId: 'loc-us' }),
      );
      expect(balanceRepo.save).toHaveBeenCalled();
      expect(result.id).toBe('new-id');
    });
  });

  describe('hasSufficientBalance', () => {
    it('should return sufficient=true when available >= requested', async () => {
      balanceRepo.findOne.mockResolvedValue({
        availableBalance: 10,
        employeeId: 'emp-001',
        locationId: 'loc-us',
      });

      const result = await service.hasSufficientBalance('emp-001', 'loc-us', 5);
      expect(result).toEqual({ sufficient: true, available: 10 });
    });

    it('should return sufficient=false when available < requested', async () => {
      balanceRepo.findOne.mockResolvedValue({ availableBalance: 3 });

      const result = await service.hasSufficientBalance('emp-001', 'loc-us', 5);
      expect(result).toEqual({ sufficient: false, available: 3 });
    });

    it('should return sufficient=false when balance record does not exist', async () => {
      balanceRepo.findOne.mockResolvedValue(null);

      const result = await service.hasSufficientBalance('emp-999', 'loc-us', 1);
      expect(result).toEqual({ sufficient: false, available: 0 });
    });

    it('should return sufficient=false when available equals 0 and days requested > 0', async () => {
      balanceRepo.findOne.mockResolvedValue({ availableBalance: 0 });

      const result = await service.hasSufficientBalance('emp-001', 'loc-us', 1);
      expect(result.sufficient).toBe(false);
    });

    it('should return sufficient=true for exact balance match', async () => {
      balanceRepo.findOne.mockResolvedValue({ availableBalance: 5 });

      const result = await service.hasSufficientBalance('emp-001', 'loc-us', 5);
      expect(result.sufficient).toBe(true);
    });
  });

  describe('updateFromHcm', () => {
    it('should update hcmBalance and trigger recompute', async () => {
      const existing: Partial<Balance> = {
        id: 'bal-1',
        employeeId: 'emp-001',
        locationId: 'loc-us',
        hcmBalance: 10,
        availableBalance: 10,
      };

      // getOrCreateBalance path
      balanceRepo.findOne
        .mockResolvedValueOnce(existing) // getOrCreateBalance
        .mockResolvedValueOnce(existing); // recompute path

      balanceRepo.save.mockResolvedValue({ ...existing, hcmBalance: 15 });

      // Mock transaction for recomputeAvailableBalance
      dataSource.transaction.mockImplementation(async (cb) => {
        const manager = {
          findOne: jest.fn().mockResolvedValue({
            ...existing,
            hcmBalance: 15,
          }),
          createQueryBuilder: jest.fn().mockReturnValue({
            select: jest.fn().mockReturnThis(),
            where: jest.fn().mockReturnThis(),
            andWhere: jest.fn().mockReturnThis(),
            getRawOne: jest.fn().mockResolvedValue({ total: '0' }),
          }),
          save: jest.fn().mockResolvedValue({ ...existing, hcmBalance: 15, availableBalance: 15 }),
        };
        return cb(manager);
      });

      await service.updateFromHcm('emp-001', 'loc-us', 15, 'v2');

      expect(balanceRepo.save).toHaveBeenCalledWith(
        expect.objectContaining({ hcmBalance: 15 }),
      );
    });
  });

  describe('listBalances', () => {
    it('should return all balances when no employeeId provided', async () => {
      const list = [{ employeeId: 'emp-001' }, { employeeId: 'emp-002' }];
      balanceRepo.find.mockResolvedValue(list);

      const result = await service.listBalances();
      expect(result).toEqual(list);
      expect(balanceRepo.find).toHaveBeenCalledWith();
    });

    it('should filter by employeeId when provided', async () => {
      const list = [{ employeeId: 'emp-001', locationId: 'loc-us' }];
      balanceRepo.find.mockResolvedValue(list);

      const result = await service.listBalances('emp-001');
      expect(result).toEqual(list);
      expect(balanceRepo.find).toHaveBeenCalledWith({ where: { employeeId: 'emp-001' } });
    });
  });
});
