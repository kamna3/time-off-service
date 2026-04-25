import { Test, TestingModule } from '@nestjs/testing';
import { HcmClientService } from '../../modules/sync/hcm-client.service';
import axios from 'axios';

jest.mock('axios', () => {
  const mockAxios: any = {
    create: jest.fn(() => mockAxios),
    get: jest.fn(),
    post: jest.fn(),
  };
  return { default: mockAxios };
});

const mockedAxios = axios as any;

describe('HcmClientService', () => {
  let service: HcmClientService;

  beforeEach(async () => {
    jest.clearAllMocks();
    const module: TestingModule = await Test.createTestingModule({
      providers: [HcmClientService],
    }).compile();
    service = module.get<HcmClientService>(HcmClientService);
    // Wire the mocked instance into the service
    (service as any).client = mockedAxios;
  });

  describe('getBalance', () => {
    it('should return balance on success', async () => {
      mockedAxios.get.mockResolvedValue({
        data: { employeeId: 'emp-001', locationId: 'loc-us', balance: 10, version: 'v1' },
      });

      const result = await service.getBalance('emp-001', 'loc-us');
      expect(result).toEqual({ employeeId: 'emp-001', locationId: 'loc-us', balance: 10, version: 'v1' });
      expect(mockedAxios.get).toHaveBeenCalledWith('/balances/emp-001/loc-us');
    });

    it('should return null on network error', async () => {
      mockedAxios.get.mockRejectedValue(new Error('ECONNREFUSED'));

      const result = await service.getBalance('emp-001', 'loc-us');
      expect(result).toBeNull();
    });

    it('should return null on 404', async () => {
      mockedAxios.get.mockRejectedValue({ response: { status: 404 }, message: 'Not Found' });

      const result = await service.getBalance('emp-999', 'loc-us');
      expect(result).toBeNull();
    });
  });

  describe('deductBalance', () => {
    it('should return success result with transactionId', async () => {
      mockedAxios.post.mockResolvedValue({
        data: { transactionId: 'txn-001', remainingBalance: 5 },
      });

      const result = await service.deductBalance('emp-001', 'loc-us', 5, 'approve-req-001');

      expect(result.success).toBe(true);
      expect(result.transactionId).toBe('txn-001');
      expect(result.remainingBalance).toBe(5);
      expect(mockedAxios.post).toHaveBeenCalledWith('/balances/deduct', {
        employeeId: 'emp-001',
        locationId: 'loc-us',
        days: 5,
        idempotencyKey: 'approve-req-001',
      });
    });

    it('should return failure with INSUFFICIENT_BALANCE error code', async () => {
      mockedAxios.post.mockRejectedValue({
        response: { data: { code: 'INSUFFICIENT_BALANCE', message: 'Only 2 days available' } },
        message: 'Request failed with status code 422',
      });

      const result = await service.deductBalance('emp-001', 'loc-us', 10, 'approve-req-001');

      expect(result.success).toBe(false);
      expect(result.errorCode).toBe('INSUFFICIENT_BALANCE');
      expect(result.error).toContain('Only 2 days available');
    });

    it('should return failure with UNKNOWN_ERROR on network timeout', async () => {
      mockedAxios.post.mockRejectedValue({ message: 'timeout of 5000ms exceeded' });

      const result = await service.deductBalance('emp-001', 'loc-us', 3, 'approve-req-001');

      expect(result.success).toBe(false);
      expect(result.errorCode).toBe('UNKNOWN_ERROR');
    });
  });

  describe('creditBalance', () => {
    it('should return success result on credit', async () => {
      mockedAxios.post.mockResolvedValue({
        data: { transactionId: 'txn-refund-001', remainingBalance: 8 },
      });

      const result = await service.creditBalance('emp-001', 'loc-us', 3, 'cancel-req-001');

      expect(result.success).toBe(true);
      expect(result.transactionId).toBe('txn-refund-001');
      expect(mockedAxios.post).toHaveBeenCalledWith('/balances/credit', {
        employeeId: 'emp-001',
        locationId: 'loc-us',
        days: 3,
        idempotencyKey: 'cancel-req-001',
      });
    });

    it('should return failure on HCM error', async () => {
      mockedAxios.post.mockRejectedValue({
        response: { data: { code: 'SERVER_ERROR', message: 'Internal HCM error' } },
        message: 'Request failed with status code 500',
      });

      const result = await service.creditBalance('emp-001', 'loc-us', 3, 'cancel-req-001');

      expect(result.success).toBe(false);
      expect(result.errorCode).toBe('SERVER_ERROR');
    });
  });

  describe('batchFetchAllBalances', () => {
    it('should return all balances from batch endpoint', async () => {
      const balances = [
        { employeeId: 'emp-001', locationId: 'loc-us', balance: 10 },
        { employeeId: 'emp-002', locationId: 'loc-uk', balance: 20 },
      ];
      mockedAxios.get.mockResolvedValue({ data: { balances } });

      const result = await service.batchFetchAllBalances();

      expect(result).toHaveLength(2);
      expect(result[0].employeeId).toBe('emp-001');
      expect(mockedAxios.get).toHaveBeenCalledWith('/balances/batch');
    });

    it('should return empty array when balances field is missing', async () => {
      mockedAxios.get.mockResolvedValue({ data: {} });

      const result = await service.batchFetchAllBalances();
      expect(result).toEqual([]);
    });

    it('should throw on network error (batch is critical, not swallowed)', async () => {
      mockedAxios.get.mockRejectedValue(new Error('HCM batch unavailable'));

      await expect(service.batchFetchAllBalances()).rejects.toThrow('HCM batch unavailable');
    });
  });
});
