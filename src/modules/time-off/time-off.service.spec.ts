import { Test, TestingModule } from '@nestjs/testing';
import { getRepositoryToken } from '@nestjs/typeorm';
import { TimeOffService } from '../../modules/time-off/time-off.service';
import { TimeOffRequest, RequestStatus } from '../../entities/time-off-request.entity';
import { BalanceService } from '../../modules/balance/balance.service';
import { HcmClientService } from '../../modules/sync/hcm-client.service';
import { BadRequestException, ConflictException, NotFoundException } from '@nestjs/common';

const mockRequestRepo = () => ({
  findOne: jest.fn(),
  find: jest.fn(),
  create: jest.fn(),
  save: jest.fn(),
});

const mockBalanceService = () => ({
  hasSufficientBalance: jest.fn(),
  recomputeAvailableBalance: jest.fn(),
  updateFromHcm: jest.fn(),
  getBalance: jest.fn(),
});

const mockHcmClient = () => ({
  deductBalance: jest.fn(),
  creditBalance: jest.fn(),
  getBalance: jest.fn(),
});

describe('TimeOffService', () => {
  let service: TimeOffService;
  let requestRepo: ReturnType<typeof mockRequestRepo>;
  let balanceService: ReturnType<typeof mockBalanceService>;
  let hcmClient: ReturnType<typeof mockHcmClient>;

  const baseRequest: Partial<TimeOffRequest> = {
    id: 'req-001',
    employeeId: 'emp-001',
    locationId: 'loc-us',
    startDate: '2025-06-01',
    endDate: '2025-06-05',
    daysRequested: 5,
    status: RequestStatus.PENDING,
    hcmConfirmed: false,
  };

  beforeEach(async () => {
    const module: TestingModule = await Test.createTestingModule({
      providers: [
        TimeOffService,
        { provide: getRepositoryToken(TimeOffRequest), useFactory: mockRequestRepo },
        { provide: BalanceService, useFactory: mockBalanceService },
        { provide: HcmClientService, useFactory: mockHcmClient },
      ],
    }).compile();

    service = module.get<TimeOffService>(TimeOffService);
    requestRepo = module.get(getRepositoryToken(TimeOffRequest));
    balanceService = module.get(BalanceService);
    hcmClient = module.get(HcmClientService);
  });

  // ──────────────────────────────────────────────────────────────────────────
  // CREATE REQUEST
  // ──────────────────────────────────────────────────────────────────────────

  describe('createRequest', () => {
    const dto = {
      employeeId: 'emp-001',
      locationId: 'loc-us',
      startDate: '2025-06-01',
      endDate: '2025-06-05',
      daysRequested: 5,
    };

    it('should create a PENDING request when balance is sufficient', async () => {
      balanceService.hasSufficientBalance.mockResolvedValue({ sufficient: true, available: 10 });
      requestRepo.create.mockReturnValue({ ...dto, status: RequestStatus.PENDING });
      requestRepo.save.mockResolvedValue({ id: 'req-001', ...dto, status: RequestStatus.PENDING });
      balanceService.recomputeAvailableBalance.mockResolvedValue({});

      const result = await service.createRequest(dto);

      expect(result.status).toBe(RequestStatus.PENDING);
      expect(balanceService.hasSufficientBalance).toHaveBeenCalledWith('emp-001', 'loc-us', 5);
      expect(requestRepo.save).toHaveBeenCalled();
      expect(balanceService.recomputeAvailableBalance).toHaveBeenCalledWith('emp-001', 'loc-us');
    });

    it('should throw BadRequestException when balance is insufficient', async () => {
      balanceService.hasSufficientBalance.mockResolvedValue({ sufficient: false, available: 3 });

      await expect(service.createRequest(dto)).rejects.toThrow(BadRequestException);
      expect(requestRepo.save).not.toHaveBeenCalled();
    });

    it('should throw BadRequestException when endDate is before startDate', async () => {
      const invalidDto = { ...dto, startDate: '2025-06-10', endDate: '2025-06-05' };

      await expect(service.createRequest(invalidDto)).rejects.toThrow(BadRequestException);
    });

    it('should not call recomputeAvailableBalance if save fails', async () => {
      balanceService.hasSufficientBalance.mockResolvedValue({ sufficient: true, available: 10 });
      requestRepo.create.mockReturnValue(dto);
      requestRepo.save.mockRejectedValue(new Error('DB error'));

      await expect(service.createRequest(dto)).rejects.toThrow('DB error');
      expect(balanceService.recomputeAvailableBalance).not.toHaveBeenCalled();
    });

    it('should reserve balance immediately upon creation (optimistic reservation)', async () => {
      balanceService.hasSufficientBalance.mockResolvedValue({ sufficient: true, available: 10 });
      requestRepo.create.mockReturnValue({ ...dto, status: RequestStatus.PENDING });
      requestRepo.save.mockResolvedValue({ id: 'req-001', ...dto, status: RequestStatus.PENDING });
      balanceService.recomputeAvailableBalance.mockResolvedValue({});

      await service.createRequest(dto);

      // recompute is called to reflect the new reservation
      expect(balanceService.recomputeAvailableBalance).toHaveBeenCalledTimes(1);
    });
  });

  // ──────────────────────────────────────────────────────────────────────────
  // APPROVE REQUEST
  // ──────────────────────────────────────────────────────────────────────────

  describe('approveRequest', () => {
    const dto = { managerId: 'mgr-001' };

    it('should approve and mark hcmConfirmed=true when HCM deduction succeeds', async () => {
      requestRepo.findOne.mockResolvedValue({ ...baseRequest });
      hcmClient.deductBalance.mockResolvedValue({
        success: true,
        transactionId: 'txn-abc',
        remainingBalance: 5,
      });
      requestRepo.save.mockResolvedValue({
        ...baseRequest,
        status: RequestStatus.APPROVED,
        hcmConfirmed: true,
        hcmTransactionId: 'txn-abc',
      });
      balanceService.recomputeAvailableBalance.mockResolvedValue({});

      const result = await service.approveRequest('req-001', dto);

      expect(result.status).toBe(RequestStatus.APPROVED);
      expect(result.hcmConfirmed).toBe(true);
      expect(result.hcmTransactionId).toBe('txn-abc');
      expect(hcmClient.deductBalance).toHaveBeenCalledWith(
        'emp-001', 'loc-us', 5, 'approve-req-001',
      );
    });

    it('should approve with hcmConfirmed=false when HCM is unavailable', async () => {
      requestRepo.findOne.mockResolvedValue({ ...baseRequest });
      hcmClient.deductBalance.mockResolvedValue({
        success: false,
        error: 'Connection timeout',
        errorCode: 'NETWORK_ERROR',
      });
      requestRepo.save.mockResolvedValue({
        ...baseRequest,
        status: RequestStatus.APPROVED,
        hcmConfirmed: false,
      });
      balanceService.recomputeAvailableBalance.mockResolvedValue({});

      const result = await service.approveRequest('req-001', dto);

      expect(result.status).toBe(RequestStatus.APPROVED);
      expect(result.hcmConfirmed).toBe(false); // flagged for reconciliation
    });

    it('should auto-reject when HCM returns INSUFFICIENT_BALANCE', async () => {
      requestRepo.findOne.mockResolvedValue({ ...baseRequest });
      hcmClient.deductBalance.mockResolvedValue({
        success: false,
        errorCode: 'INSUFFICIENT_BALANCE',
        error: 'Only 2 days available',
      });
      requestRepo.save.mockResolvedValue({
        ...baseRequest,
        status: RequestStatus.REJECTED,
        rejectionReason: 'HCM rejected: Only 2 days available',
      });
      balanceService.recomputeAvailableBalance.mockResolvedValue({});
      hcmClient.getBalance.mockResolvedValue({ balance: 2, version: 'v3' });
      balanceService.updateFromHcm.mockResolvedValue({});

      const result = await service.approveRequest('req-001', dto);

      expect(result.status).toBe(RequestStatus.REJECTED);
      expect(result.rejectionReason).toContain('HCM rejected');
    });

    it('should throw ConflictException when request is not PENDING', async () => {
      requestRepo.findOne.mockResolvedValue({
        ...baseRequest,
        status: RequestStatus.APPROVED,
      });

      await expect(service.approveRequest('req-001', dto)).rejects.toThrow(ConflictException);
    });

    it('should throw NotFoundException when request does not exist', async () => {
      requestRepo.findOne.mockResolvedValue(null);

      await expect(service.approveRequest('req-999', dto)).rejects.toThrow(NotFoundException);
    });

    it('should use idempotency key based on request ID for HCM deduction', async () => {
      requestRepo.findOne.mockResolvedValue({ ...baseRequest });
      hcmClient.deductBalance.mockResolvedValue({ success: true, transactionId: 'txn-1' });
      requestRepo.save.mockResolvedValue({ ...baseRequest, status: RequestStatus.APPROVED });
      balanceService.recomputeAvailableBalance.mockResolvedValue({});

      await service.approveRequest('req-001', dto);

      expect(hcmClient.deductBalance).toHaveBeenCalledWith(
        expect.any(String), expect.any(String), expect.any(Number),
        'approve-req-001', // deterministic idempotency key
      );
    });
  });

  // ──────────────────────────────────────────────────────────────────────────
  // REJECT REQUEST
  // ──────────────────────────────────────────────────────────────────────────

  describe('rejectRequest', () => {
    const dto = { managerId: 'mgr-001', rejectionReason: 'Business need' };

    it('should reject a PENDING request and release balance', async () => {
      requestRepo.findOne.mockResolvedValue({ ...baseRequest });
      requestRepo.save.mockResolvedValue({
        ...baseRequest,
        status: RequestStatus.REJECTED,
        rejectionReason: 'Business need',
      });
      balanceService.recomputeAvailableBalance.mockResolvedValue({});

      const result = await service.rejectRequest('req-001', dto);

      expect(result.status).toBe(RequestStatus.REJECTED);
      expect(result.rejectionReason).toBe('Business need');
      expect(balanceService.recomputeAvailableBalance).toHaveBeenCalled();
      expect(hcmClient.deductBalance).not.toHaveBeenCalled();
    });

    it('should throw ConflictException for non-PENDING request', async () => {
      requestRepo.findOne.mockResolvedValue({
        ...baseRequest,
        status: RequestStatus.APPROVED,
      });

      await expect(service.rejectRequest('req-001', dto)).rejects.toThrow(ConflictException);
    });
  });

  // ──────────────────────────────────────────────────────────────────────────
  // CANCEL REQUEST
  // ──────────────────────────────────────────────────────────────────────────

  describe('cancelRequest', () => {
    it('should cancel a PENDING request without calling HCM', async () => {
      requestRepo.findOne.mockResolvedValue({ ...baseRequest, status: RequestStatus.PENDING });
      requestRepo.save.mockResolvedValue({ ...baseRequest, status: RequestStatus.CANCELLED });
      balanceService.recomputeAvailableBalance.mockResolvedValue({});

      const result = await service.cancelRequest('req-001');

      expect(result.status).toBe(RequestStatus.CANCELLED);
      expect(hcmClient.creditBalance).not.toHaveBeenCalled();
    });

    it('should credit HCM when cancelling an APPROVED + HCM-confirmed request', async () => {
      requestRepo.findOne.mockResolvedValue({
        ...baseRequest,
        status: RequestStatus.APPROVED,
        hcmConfirmed: true,
        hcmTransactionId: 'txn-abc',
      });
      hcmClient.creditBalance.mockResolvedValue({ success: true, transactionId: 'txn-refund' });
      requestRepo.save.mockResolvedValue({ ...baseRequest, status: RequestStatus.CANCELLED });
      balanceService.recomputeAvailableBalance.mockResolvedValue({});

      const result = await service.cancelRequest('req-001');

      expect(result.status).toBe(RequestStatus.CANCELLED);
      expect(hcmClient.creditBalance).toHaveBeenCalledWith(
        'emp-001', 'loc-us', 5, 'cancel-req-001',
      );
    });

    it('should still cancel locally even if HCM credit fails', async () => {
      requestRepo.findOne.mockResolvedValue({
        ...baseRequest,
        status: RequestStatus.APPROVED,
        hcmConfirmed: true,
      });
      hcmClient.creditBalance.mockResolvedValue({
        success: false,
        error: 'HCM unreachable',
        errorCode: 'NETWORK_ERROR',
      });
      requestRepo.save.mockResolvedValue({ ...baseRequest, status: RequestStatus.CANCELLED });
      balanceService.recomputeAvailableBalance.mockResolvedValue({});

      const result = await service.cancelRequest('req-001');
      // Local cancellation proceeds; sync job will reconcile with HCM
      expect(result.status).toBe(RequestStatus.CANCELLED);
    });

    it('should throw ConflictException when request is already CANCELLED', async () => {
      requestRepo.findOne.mockResolvedValue({
        ...baseRequest,
        status: RequestStatus.CANCELLED,
      });

      await expect(service.cancelRequest('req-001')).rejects.toThrow(ConflictException);
    });

    it('should throw ConflictException when request is REJECTED', async () => {
      requestRepo.findOne.mockResolvedValue({
        ...baseRequest,
        status: RequestStatus.REJECTED,
      });

      await expect(service.cancelRequest('req-001')).rejects.toThrow(ConflictException);
    });

    it('should not call HCM credit for APPROVED but NOT hcmConfirmed request', async () => {
      requestRepo.findOne.mockResolvedValue({
        ...baseRequest,
        status: RequestStatus.APPROVED,
        hcmConfirmed: false,
      });
      requestRepo.save.mockResolvedValue({ ...baseRequest, status: RequestStatus.CANCELLED });
      balanceService.recomputeAvailableBalance.mockResolvedValue({});

      await service.cancelRequest('req-001');

      expect(hcmClient.creditBalance).not.toHaveBeenCalled();
    });
  });

  // ──────────────────────────────────────────────────────────────────────────
  // LIST & GET
  // ──────────────────────────────────────────────────────────────────────────

  describe('listRequests', () => {
    it('should list all requests when no filter provided', async () => {
      const requests = [baseRequest, { ...baseRequest, id: 'req-002' }];
      requestRepo.find.mockResolvedValue(requests);

      const result = await service.listRequests();
      expect(result).toHaveLength(2);
      expect(requestRepo.find).toHaveBeenCalledWith({
        where: {},
        order: { createdAt: 'DESC' },
      });
    });

    it('should filter by employeeId', async () => {
      requestRepo.find.mockResolvedValue([baseRequest]);

      await service.listRequests('emp-001');

      expect(requestRepo.find).toHaveBeenCalledWith({
        where: { employeeId: 'emp-001' },
        order: { createdAt: 'DESC' },
      });
    });

    it('should filter by status', async () => {
      requestRepo.find.mockResolvedValue([]);

      await service.listRequests(undefined, RequestStatus.APPROVED);

      expect(requestRepo.find).toHaveBeenCalledWith({
        where: { status: RequestStatus.APPROVED },
        order: { createdAt: 'DESC' },
      });
    });
  });

  describe('getRequest', () => {
    it('should return request by ID', async () => {
      requestRepo.findOne.mockResolvedValue(baseRequest);

      const result = await service.getRequest('req-001');
      expect(result).toEqual(baseRequest);
    });

    it('should throw NotFoundException for missing request', async () => {
      requestRepo.findOne.mockResolvedValue(null);

      await expect(service.getRequest('req-999')).rejects.toThrow(NotFoundException);
    });
  });
});
